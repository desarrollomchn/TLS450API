const sql = require('mssql');

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

  const lowLevelPercent = Number(process.env.DEFAULT_LOW_LEVEL_PERCENT || 20);
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

  const lowLevelPercent = Number(process.env.DEFAULT_LOW_LEVEL_PERCENT || 20);

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
      `SELECT TOP 1 VolumeGallons AS volume_gallons, PercentageLevel AS percent, SentAt AS sent_at
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
       VALUES (@tanqueId, @volumeGallons, @percent, GETDATE())`
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

module.exports = {
  resolveActiveStations,
  getActiveStationsList,
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
