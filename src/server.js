require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const { runOnce } = require('./monitor');
const db = require('./db');
const { getLatestReadings, getTankHistory } = db;
const { requireAuth } = require('./auth');
const tanksConfig = require('./config/tanks.json').tanks;

const app = express();
const PORT = process.env.API_PORT || 3000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(requireAuth);

// GET /tanks -> última lectura de cada tanque + % calculado
app.get('/tanks', async (req, res) => {
  const readings = await getLatestReadings();
  const enriched = readings.map((r) => {
    const cfg = tanksConfig.find((t) => t.id === r.tank_id);
    const percent = cfg ? (r.volume_gallons / cfg.capacityGallons) * 100 : null;
    return {
      idTanque: r.tank_id,
      nombre: cfg?.name || r.product,
      volumenGalones: r.volume_gallons,
      capacidadGalones: cfg?.capacityGallons || null,
      porcentaje: percent !== null ? Number(percent.toFixed(1)) : null,
      temperaturaF: r.temperature_f,
      aguaPulgadas: r.water_inches,
      ultimaActualizacion: r.created_at,
    };
  });
  res.json(enriched);
});

// GET /tanks/:id/history -> histórico de lecturas de un tanque
app.get('/tanks/:id/history', async (req, res) => {
  const history = await getTankHistory(Number(req.params.id), Number(req.query.limit) || 100);
  const traducido = history.map((r) => ({
    id: r.id,
    idTanque: r.tank_id,
    producto: r.product,
    volumenGalones: r.volume_gallons,
    alturaPulgadas: r.height_inches,
    aguaPulgadas: r.water_inches,
    temperaturaF: r.temperature_f,
    fecha: r.created_at,
  }));
  res.json(traducido);
});

// POST /tanks/check-now -> fuerza una consulta inmediata al equipo (útil para pruebas)
app.post('/tanks/check-now', async (req, res) => {
  try {
    await runOnce();
    res.json({ ok: true, message: 'Consulta ejecutada' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API escuchando en http://localhost:${PORT}`);

      // Programa la consulta periódica al Veeder-Root
      const monitorEnabled = process.env.MONITOR_ENABLED !== 'false';

      if (monitorEnabled) {
        const intervalMin = Number(process.env.POLL_INTERVAL_MINUTES || 10);
        const cronExpr = `*/${intervalMin} * * * *`;
        console.log(`Monitoreo programado cada ${intervalMin} minuto(s)`);

        cron.schedule(cronExpr, () => {
          runOnce().catch((err) => console.error('Error en el ciclo de monitoreo:', err));
        });

        // Corre una vez al iniciar
        runOnce().catch((err) => console.error('Error en la consulta inicial:', err));
      } else {
        console.log('Monitoreo automático deshabilitado (MONITOR_ENABLED=false). /tanks/check-now sigue disponible manualmente.');
      }
    });
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err.message);
    process.exit(1);
  });
