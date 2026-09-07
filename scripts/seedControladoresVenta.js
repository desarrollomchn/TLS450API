// Siembra comb_controladores_venta desde scripts/controladores-venta.seed-data.json
// (fuente: "Controladores de venta EDS copemsa y Jade Masis.xlsx", provisto por infraestructura).
//
// Por defecto corre en modo dry-run (solo muestra qué haría). Para escribir de verdad:
//   node scripts/seedControladoresVenta.js --apply
//
// Requiere en el .env: MSSQL_SERVER/DATABASE/USER/PASSWORD (conexión normal del proyecto)
// y CREDENTIALS_ENCRYPTION_KEY (para cifrar el password de cada fila).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { encrypt } = require('../src/crypto');

const APPLY = process.argv.includes('--apply');

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

function normalizeName(name) {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

async function main() {
  const dataPath = path.join(__dirname, 'controladores-venta.seed-data.json');
  const seedRows = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const pool = await sql.connect(config);

  const estaciones = await pool.request().query('SELECT Id, Nombre FROM gen_estaciones');
  const byName = new Map();
  for (const row of estaciones.recordset) {
    byName.set(normalizeName(row.Nombre), row.Id);
  }

  const existing = await pool.request().query('SELECT EstacionId FROM comb_controladores_venta');
  const alreadySeeded = new Set(existing.recordset.map((r) => r.EstacionId));

  const matched = [];
  const unmatched = [];

  for (const seedRow of seedRows) {
    const estacionId = byName.get(normalizeName(seedRow.nombre));
    if (!estacionId) {
      unmatched.push(seedRow.nombre);
      continue;
    }
    matched.push({ ...seedRow, estacionId, alreadyExists: alreadySeeded.has(estacionId) });
  }

  console.log(`Filas en el seed: ${seedRows.length}`);
  console.log(`Matcheadas contra gen_estaciones: ${matched.length}`);
  console.log(`Ya existentes en comb_controladores_venta (se omiten): ${matched.filter((m) => m.alreadyExists).length}`);
  console.log(`SIN MATCH en gen_estaciones (revisar nombre a mano): ${unmatched.length}`);
  if (unmatched.length > 0) {
    console.log('  ->', unmatched.join(', '));
  }

  const toInsert = matched.filter((m) => !m.alreadyExists);
  console.log(`A insertar: ${toInsert.length}`);
  for (const row of toInsert) {
    console.log(`  - ${row.nombre} (EstacionId ${row.estacionId}) [${row.sistema}] ${row.ip} usuario=${row.usuario}`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN: no se escribió nada. Corré con --apply para insertar de verdad.');
    await pool.close();
    return;
  }

  for (const row of toInsert) {
    const { cipherText, iv, authTag } = encrypt(row.password);
    await pool
      .request()
      .input('estacionId', sql.Int, row.estacionId)
      .input('sistema', sql.VarChar, row.sistema)
      .input('ip', sql.VarChar, row.ip)
      .input('usuario', sql.VarChar, row.usuario)
      .input('passwordCifrado', sql.VarBinary, cipherText)
      .input('iv', sql.VarBinary, iv)
      .input('authTag', sql.VarBinary, authTag)
      .query(
        `INSERT INTO comb_controladores_venta (EstacionId, Sistema, Ip, Usuario, PasswordCifrado, Iv, AuthTag)
         VALUES (@estacionId, @sistema, @ip, @usuario, @passwordCifrado, @iv, @authTag)`
      );
  }
  console.log(`\nInsertadas ${toInsert.length} filas.`);

  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
