require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { runOnce, initStations, getLiveReadings } = require('./monitor');
const db = require('./db');
const { getLatestReadings, getTankHistory, getActiveStationsList, updateTankThreshold } = db;
const { requireAuth } = require('./auth');

const app = express();
const PORT = process.env.API_PORT || 3000;
const DEFAULT_STATION_ID = 7; // Victoria, la estación piloto — mantiene compatibilidad con llamadas sin ?stationId

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

// GET /stations -> estaciones activas (backend del selector de estación en el frontend)
app.get('/stations', (req, res) => {
  res.json(getActiveStationsList());
});

// GET /tanks?stationId= -> última lectura de cada tanque de la estación + % calculado
app.get('/tanks', async (req, res) => {
  const stationId = Number(req.query.stationId) || DEFAULT_STATION_ID;
  const readings = await getLatestReadings(stationId);
  res.json(readings.map(enrichReading));
});

// GET /tanks/live?stationId= -> consulta el Veeder-Root de la estación AHORA MISMO,
// sin pasar por comb_lecturas. Para debug/demo — le pega directo al equipo real en
// cada pedido, no usar como refresco de alta frecuencia en producción.
app.get('/tanks/live', async (req, res) => {
  const stationId = Number(req.query.stationId) || DEFAULT_STATION_ID;
  try {
    const readings = await getLiveReadings(stationId);
    res.json(readings.map(enrichReading));
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// PATCH /tanks/:id/threshold?stationId= -> actualiza el umbral de alerta (%) de un tanque.
// Body: { umbralAlertaPorcentaje: number }
app.patch('/tanks/:id/threshold', async (req, res) => {
  const stationId = Number(req.query.stationId) || DEFAULT_STATION_ID;
  const tankNumber = Number(req.params.id);
  const { umbralAlertaPorcentaje } = req.body;

  if (typeof umbralAlertaPorcentaje !== 'number' || Number.isNaN(umbralAlertaPorcentaje) || umbralAlertaPorcentaje < 0 || umbralAlertaPorcentaje > 100) {
    return res.status(400).json({ ok: false, error: 'umbralAlertaPorcentaje debe ser un número entre 0 y 100.' });
  }

  try {
    await updateTankThreshold(stationId, tankNumber, umbralAlertaPorcentaje);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// GET /tanks/:id/history?stationId=&limit= -> histórico de lecturas de un tanque de una estación
app.get('/tanks/:id/history', async (req, res) => {
  const stationId = Number(req.query.stationId) || DEFAULT_STATION_ID;
  const history = await getTankHistory(stationId, Number(req.params.id), Number(req.query.limit) || 100);
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

// POST /tanks/check-now?stationId= -> fuerza una consulta inmediata (todas las estaciones, o una sola)
app.post('/tanks/check-now', async (req, res) => {
  try {
    const stationId = req.query.stationId ? Number(req.query.stationId) : undefined;
    await runOnce(stationId);
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
