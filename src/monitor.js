const { VeederRootClient } = require('./veederClient');
const stationVolumeUnits = require('./config/stationVolumeUnits.json');
const {
  resolveActiveStations,
  saveReadings,
  seedStationTanks,
  preSeedStationTanksFromCapacities,
  getStationCapacities,
  getTankMetaByStation,
  getLastAlert,
  recordAlert,
} = require('./db');
const { sendLowLevelAlert } = require('./notifier');

const cooldownHours = Number(process.env.ALERT_COOLDOWN_HOURS || 6);
const defaultThreshold = Number(process.env.DEFAULT_LOW_LEVEL_PERCENT || 20);

// comEstacionId -> VeederRootClient (una conexión TCP propia por estación)
const clientsByStation = new Map();
// comEstacionId -> true una vez que comb_tanques ya se sembró/corrigió con éxito en este proceso
const seededStations = new Set();
let stationsMeta = [];

function titleCase(product) {
  return product.charAt(0) + product.slice(1).toLowerCase();
}

function hoursSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
}

/**
 * Resuelve las estaciones activas y arma un cliente Veeder-Root por estación.
 * Solo consulta SQL Server (rápido); no toca los equipos por TCP, así que un Veeder-Root
 * caído nunca retrasa el arranque del proceso.
 *
 * También pre-siembra comb_tanques desde comb_capacidades para toda estación que todavía
 * no tenga tanques (provisional, ver preSeedStationTanksFromCapacities en db.js) — la
 * capacidad ya se conoce desde el Excel de referencia, así que /tanks y la pantalla de
 * Configuración no tienen por qué esperar a que ese Veeder-Root conteste por primera vez.
 */
async function initStations() {
  stationsMeta = await resolveActiveStations();
  clientsByStation.clear();
  for (const station of stationsMeta) {
    const unitConfig = stationVolumeUnits[String(station.comEstacionId)];
    if (!unitConfig) {
      console.warn(
        `${station.name}: sin entrada en stationVolumeUnits.json — asumiendo LITROS (default seguro, ver veederClient.js).`
      );
    } else if (!unitConfig.confirmado) {
      console.warn(`${station.name}: unidad '${unitConfig.unidad}' sin confirmar todavía (inferida por marca) — revisar cuando conecte.`);
    }

    clientsByStation.set(
      station.comEstacionId,
      new VeederRootClient({
        host: station.host,
        port: Number(process.env.VEEDER_PORT || 10001),
        timeoutMs: Number(process.env.VEEDER_TIMEOUT_MS || 8000),
        volumeUnit: unitConfig?.unidad,
      })
    );

    try {
      await preSeedStationTanksFromCapacities(station.comEstacionId);
    } catch (err) {
      console.error(`No se pudo pre-sembrar comb_tanques para ${station.name}:`, err.message);
    }
  }
  return stationsMeta;
}

async function pollStation(station) {
  const client = clientsByStation.get(station.comEstacionId);
  console.log(`[${new Date().toISOString()}] Consultando Veeder-Root de ${station.name} (${station.host})...`);

  let tanks;
  try {
    ({ tanks } = await client.getTankInventory());
  } catch (err) {
    console.error(`Error consultando el Veeder-Root de ${station.name}:`, err.message);
    return;
  }

  if (tanks.length === 0) {
    console.warn(`${station.name}: la consulta no devolvió tanques.`);
    return;
  }

  // La siembra/corrección de comb_tanques se hace en el primer poll exitoso de cada estación
  // en vez de un paso previo al arranque, para no bloquear las otras 4 si esta está offline hoy.
  if (!seededStations.has(station.comEstacionId)) {
    try {
      await seedStationTanks(station.comEstacionId, tanks);
      seededStations.add(station.comEstacionId);
    } catch (err) {
      console.error(`No se pudo sembrar comb_tanques para ${station.name}:`, err.message);
      return;
    }
  }

  await saveReadings(station.comEstacionId, tanks);

  const capacities = await getStationCapacities(station.comEstacionId);

  for (const tank of tanks) {
    const capacityGallons = capacities.get(tank.product.toUpperCase());

    if (!capacityGallons) {
      console.warn(
        `${station.name}: tanque ${tank.id} (${tank.product}) no tiene capacidad configurada — se omite la verificación de umbral.`
      );
      continue;
    }

    const percent = (tank.volumeGallons / capacityGallons) * 100;

    if (percent <= defaultThreshold) {
      const lastAlert = await getLastAlert(station.comEstacionId, tank.id);
      const canAlertAgain = !lastAlert || hoursSince(lastAlert.sent_at) >= cooldownHours;

      if (canAlertAgain) {
        try {
          await sendLowLevelAlert({
            id: tank.id,
            name: titleCase(tank.product),
            stationName: station.name,
            volumeGallons: tank.volumeGallons,
            capacityGallons,
            percent,
          });
          await recordAlert(station.comEstacionId, tank.id, tank.volumeGallons, percent);
          console.log(`Alerta enviada: ${station.name} — tanque ${tank.id} al ${percent.toFixed(1)}%`);
        } catch (err) {
          console.error(`No se pudo enviar la alerta del tanque ${tank.id} en ${station.name}:`, err.message);
        }
      } else {
        console.log(
          `${station.name}: tanque ${tank.id} sigue bajo (${percent.toFixed(1)}%) pero en cooldown, no se reenvía correo.`
        );
      }
    }
  }
}

/**
 * @param {number} [stationId] Si se pasa, solo se sondea esa estación (comb_estaciones.Id).
 * Sin parámetro, se sondean todas las estaciones activas.
 */
async function runOnce(stationId) {
  if (stationsMeta.length === 0) {
    await initStations();
  }

  const targets = stationId
    ? stationsMeta.filter((s) => s.comEstacionId === Number(stationId))
    : stationsMeta;

  // Promise.allSettled (no un for...await secuencial): una estación lenta u offline
  // no debe retrasar ni tumbar el sondeo de las demás — cada falla se aísla por estación.
  await Promise.allSettled(targets.map((station) => pollStation(station)));
}

/**
 * Consulta el Veeder-Root de una estación EN VIVO y devuelve el dato crudo tal
 * cual lo reportó el equipo — no escribe en comb_lecturas ni depende de una
 * lectura previa guardada. Solo lee comb_tanques (metadata estática: nombre,
 * capacidad, umbral) para enriquecer la respuesta, nunca el histórico.
 * Pensado para un dashboard que necesita el valor real del momento, no lo
 * último que el cron haya guardado.
 */
async function getLiveReadings(stationId) {
  if (stationsMeta.length === 0) {
    await initStations();
  }

  const station = stationsMeta.find((s) => s.comEstacionId === Number(stationId));
  if (!station) {
    throw new Error(`Estación ${stationId} no está activa.`);
  }

  const client = clientsByStation.get(station.comEstacionId);
  const { tanks } = await client.getTankInventory();

  const meta = await getTankMetaByStation(station.comEstacionId);
  const now = new Date().toISOString();

  return tanks.map((tank) => {
    const tankMeta = meta.get(tank.id);
    return {
      tank_id: tank.id,
      product: tank.product,
      volume_gallons: tank.volumeGallons,
      water_inches: tank.waterInches,
      temperature_f: tank.temperatureF,
      created_at: now,
      name: tankMeta?.name ?? titleCase(tank.product),
      capacity_gallons: tankMeta?.capacity_gallons ?? null,
      low_level_percent: tankMeta?.low_level_percent ?? null,
    };
  });
}

module.exports = { runOnce, initStations, getLiveReadings };
