require('dotenv').config();
const { VeederRootClient } = require('./veederClient');
const { sendTestReport } = require('./notifier');

(async () => {
  // Ya no hay un único VEEDER_HOST en .env (multi-estación) — el host de la
  // estación a probar se pasa como argumento: npm run test:email -- <host>
  const host = process.argv[2];
  if (!host) {
    console.error('Uso: npm run test:email -- <host-del-veeder-root>');
    process.exit(1);
  }

  const client = new VeederRootClient({
    host,
    port: Number(process.env.VEEDER_PORT || 10001),
    timeoutMs: Number(process.env.VEEDER_TIMEOUT_MS || 8000),
  });

  console.log(`Consultando ${host}:${process.env.VEEDER_PORT || 10001}...`);

  try {
    const { tanks } = await client.getTankInventory();

    if (tanks.length === 0) {
      console.log('⚠️  No se detectaron tanques. No se envía correo.');
      return;
    }

    console.log(`Tanques obtenidos: ${tanks.length}. Enviando correo de prueba...`);
    await sendTestReport(tanks, []);
    console.log('✅ Prueba completa: consulta al Veeder-Root y envío de correo OK.');
  } catch (err) {
    console.error('❌ Error en la prueba:', err.message);
  }
})();
