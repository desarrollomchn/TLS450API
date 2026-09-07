require('dotenv').config();
const { VeederRootClient } = require('./veederClient');
const { resolveActiveStations } = require('./db');
const stationVolumeUnits = require('./config/stationVolumeUnits.json');

const TEST_TIMEOUT_MS = 8000;

/**
 * Chequeo de SOLO LECTURA contra TODAS las estaciones activas (comb_estaciones.Activo=1):
 * Function Code 517 (I51700 — formato "display", texto legible) le pregunta a cada
 * Veeder-Root qué unidad de volumen tiene configurada (galones/litros/imperial). Es un
 * inquiry, no escribe nada en el equipo — sirve para verificar/corregir
 * src/config/stationVolumeUnits.json contra la unidad real, en vez de inferirla por marca.
 *
 * Uso: npm run test:units
 */
function detectUnit(raw) {
  if (/LITER|METRIC/i.test(raw)) return 'LITROS (detectado)';
  if (/GALLON/i.test(raw)) return 'GALONES (detectado)';
  return 'NO DETECTADO — revisar respuesta cruda a mano';
}

(async () => {
  const stations = await resolveActiveStations();
  console.log(`Consultando System Type & Language Flags (I51700, solo lectura) en ${stations.length} estaciones activas (timeout ${TEST_TIMEOUT_MS / 1000}s cada una)...\n`);

  const settled = await Promise.allSettled(
    stations.map(async (station) => {
      const client = new VeederRootClient({
        host: station.host,
        port: Number(process.env.VEEDER_PORT || 10001),
        timeoutMs: TEST_TIMEOUT_MS,
      });
      const rawResponse = await client.sendRaw('I51700');
      return { station, rawResponse };
    })
  );

  const filas = [];
  settled.forEach((result, i) => {
    const station = stations[i];
    const configurada = stationVolumeUnits[String(station.comEstacionId)]?.unidad ?? '(sin config)';

    if (result.status === 'fulfilled') {
      filas.push({
        estacion: station.name,
        host: station.host,
        configuradaEnJSON: configurada,
        detectadaEnEquipo: detectUnit(result.value.rawResponse),
      });
    } else {
      filas.push({
        estacion: station.name,
        host: station.host,
        configuradaEnJSON: configurada,
        detectadaEnEquipo: `❌ ${result.reason.message}`,
      });
    }
  });

  console.table(filas);
  console.log(
    '\n"detectadaEnEquipo" es una detección por palabra clave sobre la respuesta cruda — el formato exacto de ' +
      'I51700 no está 100% confirmado contra el manual, así que ante cualquier "NO DETECTADO" o duda, corré ' +
      '`npm run test:connection -- <host>` o revisá manualmente la respuesta cruda antes de tocar stationVolumeUnits.json.'
  );
})();
