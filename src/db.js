const sql = require('mssql');
const { decrypt } = require('./crypto');

const config = {
  server: process.env.MSSQL_SERVER,
  database: process.env.MSSQL_DATABASE,
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    instanceName: process.env.MSSQL_INSTANCE,
    encrypt: process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
  },
};

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

// Umbral inicial SOLO para cuando se crea una fila de comb_tanques por primera vez
// (no hay valor previo que preservar). De ahí en más, el único umbral que existe es
// comb_tanques.LowLevelPercent — no hay variable de entorno que lo reemplace ni lo
// pise; monitor.js decide la alerta exclusivamente con ese valor por tanque.
const DEFAULT_LOW_LEVEL_PERCENT = 20;

// stationId (comb_estaciones.Id) -> Map<TankNumber, TanqueId>. Ahora hay una entrada
// por estación activa, en vez de un único mapa plano para todo el proceso.
const tanqueIdByStation = new Map();

// Estaciones activas resueltas en el último resolveActiveStations(); respalda GET /stations
// sin tener que volver a consultar la base en cada request.
let cachedStations = [];

/**
 * Resuelve las estaciones activas desde comb_estaciones/gen_estaciones.
 * Ya no se filtra por marca (antes Nombre LIKE 'TEXACO%'): ese filtro era solo un
 * guardarraíl temporal del rollout inicial (5 de 10 estaciones). comb_estaciones ya
 * solo contiene las estaciones que de verdad tienen un Veeder-Root funcionando
 * (confirmado contra "Controladores de venta EDS copemsa y Jade Masis.xlsx"), así
 * que Activo = 1 alcanza para cubrir las 10 sin volver a filtrar por marca.
 */
async function resolveActiveStations() {
  await poolConnect;

  const result = await pool.request().query(`
    SELECT ce.Id AS comEstacionId, ce.Host AS host, ge.Nombre AS nombre
    FROM comb_estaciones ce
    INNER JOIN gen_estaciones ge ON ge.Id = ce.EstacionId
    WHERE ce.Activo = 1
    ORDER BY ce.Id
  `);

  cachedStations = result.recordset.map((r) => ({
    comEstacionId: r.comEstacionId,
    host: r.host,
    name: r.nombre.replace(/^TEXACO\s*/i, '').trim(),
  }));

  return cachedStations;
}

function getActiveStationsList() {
  return cachedStations.map((s) => ({ id: s.comEstacionId, name: s.name }));
}

/**
 * TODAS las estaciones activas con algún equipo monitoreado (Veeder-Root y/o
 * controlador de venta VOX/Fusion/etc.) — a diferencia de resolveActiveStations(),
 * que es exclusivamente para el poller de Veeder-Root (monitor.js) y por eso solo
 * lista estaciones con comb_estaciones. Para el selector de estación del frontend:
 * una estación sin Veeder-Root pero con VOX/Fusion debe aparecer igual.
 *
 * El id devuelto es SIEMPRE EstacionId (gen_estaciones.Id) — es el único identificador
 * que existe para las estaciones sin Veeder-Root, así que es el que usa toda la API
 * pública desde este cambio en adelante (ver DEFAULT_STATION_ID en server.js).
 *
 * Excluye a propósito estaciones de gen_estaciones que no son gasolineras (oficinas,
 * hacienda, etc.) filtrando por "tiene al menos un equipo relevado" en vez de por
 * Activo=1 solo — gen_estaciones también tiene filas no relacionadas a combustible.
 */
async function getAllActiveFuelStations() {
  await poolConnect;
  const result = await pool.request().query(`
    SELECT
      ge.Id AS estacionId,
      ge.Nombre AS nombre,
      CASE WHEN ce.Id IS NOT NULL THEN 1 ELSE 0 END AS tieneVeederRoot,
      CASE WHEN cv.Id IS NOT NULL THEN 1 ELSE 0 END AS tieneControladorVenta
    FROM gen_estaciones ge
    LEFT JOIN comb_estaciones ce ON ce.EstacionId = ge.Id AND ce.Activo = 1
    LEFT JOIN comb_controladores_venta cv ON cv.EstacionId = ge.Id AND cv.Activo = 1
    WHERE ge.Activo = 1 AND (ce.Id IS NOT NULL OR cv.Id IS NOT NULL)
    ORDER BY ge.Orden
  `);

  return result.recordset.map((r) => ({
    id: r.estacionId,
    name: r.nombre.replace(/^TEXACO\s*/i, '').trim(),
    tieneVeederRoot: Boolean(r.tieneVeederRoot),
    tieneControladorVenta: Boolean(r.tieneControladorVenta),
  }));
}

/**
 * Resuelve comEstacionId (comb_estaciones.Id) a partir de EstacionId (gen_estaciones.Id).
 * Devuelve undefined si esa estación no tiene Veeder-Root — es un caso válido, no un
 * error: la estación existe, simplemente no tiene tanques que consultar.
 */
async function getComEstacionIdForEstacion(estacionId) {
  await poolConnect;
  const result = await pool
    .request()
    .input('estacionId', sql.Int, estacionId)
    .query('SELECT Id FROM comb_estaciones WHERE EstacionId = @estacionId AND Activo = 1');
  return result.recordset[0]?.Id;
}

function tanqueIdFor(stationId, tankNumber) {
  const map = tanqueIdByStation.get(stationId);
  return map ? map.get(tankNumber) : undefined;
}

/**
 * Capacidad por producto (galones) de una estación, editable en comb_capacidades sin redeploy.
 * Devuelve un Map<Producto, CapacidadGalones> (producto en mayúsculas, ej. 'DIESEL', también
 * 'KEROSENE' donde aplique — el lookup no restringe a una lista fija de productos).
 *
 * comb_capacidades ahora está keyed por EstacionId (gen_estaciones.Id), no por
 * comb_estaciones.Id: la capacidad es una propiedad de la estación física, independiente
 * de si ya tiene hardware Veeder-Root instalado. Como acá solo llamamos esto para estaciones
 * que sí están activamente monitoreadas (tienen fila en comb_estaciones), se resuelve con
 * un join extra vía EstacionId en vez de comparar directo contra comEstacionId.
 */
async function getStationCapacities(comEstacionId) {
  await poolConnect;
  const result = await pool
    .request()
    .input('comEstacionId', sql.Int, comEstacionId)
    .query(`
      SELECT cc.Producto AS producto, cc.CapacidadGalones AS capacidad
      FROM comb_capacidades cc
      INNER JOIN comb_estaciones ce ON ce.EstacionId = cc.EstacionId
      WHERE ce.Id = @comEstacionId
    `);

  const map = new Map();
  for (const row of result.recordset) {
    map.set(row.producto, row.capacidad);
  }
  return map;
}

// TankNumber >= 900 marca un tanque "provisional": se sembró desde comb_capacidades,
// sin que el Veeder-Root haya confirmado todavía cuál TankNumber real le corresponde a
// cada producto. El Veeder-Root real siempre reporta números chicos (1, 2, 3...), así
// que este rango nunca puede chocar con uno confirmado.
const PROVISIONAL_TANK_NUMBER_BASE = 900;

function titleCaseProduct(product) {
  const upper = product.toUpperCase();
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

/**
 * Siembra comb_tanques para una estación SOLO a partir de comb_capacidades, con
 * TankNumbers provisionales — para que la pantalla de Configuración (y /tanks) tenga
 * algo que mostrar/editar aunque el Veeder-Root de esa estación nunca haya respondido
 * todavía. No pisa filas que ya existan (ni provisionales ni confirmadas): un producto
 * ya presente para esa estación se deja tal cual.
 */
async function preSeedStationTanksFromCapacities(comEstacionId) {
  await poolConnect;

  const capacities = await getStationCapacities(comEstacionId);
  if (capacities.size === 0) return;

  const lowLevelPercent = DEFAULT_LOW_LEVEL_PERCENT;
  const existing = await pool
    .request()
    .input('comEstacionId', sql.Int, comEstacionId)
    .query('SELECT Name FROM comb_tanques WHERE ComEstacionId = @comEstacionId');
  const existingNames = new Set(existing.recordset.map((r) => r.Name));

  let nextProvisionalNumber = PROVISIONAL_TANK_NUMBER_BASE;
  for (const [product, capacityGallons] of capacities) {
    const name = titleCaseProduct(product);
    if (existingNames.has(name)) continue;

    await pool
      .request()
      .input('comEstacionId', sql.Int, comEstacionId)
      .input('tankNumber', sql.Int, nextProvisionalNumber)
      .input('name', sql.NVarChar, name)
      .input('capacityGallons', sql.Decimal(10, 2), capacityGallons)
      .input('lowLevelPercent', sql.Decimal(5, 2), lowLevelPercent)
      .query(
        `INSERT INTO comb_tanques (ComEstacionId, TankNumber, Name, CapacityGallons, LowLevelPercent)
         VALUES (@comEstacionId, @tankNumber, @name, @capacityGallons, @lowLevelPercent)`
      );
    nextProvisionalNumber += 1;
  }
}

/**
 * Upsert de comb_tanques para una estación, a partir de los tanques que ese Veeder-Root
 * acaba de reportar en vivo (TankNumber/producto reales). Empareja por Name (el producto
 * es la identidad estable de un tanque en una estación, no el TankNumber) para poder
 * confirmar una fila provisional — sembrada antes por preSeedStationTanksFromCapacities,
 * sin conexión al equipo — convirtiéndola en la fila real en vez de duplicarla.
 */
async function seedStationTanks(comEstacionId, discoveredTanks) {
  await poolConnect;

  const capacities = await getStationCapacities(comEstacionId);
  if (capacities.size === 0) {
    console.warn(
      `Estación ${comEstacionId}: no hay filas en comb_capacidades todavía — se omite la siembra de comb_tanques.`
    );
    return;
  }

  const lowLevelPercent = DEFAULT_LOW_LEVEL_PERCENT;

  for (const tank of discoveredTanks) {
    const product = tank.product.toUpperCase();
    const capacityGallons = capacities.get(product);
    if (!capacityGallons) {
      console.warn(
        `Estación ${comEstacionId}: producto '${tank.product}' (tanque ${tank.id}) no tiene fila en comb_capacidades — se omite.`
      );
      continue;
    }

    const name = titleCaseProduct(product);

    const existing = await pool
      .request()
      .input('comEstacionId', sql.Int, comEstacionId)
      .input('name', sql.NVarChar, name)
      .query('SELECT Id FROM comb_tanques WHERE ComEstacionId = @comEstacionId AND Name = @name');

    if (existing.recordset.length === 0) {
      await pool
        .request()
        .input('comEstacionId', sql.Int, comEstacionId)
        .input('tankNumber', sql.Int, tank.id)
        .input('name', sql.NVarChar, name)
        .input('capacityGallons', sql.Decimal(10, 2), capacityGallons)
        .input('lowLevelPercent', sql.Decimal(5, 2), lowLevelPercent)
        .query(
          `INSERT INTO comb_tanques (ComEstacionId, TankNumber, Name, CapacityGallons, LowLevelPercent)
           VALUES (@comEstacionId, @tankNumber, @name, @capacityGallons, @lowLevelPercent)`
        );
    } else {
      // Confirma el TankNumber real (pisa el provisional si lo había) y refresca la
      // capacidad por si comb_capacidades cambió. LowLevelPercent queda AFUERA a
      // propósito: es el único campo editable desde la pantalla de Configuración, y
      // un poll (o un reinicio del proceso, que vuelve a correr esto una vez por
      // estación) no debe pisar silenciosamente un umbral que alguien ya configuró.
      await pool
        .request()
        .input('id', sql.Int, existing.recordset[0].Id)
        .input('tankNumber', sql.Int, tank.id)
        .input('name', sql.NVarChar, name)
        .input('capacityGallons', sql.Decimal(10, 2), capacityGallons)
        .query(
          `UPDATE comb_tanques SET TankNumber = @tankNumber, Name = @name, CapacityGallons = @capacityGallons
           WHERE Id = @id`
        );
    }
  }

  const tanques = await pool
    .request()
    .input('comEstacionId', sql.Int, comEstacionId)
    .query('SELECT Id, TankNumber FROM comb_tanques WHERE ComEstacionId = @comEstacionId');

  const map = new Map();
  for (const row of tanques.recordset) {
    map.set(row.TankNumber, row.Id);
  }
  tanqueIdByStation.set(comEstacionId, map);
}

async function saveReadings(stationId, tanks) {
  await poolConnect;
  for (const tank of tanks) {
    const tanqueId = tanqueIdFor(stationId, tank.id);
    if (!tanqueId) {
      console.warn(
        `Tanque ${tank.id} no está registrado en comb_tanques para la estación ${stationId} — se omite la lectura.`
      );
      continue;
    }

    await pool
      .request()
      .input('tanqueId', sql.Int, tanqueId)
      .input('product', sql.VarChar, tank.product)
      .input('volumeGallons', sql.Decimal(10, 2), tank.volumeGallons)
      .input('heightInches', sql.Decimal(10, 2), tank.heightInches)
      .input('waterInches', sql.Decimal(10, 2), tank.waterInches)
      .input('temperatureF', sql.Decimal(6, 2), tank.temperatureF)
      .query(
        `INSERT INTO comb_lecturas (TanqueId, Product, VolumeGallons, HeightInches, WaterInches, TemperatureF, CreatedAt)
         VALUES (@tanqueId, @product, @volumeGallons, @heightInches, @waterInches, @temperatureF, GETDATE())`
      );
  }
}

/**
 * LEFT JOIN desde comb_tanques (no desde comb_lecturas) a propósito: un tanque
 * provisional (sembrado por preSeedStationTanksFromCapacities, sin lectura todavía
 * porque su Veeder-Root nunca respondió) debe aparecer igual en /tanks y en la
 * pantalla de Configuración, solo que con los campos de lectura en null.
 */
async function getLatestReadings(stationId) {
  await poolConnect;
  const result = await pool.request().input('comEstacionId', sql.Int, stationId).query(`
    SELECT t.TankNumber AS tank_id, l.Product AS product, l.VolumeGallons AS volume_gallons,
           l.HeightInches AS height_inches, l.WaterInches AS water_inches,
           l.TemperatureF AS temperature_f, l.CreatedAt AS created_at,
           t.Name AS name, t.CapacityGallons AS capacity_gallons, t.LowLevelPercent AS low_level_percent
    FROM comb_tanques t
    LEFT JOIN (
      SELECT TanqueId, MAX(CreatedAt) AS max_date FROM comb_lecturas GROUP BY TanqueId
    ) latest ON latest.TanqueId = t.Id
    LEFT JOIN comb_lecturas l ON l.TanqueId = latest.TanqueId AND l.CreatedAt = latest.max_date
    WHERE t.ComEstacionId = @comEstacionId
    ORDER BY t.TankNumber
  `);
  return result.recordset;
}

/**
 * Metadata de tanques (nombre/capacidad/umbral) sin tocar comb_lecturas — para el
 * endpoint de lectura en vivo, que consulta el Veeder-Root directo y solo usa esto
 * para enriquecer la respuesta, sin guardar ni leer históricos.
 */
async function getTankMetaByStation(stationId) {
  await poolConnect;
  const result = await pool
    .request()
    .input('comEstacionId', sql.Int, stationId)
    .query(
      `SELECT TankNumber AS tank_id, Name AS name, CapacityGallons AS capacity_gallons, LowLevelPercent AS low_level_percent
       FROM comb_tanques
       WHERE ComEstacionId = @comEstacionId`
    );

  const byTankNumber = new Map();
  for (const row of result.recordset) {
    byTankNumber.set(row.tank_id, row);
  }
  return byTankNumber;
}

async function getTankHistory(stationId, tankNumber, limit = 100) {
  await poolConnect;
  const tanqueId = tanqueIdFor(stationId, tankNumber);
  if (!tanqueId) return [];

  const result = await pool
    .request()
    .input('tanqueId', sql.Int, tanqueId)
    .input('tankNumber', sql.Int, tankNumber)
    .input('limit', sql.Int, limit)
    .query(
      `SELECT TOP (@limit) Id AS id, @tankNumber AS tank_id, Product AS product, VolumeGallons AS volume_gallons,
              HeightInches AS height_inches, WaterInches AS water_inches, TemperatureF AS temperature_f,
              CreatedAt AS created_at
       FROM comb_lecturas
       WHERE TanqueId = @tanqueId
       ORDER BY CreatedAt DESC`
    );
  return result.recordset;
}

async function getLastAlert(stationId, tankNumber) {
  await poolConnect;
  const tanqueId = tanqueIdFor(stationId, tankNumber);
  if (!tanqueId) return undefined;

  const result = await pool
    .request()
    .input('tanqueId', sql.Int, tanqueId)
    .query(
      `SELECT TOP 1 VolumeGallons AS volume_gallons, PercentageLevel AS [percent], SentAt AS sent_at
       FROM comb_alertas
       WHERE TanqueId = @tanqueId
       ORDER BY SentAt DESC`
    );
  return result.recordset[0];
}

async function recordAlert(stationId, tankNumber, volumeGallons, percent) {
  await poolConnect;
  const tanqueId = tanqueIdFor(stationId, tankNumber);
  if (!tanqueId) {
    throw new Error(`No se puede registrar alerta: tanque ${tankNumber} no está en comb_tanques para la estación ${stationId}.`);
  }

  await pool
    .request()
    .input('tanqueId', sql.Int, tanqueId)
    .input('volumeGallons', sql.Decimal(10, 2), volumeGallons)
    .input('percent', sql.Decimal(5, 2), percent)
    .query(
      `INSERT INTO comb_alertas (TanqueId, VolumeGallons, PercentageLevel, SentAt)
       VALUES (@tanqueId, @volumeGallons, @percent, GETUTCDATE())`
    );
}

/**
 * Resuelve el TanqueId directo contra comb_tanques (no vía tanqueIdByStation, que
 * solo se llena cuando esa estación tuvo un poll exitoso en este proceso) — la
 * pantalla de Configuración debe poder editar el umbral de un tanque aunque su
 * Veeder-Root no haya respondido todavía desde que arrancó el servidor.
 */
async function updateTankThreshold(stationId, tankNumber, lowLevelPercent) {
  await poolConnect;
  const result = await pool
    .request()
    .input('comEstacionId', sql.Int, stationId)
    .input('tankNumber', sql.Int, tankNumber)
    .input('lowLevelPercent', sql.Decimal(5, 2), lowLevelPercent)
    .query(
      `UPDATE comb_tanques SET LowLevelPercent = @lowLevelPercent
       WHERE ComEstacionId = @comEstacionId AND TankNumber = @tankNumber`
    );

  if (result.rowsAffected[0] === 0) {
    throw new Error(`Tanque ${tankNumber} no existe en comb_tanques para la estación ${stationId}.`);
  }

  // El mapa en memoria ya tiene el TanqueId cacheado si esta estación fue sembrada
  // en este proceso — no cambia con este UPDATE, solo el valor de la columna, así
  // que no hace falta invalidar nada acá.
}

/**
 * Credenciales (descifradas) del controlador de venta (VOX/Fusion/ALVIC) de una estación.
 * Se busca por EstacionId (gen_estaciones.Id) — NO por comEstacionId (comb_estaciones.Id):
 * la mayoría de las estaciones con controlador de venta todavía no tienen Veeder-Root,
 * así que no tienen fila en comb_estaciones (ver sql/008_create_comb_controladores_venta.sql).
 * Devuelve undefined si la estación no tiene controlador registrado o está inactivo.
 */
async function getControladorVenta(estacionId) {
  await poolConnect;
  const result = await pool
    .request()
    .input('estacionId', sql.Int, estacionId)
    .query(
      `SELECT Sistema AS sistema, Ip AS ip, Usuario AS usuario, PasswordCifrado AS passwordCifrado, Iv AS iv, AuthTag AS authTag
       FROM comb_controladores_venta
       WHERE EstacionId = @estacionId AND Activo = 1`
    );

  const row = result.recordset[0];
  if (!row) return undefined;

  return {
    sistema: row.sistema,
    ip: row.ip,
    usuario: row.usuario,
    password: decrypt({ cipherText: row.passwordCifrado, iv: row.iv, authTag: row.authTag }),
  };
}

module.exports = {
  getControladorVenta,
  resolveActiveStations,
  getActiveStationsList,
  getAllActiveFuelStations,
  getComEstacionIdForEstacion,
  getStationCapacities,
  preSeedStationTanksFromCapacities,
  seedStationTanks,
  saveReadings,
  getLatestReadings,
  getTankMetaByStation,
  getTankHistory,
  getLastAlert,
  recordAlert,
  updateTankThreshold,
};
