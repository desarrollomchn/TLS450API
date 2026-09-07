require('dotenv').config();
const { VeederRootClient, percentFromUllage } = require('./veederClient');
const { resolveActiveStations, getStationCapacities } = require('./db');
const { sendTestReport } = require('./notifier');
const stationVolumeUnits = require('./config/stationVolumeUnits.json');

const TEST_TIMEOUT_MS = 5000;

(async () => {
  const stations = await resolveActiveStations();
  console.log(`Consultando ${stations.length} estaciones activas (timeout ${TEST_TIMEOUT_MS / 1000}s cada una)...`);

  // Promise.allSettled: una estación caída/lenta no debe tumbar ni demorar el resto —
  // se prueban todas en paralelo, cada una con su propio timeout corto.
  const settled = await Promise.allSettled(
    stations.map(async (station) => {
      // Misma unidad por estación que usa monitor.js — sin esto el cliente cae en el
      // default 'LITROS' de VeederRootClient para toda estación, aunque esté en
      // galones (bug real: infló ~3.785x la capacidad implícita de las estaciones
      // GALONES en el correo de prueba, nunca afectó a monitor.js/la alerta real).
      const unitConfig = stationVolumeUnits[String(station.comEstacionId)];
      const client = new VeederRootClient({
        host: station.host,
        port: Number(process.env.VEEDER_PORT || 10001),
        timeoutMs: TEST_TIMEOUT_MS,
        volumeUnit: unitConfig?.unidad,
      });
      const { tanks } = await client.getTankInventory();

      // Mismo % (percentFromUllage) y misma comparación de fondo contra
      // comb_capacidades que usa la alerta de nivel bajo (ver monitor.js) —
      // así el correo de prueba no queda mudo sobre capacidad/%.
      const capacities = await getStationCapacities(station.comEstacionId);
      const enrichedTanks = tanks.map((tank) => {
        const capacityGallons = capacities.get(tank.product.toUpperCase()) ?? null;
        const percent = percentFromUllage(tank.volumeGallons, tank.ullageGallons);

        if (capacityGallons) {
          const percentCapacidad = (tank.volumeGallons / capacityGallons) * 100;
          if (Math.abs(percent - percentCapacidad) > 5) {
            console.warn(
              `${station.name}: tanque ${tank.id} (${tank.product}) — % Veeder-Root (${percent.toFixed(1)}%) difiere >5pts de % comb_capacidades (${percentCapacidad.toFixed(1)}%), revisar capacidad configurada.`
            );
          }
        }

        return { ...tank, capacityGallons, percent };
      });

      return { station, tanks: enrichedTanks };
    })
  );

  const working = [];
  settled.forEach((result, i) => {
    const station = stations[i];
    if (result.status === 'fulfilled' && result.value.tanks.length > 0) {
      console.log(`✅ ${station.name}: ${result.value.tanks.length} tanques`);
      working.push(result.value);
    } else {
      const reason = result.status === 'rejected' ? result.reason.message : 'la consulta no devolvió tanques';
      console.log(`❌ ${station.name}: ${reason}`);
    }
  });

  if (working.length === 0) {
    console.log('⚠️  Ninguna estación respondió a tiempo. No se envía correo.');
    process.exit(1);
  }

  console.log(`Enviando correo de prueba con ${working.length}/${stations.length} estaciones...`);
  try {
    await sendTestReport(working);
    console.log('✅ Prueba completa: consulta a los Veeder-Root y envío de correo OK.');
  } catch (err) {
    console.error('❌ Error enviando el correo:', err.message);
  }

  // resolveActiveStations abre el pool de mssql (db.js) — sin esto el proceso queda
  // colgado esperando que se cierre solo, cosa que no pasa en un script de un solo uso.
  process.exit(0);
})();
