require('dotenv').config();
const { VeederRootClient } = require('./veederClient');

(async () => {
  const client = new VeederRootClient({
    host: process.env.VEEDER_HOST,
    port: Number(process.env.VEEDER_PORT || 10001),
    timeoutMs: Number(process.env.VEEDER_TIMEOUT_MS || 8000),
  });

  console.log(`Conectando a ${process.env.VEEDER_HOST}:${process.env.VEEDER_PORT}...`);

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
