// One-off read-only script: coverage check for comb_tanques across all fuel stations.
// Usage: node scripts/checkTankCoverage.js
require('dotenv').config();
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

(async () => {
  const pool = await sql.connect(config);

  const result = await pool.request().query(`
    SELECT
      ge.Id AS estacionId,
      ge.Nombre AS nombre,
      ge.Activo AS geActivo,
      ce.Id AS comEstacionId,
      ce.Activo AS ceActivo,
      (SELECT COUNT(*) FROM comb_capacidades cc WHERE cc.EstacionId = ge.Id) AS capacidades,
      (SELECT COUNT(*) FROM comb_tanques t WHERE t.ComEstacionId = ce.Id) AS tanquesTotal,
      (SELECT COUNT(*) FROM comb_tanques t WHERE t.ComEstacionId = ce.Id AND t.TankNumber < 900) AS tanquesConfirmados,
      (SELECT COUNT(*) FROM comb_tanques t WHERE t.ComEstacionId = ce.Id AND t.TankNumber >= 900) AS tanquesProvisionales,
      (SELECT COUNT(*) FROM comb_lecturas l INNER JOIN comb_tanques t2 ON t2.Id = l.TanqueId WHERE t2.ComEstacionId = ce.Id) AS lecturasTotal
    FROM gen_estaciones ge
    LEFT JOIN comb_estaciones ce ON ce.EstacionId = ge.Id
    ORDER BY ge.Orden
  `);

  console.table(
    result.recordset.map((r) => ({
      Id: r.estacionId,
      Nombre: r.nombre,
      GenActivo: r.geActivo,
      TieneVeederRoot: r.comEstacionId != null,
      VRActivo: r.ceActivo,
      Capacidades: r.capacidades,
      TanquesConfirmados: r.tanquesConfirmados,
      TanquesProvisionales: r.tanquesProvisionales,
      Lecturas: r.lecturasTotal,
    }))
  );

  await pool.close();
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
