require('dotenv').config();
const { VeederRootClient } = require('./veederClient');
const { sendTestReport } = require('./notifier');
const tanksConfig = require('./config/tanks.json').tanks;

(async () => {
  const client = new VeederRootClient({
    host: process.env.VEEDER_HOST,
    port: Number(process.env.VEEDER_PORT || 10001),
    timeoutMs: Number(process.env.VEEDER_TIMEOUT_MS || 8000),
  });

  console.log(`Consultando ${process.env.VEEDER_HOST}:${process.env.VEEDER_PORT}...`);

  try {
    const { tanks } = await client.getTankInventory();

    if (tanks.length === 0) {
      console.log('⚠️  No se detectaron tanques. No se envía correo.');
      return;
    }

    console.log(`Tanques obtenidos: ${tanks.length}. Enviando correo de prueba...`);
    await sendTestReport(tanks, tanksConfig);
    console.log('✅ Prueba completa: consulta al Veeder-Root y envío de correo OK.');
  } catch (err) {
    console.error('❌ Error en la prueba:', err.message);
  }
})();
