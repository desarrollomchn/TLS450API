const { VeederRootClient } = require('./veederClient');
const { saveReadings, getLastAlert, recordAlert } = require('./db');
const { sendLowLevelAlert } = require('./notifier');
const tanksConfig = require('./config/tanks.json').tanks;

const client = new VeederRootClient({
  host: process.env.VEEDER_HOST,
  port: Number(process.env.VEEDER_PORT || 10001),
  timeoutMs: Number(process.env.VEEDER_TIMEOUT_MS || 8000),
});

const cooldownHours = Number(process.env.ALERT_COOLDOWN_HOURS || 6);
const defaultThreshold = Number(process.env.DEFAULT_LOW_LEVEL_PERCENT || 20);

function findTankConfig(id) {
  return tanksConfig.find((t) => t.id === id);
}

function hoursSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
}

async function runOnce() {
  console.log(`[${new Date().toISOString()}] Consultando Veeder-Root...`);

  let tanks;
  try {
    ({ tanks } = await client.getTankInventory());
  } catch (err) {
    console.error('Error consultando el Veeder-Root:', err.message);
    return;
  }

  if (tanks.length === 0) {
    console.warn('La consulta no devolvió tanques. Revisa el parser (ver testConnection.js).');
    return;
  }

  await saveReadings(tanks);

  for (const tank of tanks) {
    const cfg = findTankConfig(tank.id);
    const capacityGallons = cfg?.capacityGallons;
    const thresholdPercent = cfg?.lowLevelPercent ?? defaultThreshold;

    if (!capacityGallons) {
      console.warn(
        `Tanque ${tank.id} no está configurado en config/tanks.json — no se puede calcular % de nivel. Se omite la verificación de umbral.`
      );
      continue;
    }

    const percent = (tank.volumeGallons / capacityGallons) * 100;

    if (percent <= thresholdPercent) {
      const lastAlert = await getLastAlert(tank.id);
      const canAlertAgain = !lastAlert || hoursSince(lastAlert.sent_at) >= cooldownHours;

      if (canAlertAgain) {
        try {
          await sendLowLevelAlert({
            id: tank.id,
            name: cfg.name,
            volumeGallons: tank.volumeGallons,
            capacityGallons,
            percent,
          });
          await recordAlert(tank.id, tank.volumeGallons, percent);
          console.log(`Alerta enviada: tanque ${tank.id} (${cfg.name}) al ${percent.toFixed(1)}%`);
        } catch (err) {
          console.error(`No se pudo enviar la alerta del tanque ${tank.id}:`, err.message);
        }
      } else {
        console.log(
          `Tanque ${tank.id} sigue bajo (${percent.toFixed(1)}%) pero en cooldown, no se reenvía correo.`
        );
      }
    }
  }
}

module.exports = { runOnce };
