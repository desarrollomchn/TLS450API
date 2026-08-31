require('dotenv').config();
const { VeederRootClient } = require('./veederClient');

(async () => {
  // Ya no hay un único VEEDER_HOST en .env (multi-estación) — el host de la
  // estación a probar se pasa como argumento: npm run test:connection -- <host>
  const host = process.argv[2];
  if (!host) {
    console.error('Uso: npm run test:connection -- <host-del-veeder-root>');
    process.exit(1);
  }

  const client = new VeederRootClient({
    host,
    port: Number(process.env.VEEDER_PORT || 10001),
    timeoutMs: Number(process.env.VEEDER_TIMEOUT_MS || 8000),
  });

  console.log(`Conectando a ${host}:${process.env.VEEDER_PORT || 10001}...`);

  try {
    const { rawResponse, tanks } = await client.getTankInventory();
    console.log('\n--- RESPUESTA CRUDA (útil para ajustar el parser) ---');
    console.log(JSON.stringify(rawResponse));
    console.log('\n--- TANQUES PARSEADOS ---');
    const traducido = tanks.map((t) => ({
      id: t.id,
      producto: t.product,
      volumenLitros: t.volumeGallons,
      volumenCompensadoLitros: t.tcVolumeGallons,
      vacioLitros: t.ullageGallons,
      alturaMM: t.heightInches,
      aguaMM: t.waterInches,
      temperaturaC: t.temperatureF,
    }));
    console.table(traducido);

    if (tanks.length === 0) {
      console.log(
        '\n⚠️  No se detectaron tanques con el parser actual. Copia la RESPUESTA CRUDA de arriba y ajustamos la regex en veederClient.js.'
      );
    }
  } catch (err) {
    console.error('Error al conectar con el Veeder-Root:', err.message);
    console.error(
      'Revisa: IP/puerto correctos, que el equipo permita conexiones TCP entrantes, y que no haya un firewall bloqueando el puerto 10001.'
    );
  }
})();
