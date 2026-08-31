const sql = require('mssql');
const tanksConfig = require('./config/tanks.json').tanks;

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

let comEstacionId = null;
// TankNumber -> TanqueId. Estático porque este proceso solo atiende una estación
// (un Veeder-Root por proceso); se llena una sola vez en init() a partir de comb_tanques.
const tanqueIdByTankNumber = new Map();

/**
 * Resuelve la estación (comb_estaciones) para el host configurado y siembra
 * comb_tanques con los tanques de config/tanks.json si aún no existen.
 * Debe llamarse una vez al arrancar el proceso, antes de aceptar tráfico.
 */
async function init() {
  await poolConnect;

  const host = process.env.STATION_HOST || process.env.VEEDER_HOST;

  const estacionResult = await pool
    .request()
    .input('host', sql.VarChar, host)
    .query('SELECT Id FROM comb_estaciones WHERE Host = @host AND Activo = 1');

  if (estacionResult.recordset.length === 0) {
    throw new Error(
      `No se encontró una estación activa en comb_estaciones para Host = '${host}'. Verifica MSSQL/STATION_HOST.`
    );
  }

  comEstacionId = estacionResult.recordset[0].Id;

  // Upsert por (ComEstacionId, TankNumber): evita duplicar tanques si el proceso
  // se reinicia, ya que tanks.json es la fuente de verdad de qué tanques existen.
  for (const tank of tanksConfig) {
    const existing = await pool
      .request()
      .input('comEstacionId', sql.Int, comEstacionId)
      .input('tankNumber', sql.Int, tank.id)
      .query(
        'SELECT Id FROM comb_tanques WHERE ComEstacionId = @comEstacionId AND TankNumber = @tankNumber'
      );

    if (existing.recordset.length === 0) {
      await pool
        .request()
        .input('comEstacionId', sql.Int, comEstacionId)
        .input('tankNumber', sql.Int, tank.id)
        .input('name', sql.NVarChar, tank.name)
        .input('capacityGallons', sql.Decimal(10, 2), tank.capacityGallons)
        .input('lowLevelPercent', sql.Decimal(5, 2), tank.lowLevelPercent)
        .query(
          `INSERT INTO comb_tanques (ComEstacionId, TankNumber, Name, CapacityGallons, LowLevelPercent)
           VALUES (@comEstacionId, @tankNumber, @name, @capacityGallons, @lowLevelPercent)`
        );
    }
  }

  const tanques = await pool
    .request()
    .input('comEstacionId', sql.Int, comEstacionId)
    .query('SELECT Id, TankNumber FROM comb_tanques WHERE ComEstacionId = @comEstacionId');

  tanqueIdByTankNumber.clear();
  for (const row of tanques.recordset) {
    tanqueIdByTankNumber.set(row.TankNumber, row.Id);
  }
}

function tanqueIdFor(tankNumber) {
  return tanqueIdByTankNumber.get(tankNumber);
}

async function saveReadings(tanks) {
  await poolConnect;
  for (const tank of tanks) {
    const tanqueId = tanqueIdFor(tank.id);
    if (!tanqueId) {
      console.warn(
        `Tanque ${tank.id} no está registrado en comb_tanques para esta estación — se omite la lectura.`
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

async function getLatestReadings() {
  await poolConnect;
  const result = await pool.request().input('comEstacionId', sql.Int, comEstacionId).query(`
    SELECT t.TankNumber AS tank_id, l.Product AS product, l.VolumeGallons AS volume_gallons,
           l.HeightInches AS height_inches, l.WaterInches AS water_inches,
           l.TemperatureF AS temperature_f, l.CreatedAt AS created_at
    FROM comb_lecturas l
    INNER JOIN comb_tanques t ON t.Id = l.TanqueId
    INNER JOIN (
      SELECT TanqueId, MAX(CreatedAt) AS max_date FROM comb_lecturas GROUP BY TanqueId
    ) latest ON l.TanqueId = latest.TanqueId AND l.CreatedAt = latest.max_date
    WHERE t.ComEstacionId = @comEstacionId
    ORDER BY t.TankNumber
  `);
  return result.recordset;
}

async function getTankHistory(tankNumber, limit = 100) {
  await poolConnect;
  const tanqueId = tanqueIdFor(tankNumber);
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

async function getLastAlert(tankNumber) {
  await poolConnect;
  const tanqueId = tanqueIdFor(tankNumber);
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

async function recordAlert(tankNumber, volumeGallons, percent) {
  await poolConnect;
  const tanqueId = tanqueIdFor(tankNumber);
  if (!tanqueId) {
    throw new Error(`No se puede registrar alerta: tanque ${tankNumber} no está en comb_tanques.`);
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

module.exports = {
  init,
  saveReadings,
  getLatestReadings,
  getTankHistory,
  getLastAlert,
  recordAlert,
};
