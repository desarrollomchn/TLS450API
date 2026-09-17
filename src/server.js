require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const swaggerUi = require('swagger-ui-express');

const { runOnce, initStations, getLiveReadings } = require('./monitor');
const db = require('./db');
const {
  getLatestReadings,
  getTankHistory,
  getAllActiveFuelStations,
  getComEstacionIdForEstacion,
  getControladorVenta,
  updateControladorVenta,
  getPumpConfig,
  updateTankThreshold,
} = db;
const voxClient = require('./voxClient');
const { requireAuth } = require('./auth');
const swaggerSpec = require('./swagger');

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

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Chequeo de vida del servicio
 *     description: Endpoint trivial de liveness, sin autenticación. No consulta base de datos ni equipos.
 *     security: []
 *     tags: [Estaciones]
 *     responses:
 *       200:
 *         description: El servicio está arriba.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 */
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Docs sin auth (mismo patrón que /health) — deben quedar registradas ANTES de
// app.use(requireAuth) para poder navegarse sin token.
app.get('/swagger.json', (req, res) => res.json(swaggerSpec));
app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use(requireAuth);

// GET /stations -> TODAS las estaciones activas (Veeder-Root y/o controlador de
// venta), backend del selector de estación en el frontend. El id es EstacionId
// (gen_estaciones.Id) — ya no comEstacionId, para poder listar también las
// estaciones que todavía no tienen Veeder-Root.
/**
 * @openapi
 * /stations:
 *   get:
 *     summary: Lista las estaciones activas
 *     description: Todas las estaciones activas con algún equipo monitoreado (Veeder-Root y/o controlador de venta). El `id` devuelto es siempre EstacionId (gen_estaciones.Id).
 *     tags: [Estaciones]
 *     responses:
 *       200:
 *         description: Listado de estaciones activas.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Station' }
 */
app.get('/stations', async (req, res) => {
  res.json(await getAllActiveFuelStations());
});

// GET /tanks?stationId= -> última lectura de cada tanque de la estación + % calculado
// (stationId acá es EstacionId, no comEstacionId — ver resolveComEstacionId).
/**
 * @openapi
 * /tanks:
 *   get:
 *     summary: Última lectura guardada de cada tanque de una estación
 *     description: Lee la última lectura guardada en base (comb_lecturas), NO consulta el Veeder-Root en vivo — ver /tanks/live para eso. Incluye el % calculado y tanques provisionales (sin lectura todavía) con los campos de lectura en null.
 *     tags: [Tanques]
 *     parameters:
 *       - in: query
 *         name: stationId
 *         schema: { type: integer }
 *         required: false
 *         description: EstacionId (gen_estaciones.Id). Si se omite, usa la estación piloto por defecto.
 *         example: 4
 *     responses:
 *       200:
 *         description: Lecturas de cada tanque de la estación (vacío si la estación no tiene Veeder-Root).
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/TankReading' }
 */
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
/**
 * @openapi
 * /tanks/live:
 *   get:
 *     summary: Lectura en vivo de cada tanque de una estación
 *     description: Consulta directa al equipo Veeder-Root de la estación (no pasa por comb_lecturas), cacheada por hasta 20s y compartida entre todos los viewers de la misma estación para no saturar el equipo con lecturas TCP concurrentes.
 *     tags: [Tanques]
 *     parameters:
 *       - in: query
 *         name: stationId
 *         schema: { type: integer }
 *         required: false
 *         description: EstacionId (gen_estaciones.Id). Si se omite, usa la estación piloto por defecto.
 *         example: 4
 *     responses:
 *       200:
 *         description: Lecturas en vivo de cada tanque de la estación (vacío si la estación no tiene Veeder-Root).
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/TankReading' }
 *       502:
 *         description: Falló la consulta al Veeder-Root.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
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
/**
 * @openapi
 * /tanks/{id}/threshold:
 *   patch:
 *     summary: Actualiza el umbral de alerta (%) de un tanque
 *     tags: [Tanques]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: TankNumber del Veeder-Root (idTanque).
 *         example: 2
 *       - in: query
 *         name: stationId
 *         schema: { type: integer }
 *         required: false
 *         description: EstacionId (gen_estaciones.Id). Si se omite, usa la estación piloto por defecto.
 *         example: 4
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [umbralAlertaPorcentaje]
 *             properties:
 *               umbralAlertaPorcentaje: { type: number, minimum: 0, maximum: 100, example: 20 }
 *     responses:
 *       200:
 *         description: Umbral actualizado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *       400:
 *         description: umbralAlertaPorcentaje inválido.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: La estación no tiene Veeder-Root, o el tanque no existe en esa estación.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
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
/**
 * @openapi
 * /tanks/{id}/history:
 *   get:
 *     summary: Histórico de lecturas de un tanque
 *     tags: [Tanques]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: TankNumber del Veeder-Root (idTanque).
 *         example: 2
 *       - in: query
 *         name: stationId
 *         schema: { type: integer }
 *         required: false
 *         description: EstacionId (gen_estaciones.Id). Si se omite, usa la estación piloto por defecto.
 *         example: 4
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *         required: false
 *         description: Cantidad máxima de lecturas a devolver, más recientes primero. Se recorta a un techo de 500.
 *         example: 100
 *     responses:
 *       200:
 *         description: Lecturas históricas del tanque, más recientes primero (vacío si la estación no tiene Veeder-Root).
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/TankHistoryEntry' }
 *       400:
 *         description: ':id no es un entero positivo.'
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
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

// GET /stations/:estacionId/pump-config -> productos y surtidores reales de la estación
// (comb_bombas/comb_bahias, sincronizados desde Business Central), para que el frontend
// arme los filtros de Dispensado sin asumir una cantidad fija de bahías ni una lista fija
// de productos — no todas las estaciones tienen 6 surtidores ni solo DIESEL/REGULAR/SUPER.
/**
 * @openapi
 * /stations/{estacionId}/pump-config:
 *   get:
 *     summary: Productos y surtidores reales de una estación
 *     description: Sincronizados desde Business Central (comb_bombas/comb_bahias) — no asume una cantidad fija de surtidores ni una lista fija de productos.
 *     tags: [Estaciones]
 *     parameters:
 *       - in: path
 *         name: estacionId
 *         required: true
 *         schema: { type: integer }
 *         description: EstacionId (gen_estaciones.Id).
 *         example: 4
 *     responses:
 *       200:
 *         description: Configuración de bombas de la estación (listas vacías si no tiene datos sincronizados todavía).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PumpConfig' }
 *       400:
 *         description: estacionId inválido.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
app.get('/stations/:estacionId/pump-config', async (req, res) => {
  const estacionId = Number(req.params.estacionId);
  if (Number.isNaN(estacionId)) {
    return res.status(400).json({ ok: false, error: 'estacionId inválido.' });
  }

  const config = await getPumpConfig(estacionId);
  res.json(config);
});

// PATCH /stations/:estacionId/controlador-venta -> corrige ip/usuario/password del
// controlador de venta (VOX/Fusion) ya registrado para esta estación. Los tres campos
// van SOLO en el body JSON, nunca en la URL — una query string queda expuesta en logs
// de acceso del servidor, de cualquier proxy en el medio, y en el historial del
// navegador; mismo motivo por el que password ya iba por body, ahora aplicado también
// a ip/usuario por consistencia. Cualquier campo omitido se deja como estaba. No crea
// una fila nueva (ver scripts/seedControladoresVenta.js para dar de alta un controlador
// en una estación que todavía no tiene uno).
/**
 * @openapi
 * /stations/{estacionId}/controlador-venta:
 *   patch:
 *     summary: Corrige ip/usuario/password del controlador de venta ya registrado
 *     description: >
 *       No crea una fila nueva — la estación ya tiene que tener un controlador de venta
 *       (VOX/Fusion) registrado. Cualquier campo omitido se deja como estaba. Nunca
 *       devuelve la contraseña, ni siquiera la que se acaba de guardar.
 *
 *       IMPORTANTE (seguridad): ip/usuario/password van SOLO en el body JSON, NUNCA
 *       como query param — una query string queda expuesta en logs de acceso del
 *       servidor, de cualquier proxy intermedio, y en el historial del navegador.
 *       Esto es una corrección deliberada: no volver a aceptar ninguno de estos tres
 *       campos por query string.
 *     tags: [Estaciones]
 *     parameters:
 *       - in: path
 *         name: estacionId
 *         required: true
 *         schema: { type: integer }
 *         description: EstacionId (gen_estaciones.Id).
 *         example: 4
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ip:
 *                 type: string
 *                 example: 192.168.1.50
 *               usuario:
 *                 type: string
 *                 example: admin
 *               password:
 *                 type: string
 *                 description: Contraseña del controlador de venta.
 *                 example: '********'
 *     responses:
 *       200:
 *         description: Controlador actualizado (nunca incluye la contraseña).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *       400:
 *         description: estacionId inválido, o no se mandó ninguno de ip/usuario/password.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: La estación no tiene un controlador de venta registrado para actualizar.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
app.patch('/stations/:estacionId/controlador-venta', async (req, res) => {
  const estacionId = Number(req.params.estacionId);
  if (Number.isNaN(estacionId)) {
    return res.status(400).json({ ok: false, error: 'estacionId inválido.' });
  }

  const { ip, usuario, password } = req.body ?? {};

  if (ip === undefined && usuario === undefined && password === undefined) {
    return res.status(400).json({ ok: false, error: 'Mandá al menos uno de: ip, usuario, password (todos en el body).' });
  }

  const updated = await updateControladorVenta(estacionId, { ip, usuario, password });
  if (!updated) {
    return res.status(404).json({ ok: false, error: 'Esa estación no tiene un controlador de venta registrado para actualizar.' });
  }

  // Nunca se devuelve la contraseña, ni siquiera la que se acaba de guardar.
  res.json({ ok: true });
});

// GET /stations/:estacionId/dispatches?from=&to=&productos=&surtidores=
// -> despachos de bomba de un controlador de venta (VOX por ahora; Fusion todavía no
// está implementado). from/to son ISO 8601. productos/surtidores son listas separadas
// por coma (ej. productos=SUPER,DIESEL&surtidores=1,3) — si se omiten, trae todos.
// Se devuelve el set completo de registros del rango en una sola respuesta; el
// frontend pagina del lado del cliente sobre ese set ya cargado.
/**
 * @openapi
 * /stations/{estacionId}/dispatches:
 *   get:
 *     summary: Reporte de despachos de bomba del controlador de venta de una estación
 *     description: >
 *       Solo soporta controladores VOX por ahora (Fusion todavía no está implementado).
 *       Devuelve el set completo de registros del rango en una sola respuesta; el
 *       frontend pagina del lado del cliente.
 *
 *       ADVERTENCIA DE LATENCIA: esta llamada es LENTA — en la práctica toma del orden
 *       de ~56 segundos contra un equipo VOX real, porque consulta en vivo un sistema
 *       legacy y no hay caché en el primer hit de cada combinación de filtros (los hits
 *       siguientes con los mismos filtros exactos sí quedan cacheados 5 minutos). Una
 *       respuesta tardía es esperable, no necesariamente un cuelgue.
 *     tags: [Despachos]
 *     parameters:
 *       - in: path
 *         name: estacionId
 *         required: true
 *         schema: { type: integer }
 *         description: EstacionId (gen_estaciones.Id).
 *         example: 4
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string, format: date-time }
 *         description: Fecha/hora de inicio del rango, ISO 8601.
 *         example: '2026-09-15T00:00:00.000Z'
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string, format: date-time }
 *         description: Fecha/hora de fin del rango, ISO 8601. Debe ser posterior o igual a `from`.
 *         example: '2026-09-16T00:00:00.000Z'
 *       - in: query
 *         name: productos
 *         required: false
 *         schema: { type: string }
 *         description: Lista de productos separados por coma. Si se omite, trae todos.
 *         example: 'SUPER,DIESEL'
 *       - in: query
 *         name: surtidores
 *         required: false
 *         schema: { type: string }
 *         description: Lista de números de surtidor separados por coma. Si se omite, trae todos.
 *         example: '1,3'
 *     responses:
 *       200:
 *         description: Reporte de despachos del rango.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/DispatchesResponse' }
 *       400:
 *         description: estacionId inválido, o from/to inválidos/fuera de orden.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: La estación no tiene controlador de venta registrado.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       501:
 *         description: El sistema registrado no es VOX (Fusion todavía no soportado).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       502:
 *         description: Falló la consulta al controlador VOX.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
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

  try {
    const report = await getCachedDispatchReport(estacionId, credenciales, from, to, { productos, surtidores });

    res.json({
      records: report.records,
      totales: report.totals,
      ventasSinControl: report.ventasSinControl,
      cantidadDespachos: report.cantidadDespachos,
      totalRegistros: report.records.length,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /tanks/check-now?stationId= -> fuerza una consulta inmediata (todas las estaciones, o una sola)
/**
 * @openapi
 * /tanks/check-now:
 *   post:
 *     summary: Fuerza una consulta inmediata al Veeder-Root
 *     description: Consulta todas las estaciones si se omite stationId, o solo una si se especifica. No espera al próximo ciclo del cron de monitoreo.
 *     tags: [Tanques]
 *     parameters:
 *       - in: query
 *         name: stationId
 *         schema: { type: integer }
 *         required: false
 *         description: EstacionId (gen_estaciones.Id). Si se omite, consulta todas las estaciones activas.
 *         example: 4
 *     responses:
 *       200:
 *         description: Consulta ejecutada.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 message: { type: string, example: Consulta ejecutada }
 *       404:
 *         description: La estación no tiene Veeder-Root.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       500:
 *         description: Error ejecutando la consulta.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
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
