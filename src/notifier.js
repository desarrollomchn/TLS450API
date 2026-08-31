const nodemailer = require('nodemailer');

function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Envía el correo de alerta de nivel bajo para un tanque.
 * @param {{name:string, id:number, volumeGallons:number, percent:number, capacityGallons:number}} tank
 */
async function sendLowLevelAlert(tank) {
  const transporter = buildTransport();

  const subject = `⛽ Nivel bajo — Tanque ${tank.id} (${tank.name}): ${tank.percent.toFixed(1)}%`;
  const html = `
    <h2>Alerta de nivel bajo de combustible</h2>
    <p>El tanque <b>${tank.id} - ${tank.name}</b> reportó un nivel bajo el umbral configurado.</p>
    <table cellpadding="6" style="border-collapse:collapse">
      <tr><td><b>Volumen actual</b></td><td>${tank.volumeGallons.toFixed(0)} gal</td></tr>
      <tr><td><b>Capacidad</b></td><td>${tank.capacityGallons} gal</td></tr>
      <tr><td><b>% del tanque</b></td><td>${tank.percent.toFixed(1)}%</td></tr>
      <tr><td><b>Fecha/hora</b></td><td>${new Date().toLocaleString('es-HN')}</td></tr>
    </table>
    <p>Se recomienda coordinar el reabastecimiento.</p>
  `;

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.MAIL_TO,
    subject,
    html,
  });

  console.log(`[correo] Enviado a ${process.env.MAIL_TO} — messageId: ${info.messageId}`);
}

/**
 * Envía un correo de prueba con el inventario completo de tanques, sin depender
 * del umbral de alerta. Útil para validar que el servicio SMTP funciona de punta a punta.
 * @param {Array<{id:number, product:string, volumeGallons:number, tcVolumeGallons:number, ullageGallons:number, heightInches:number, waterInches:number, temperatureF:number}>} tanks
 * @param {Array<{id:number, name:string}>} tanksConfig
 */
async function sendTestReport(tanks, tanksConfig) {
  const transporter = buildTransport();

  const rows = tanks
    .map((t) => {
      const cfg = tanksConfig.find((c) => c.id === t.id);
      return `
        <tr>
          <td>${t.id}</td>
          <td>${cfg?.name || t.product}</td>
          <td>${t.volumeGallons.toFixed(0)}</td>
          <td>${t.tcVolumeGallons.toFixed(0)}</td>
          <td>${t.ullageGallons.toFixed(0)}</td>
          <td>${t.heightInches.toFixed(2)}</td>
          <td>${t.waterInches.toFixed(2)}</td>
          <td>${t.temperatureF.toFixed(1)}</td>
        </tr>`;
    })
    .join('');

  const subject = `🧪 Prueba de servicio — Inventario Veeder-Root (${tanks.length} tanques)`;
  const html = `
    <h2>Prueba de conexión y correo — Veeder-Root</h2>
    <p>Este es un correo de prueba, no está atado al umbral de alerta configurado.</p>
    <table cellpadding="6" style="border-collapse:collapse; border:1px solid #ccc">
      <tr style="background:#f0f0f0">
        <th>Tanque</th><th>Producto</th><th>Volumen (L)</th><th>Vol. Compensado (L)</th>
        <th>Vacío (L)</th><th>Altura (mm)</th><th>Agua (mm)</th><th>Temp (°C)</th>
      </tr>
      ${rows}
    </table>
    <p>Fecha/hora: ${new Date().toLocaleString('es-HN')}</p>
  `;

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.MAIL_TO,
    subject,
    html,
  });

  console.log(`[correo] Prueba enviada a ${process.env.MAIL_TO} — messageId: ${info.messageId}`);
}

module.exports = { sendLowLevelAlert, sendTestReport };
