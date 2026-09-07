// Corre un archivo .sql de sql/ contra la base, dividiendo por líneas "GO" (batches),
// igual que haría sqlcmd. Uso: node scripts/runMigration.js sql/008_create_comb_controladores_venta.sql
require('dotenv').config();
const fs = require('fs');
const path = require('path');
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

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Uso: node scripts/runMigration.js <ruta al .sql>');
    process.exit(1);
  }

  const content = fs.readFileSync(path.resolve(filePath), 'utf8');
  const batches = content.split(/^\s*GO\s*$/im).map((b) => b.trim()).filter(Boolean);

  const pool = await sql.connect(config);
  for (const batch of batches) {
    await pool.request().query(batch);
  }
  await pool.close();
  console.log(`OK: ${batches.length} batch(es) ejecutados desde ${filePath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
