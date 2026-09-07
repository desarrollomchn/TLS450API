require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { runOnce, initStations, getLiveReadings } = require('./monitor');
const db = require('./db');
const {
  getLatestReadings,
  getTankHistory,
  getAllActiveFuelStations,
  getComEstacionIdForEstacion,
  getControladorVenta,
  updateTankThreshold,
} = db;
const voxClient = require('./voxClient');
const { requireAuth } = require('./auth');

const app = express();
const PORT = process.env.API_PORT || 3000;
// EstacionId (gen_estaciones.Id) de TEXACO Victoria, la estación piloto — mantiene
// compatibilidad con llamadas sin ?stationId. Antes de este cambio esta constante
// era comEstacionId (comb_estaciones.Id) = 7 para la misma estación; el id público
// que usa toda la API ahora es EstacionId, no comEstacionId.
const DEFAULT_STATION_ID = 4;

/**
 * Traduce el EstacionId recibido en la query (?stationId=) al comEstacionId real
 * que usan las tablas de tanques (comb_tanques/comb_lecturas/comb_alertas). undefined
 * si esa estación no tiene Veeder-Root — caso válido, no un error.
 */
async function resolveComEstacionId(req) {
  const estacionId = Number(req.query.stationId) || DEFAULT_STATION_ID;
  return getComEstacionIdForEstacion(estacionId);
}

// Misma forma de respuesta para /tanks (última lectura guardada) y /tanks/live
// (consulta directa al equipo) — el frontend no necesita distinguirlas.
function enrichReading(r) {
  // r.volume_gallons es null para un tanque provisional (nunca poleado): sin este
  // chequeo, `null / capacidad` da 0 en JS, no null, y mostraría "0%" en vez de
  // "sin datos" — una lectura real de tanque vacío se vería idéntica a "nunca conectó".
  const percent = r.capacity_gallons && r.volume_gallons != null ? (r.volume_gallons / r.capacity_gallons) * 100 : null;
  return {
    idTanque: r.tank_id,
    nombre: r.name || r.product,
    volumenGalones: r.volume_gallons,
    capacidadGalones: r.capacity_gallons || null,
    porcentaje: percent !== null ? Number(percent.toFixed(1)) : null,
    umbralAlertaPorcentaje: r.low_level_percent ?? null,
    temperaturaF: r.temperature_f,
    aguaPulgadas: r.water_inches,
    ultimaActualizacion: r.created_at,
  };
}

// TLS450FE le pega a esta API directo desde el navegador (sin proxy, como el resto
// de las apps de Montecristo) — sin esto, todas las llamadas fallan por CORS.
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5100').split(',');
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(requireAuth);

// GET /stations -> TODAS las estaciones activas (Veeder-Root y/o controlador de
// venta), backend del selector de estación en el frontend. El id es EstacionId
// (gen_estaciones.Id) — ya no comEstacionId, para poder listar también las
// estaciones que todavía no tienen Veeder-Root.
app.get('/stations', async (req, res) => {
  res.json(await getAllActiveFuelStations());
});

// GET /tanks?stationId= -> última lectura de cada tanque de la estación + % calculado
// (stationId acá es EstacionId, no comEstacionId — ver resolveComEstacionId).
app.get('/tanks', async (req, res) => {
  const comEstacionId = await resolveComEstacionId(req);
  if (!comEstacionId) return res.json([]); // estación válida, sin Veeder-Root: no tiene tanques.
  const readings = await getLatestReadings(comEstacionId);
  res.json(readings.map(enrichReading));
});

// Cache corto de las lecturas EN VIVO, compartido por estación. El frontend pollea
// /tanks/live cada 10s (LIVE_REFRESH_MS en useTanks.ts) — sin esto, cada empleado que
// tenga la pantalla de Tanques abierta para la misma estación dispara su propia
// conexión TCP nueva contra el Veeder-Root real (ver _sendCommand en veederClient.js:
// abre y destruye un socket por consulta). El TTL queda apenas por debajo de esos 10s
// para que N viewers de la misma estación compartan UNA sola consulta real al equipo
// por ciclo, en vez de N. Se cachea la PROMESA (no el resultado ya resuelto) para que
// también se compartan los pedidos que llegan mientras la consulta todavía está en
// vuelo, no solo los que llegan después de que terminó. Queda por encima de los
// 15s de LIVE_REFRESH_MS (useTanks.ts) con margen de sobra, no apenas por debajo:
// así un pedido que llegue con algo de jitter de red/reloj sigue cayendo dentro
// de la ventana del cache en vez de gatillar una consulta real de más.
const LIVE_READINGS_CACHE_TTL_MS = 20000;
const liveReadingsCache = new Map();

function getCachedLiveReadings(comEstacionId) {
  const cached = liveReadingsCache.get(comEstacionId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = getLiveReadings(comEstacionId);
  // Un fallo no debe quedar cacheado por todo el TTL — el próximo pedido (de
  // cualquier viewer) tiene que poder reintentar contra el equipo de una,
  // no esperar a que expire la ventana de una consulta que ya sabemos que falló.
  promise.catch(() => liveReadingsCache.delete(comEstacionId));
  liveReadingsCache.set(comEstacionId, { promise, expiresAt: Date.now() + LIVE_READINGS_CACHE_TTL_MS });
  return promise;
}

// GET /tanks/live?stationId= -> consulta el Veeder-Root de la estación (cacheado
// LIVE_READINGS_CACHE_TTL_MS ms, compartido entre todos los viewers de la misma
// estación), sin pasar por comb_lecturas.
app.get('/tanks/live', async (req, res) => {
  const comEstacionId = await resolveComEstacionId(req);
  if (!comEstacionId) return res.json([]);
  try {
    const readings = await getCachedLiveReadings(comEstacionId);
    res.json(readings.map(enrichReading));
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// PATCH /tanks/:id/threshold?stationId= -> actualiza el umbral de alerta (%) de un tanque.
// Body: { umbralAlertaPorcentaje: number }
app.patch('/tanks/:id/threshold', async (req, res) => {
  const comEstacionId = await resolveComEstacionId(req);
  const tankNumber = Number(req.params.id);
  const { umbralAlertaPorcentaje } = req.body;

  if (typeof umbralAlertaPorcentaje !== 'number' || Number.isNaN(umbralAlertaPorcentaje) || umbralAlertaPorcentaje < 0 || umbralAlertaPorcentaje > 100) {
    return res.status(400).json({ ok: false, error: 'umbralAlertaPorcentaje debe ser un número entre 0 y 100.' });
  }
  if (!comEstacionId) {
    return res.status(404).json({ ok: false, error: 'Esa estación no tiene Veeder-Root — no hay tanques que actualizar.' });
  }

  try {
    await updateTankThreshold(comEstacionId, tankNumber, umbralAlertaPorcentaje);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// GET /tanks/:id/history?stationId=&limit= -> histórico de lecturas de un tanque de una estación
app.get('/tanks/:id/history', async (req, res) => {
  const tankNumber = Number(req.params.id);
  if (!Number.isInteger(tankNumber) || tankNumber <= 0) {
    return res.status(400).json({ ok: false, error: ':id debe ser un entero positivo.' });
  }
  // Sin techo, ?limit= sin validar permitía un TOP contra comb_lecturas sin
  // límite práctico — esa tabla ya crece a millones de filas (ver README, sección
  // de retención). 500 alcanza de sobra para cualquier gráfico/exportación real.
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

  const comEstacionId = await resolveComEstacionId(req);
  if (!comEstacionId) return res.json([]);
  const history = await getTankHistory(comEstacionId, tankNumber, limit);
  const traducido = history.map((r) => ({
    id: r.id,
    idTanque: r.tank_id,
    producto: r.product,
    volumenGalones: r.volume_gallons,
    alturaPulgadas: r.height_inches,
    aguaPulgadas: r.water_inches,
    temperaturaF: r.temperature_f,
    fecha: r.created_at,
  }));
  res.json(traducido);
});

// Cache corto del reporte YA parseado, por combinación exacta de filtros. Sin esto,
// cada vez que el usuario da "Siguiente página" el backend volvería a pegarle
// completo a VOX (~20-30s) solo para servir una página distinta del mismo resultado
// que ya trajo segundos antes. 5 minutos alcanza para que alguien navegue todas las
// páginas de una búsqueda sin golpear el equipo de nuevo; cambiar cualquier filtro
// (incluida la fecha) es un cache miss y vuelve a consultar VOX, como corresponde.
const DISPATCH_CACHE_TTL_MS = 5 * 60 * 1000;
const dispatchReportCache = new Map();

function dispatchCacheKey(estacionId, from, to, productos, surtidores) {
  return JSON.stringify([estacionId, from.toISOString(), to.toISOString(), productos ?? null, surtidores ?? null]);
}

async function getCachedDispatchReport(estacionId, credenciales, from, to, filters) {
  const key = dispatchCacheKey(estacionId, from, to, filters.productos, filters.surtidores);
  const cached = dispatchReportCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.report;
  }

  const report = await voxClient.getDispatchReport(credenciales, from, to, filters);
  dispatchReportCache.set(key, { report, expiresAt: Date.now() + DISPATCH_CACHE_TTL_MS });
  return report;
}

// GET /stations/:estacionId/dispatches?from=&to=&productos=&surtidores=&page=&pageSize=
// -> despachos de bomba de un controlador de venta (VOX por ahora; Fusion todavía no
// está implementado). from/to son ISO 8601. productos/surtidores son listas separadas
// por coma (ej. productos=SUPER,DIESEL&surtidores=1,3) — si se omiten, trae todos.
// VOX no pagina del lado del servidor: pedimos el rango completo UNA vez y paginamos
// acá sobre el array ya parseado.
app.get('/stations/:estacionId/dispatches', async (req, res) => {
  const estacionId = Number(req.params.estacionId);
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);

  if (Number.isNaN(estacionId)) {
    return res.status(400).json({ ok: false, error: 'estacionId inválido.' });
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return res.status(400).json({ ok: false, error: 'from/to deben ser fechas ISO válidas, con from anterior o igual a to.' });
  }

  const credenciales = await getControladorVenta(estacionId);
  if (!credenciales) {
    return res.status(404).json({ ok: false, error: 'Esa estación no tiene controlador de venta registrado.' });
  }
  if (credenciales.sistema !== 'VOX') {
    return res.status(501).json({ ok: false, error: `Sistema '${credenciales.sistema}' todavía no está soportado (solo VOX por ahora).` });
  }

  const productos = req.query.productos ? String(req.query.productos).split(',') : undefined;
  const surtidores = req.query.surtidores ? String(req.query.surtidores).split(',').map(Number) : undefined;

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

  try {
    const report = await getCachedDispatchReport(estacionId, credenciales, from, to, { productos, surtidores });

    const start = (page - 1) * pageSize;
    const records = report.records.slice(start, start + pageSize);

    res.json({
      records,
      totales: report.totals,
      ventasSinControl: report.ventasSinControl,
      cantidadDespachos: report.cantidadDespachos,
      pagina: page,
      tamanoPagina: pageSize,
      totalRegistros: report.records.length,
      totalPaginas: Math.ceil(report.records.length / pageSize) || 1,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /tanks/check-now?stationId= -> fuerza una consulta inmediata (todas las estaciones, o una sola)
app.post('/tanks/check-now', async (req, res) => {
  try {
    let comEstacionId;
    if (req.query.stationId) {
      comEstacionId = await getComEstacionIdForEstacion(Number(req.query.stationId));
      if (!comEstacionId) {
        return res.status(404).json({ ok: false, error: 'Esa estación no tiene Veeder-Root — no hay nada que consultar.' });
      }
    }
    await runOnce(comEstacionId);
    res.json({ ok: true, message: 'Consulta ejecutada' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

initStations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API escuchando en http://localhost:${PORT}`);

      // Programa la consulta periódica a los Veeder-Root
      const monitorEnabled = process.env.MONITOR_ENABLED !== 'false';

      if (monitorEnabled) {
        // POLL_INTERVAL_SECONDS es para pruebas/debug (node-cron soporta un 6to campo de
        // segundos) — en producción usar POLL_INTERVAL_MINUTES, pollear cada 10 estaciones
        // reales cada pocos segundos satura los Veeder-Root sin necesidad.
        const intervalSec = Number(process.env.POLL_INTERVAL_SECONDS || 0);
        const cronExpr = intervalSec > 0
          ? `*/${intervalSec} * * * * *`
          : `*/${Number(process.env.POLL_INTERVAL_MINUTES || 10)} * * * *`;
        console.log(
          intervalSec > 0
            ? `Monitoreo programado cada ${intervalSec} segundo(s)`
            : `Monitoreo programado cada ${Number(process.env.POLL_INTERVAL_MINUTES || 10)} minuto(s)`
        );

        cron.schedule(cronExpr, () => {
          runOnce().catch((err) => console.error('Error en el ciclo de monitoreo:', err));
        });

        // Corre una vez al iniciar
        runOnce().catch((err) => console.error('Error en la consulta inicial:', err));
      } else {
        console.log('Monitoreo automático deshabilitado (MONITOR_ENABLED=false). /tanks/check-now sigue disponible manualmente.');
      }
    });
  })
  .catch((err) => {
    console.error('No se pudieron resolver las estaciones activas:', err.message);
    process.exit(1);
  });
