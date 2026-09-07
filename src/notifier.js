const https = require('https');
const http = require('http');
const { URL } = require('url');

/** AuthServiceApi.AplicacionId para tls450 en auth_aplicaciones — identifica quién dispara el envío, solo para logging del lado de AuthServiceApi. */
const CORREO_APLICACION_ID = 3;

/**
 * POST /v1/correo de AuthServiceApi — mismo certificado autofirmado en dev que
 * usa el JWKS de auth.js, por eso el mismo toggle AUTH_ALLOW_INSECURE_TLS.
 * Sin librería HTTP externa: http(s).request a mano, igual que jwks-rsa lo hace
 * internamente para el JWKS.
 */
function postCorreo({ destinatarios, asunto, mensaje, isHtml = false }) {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/correo', process.env.AUTH_API_BASE_URL);
    const client = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify({
      EmailsDestinatarios: destinatarios,
      EmailsCc: [],
      Asunto: asunto,
      Mensaje: mensaje,
      AplicacionId: CORREO_APLICACION_ID,
      EsHtml: isHtml,
    });

    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Api-Key': process.env.CORREO_API_KEY,
        },
        rejectUnauthorized: process.env.AUTH_ALLOW_INSECURE_TLS !== 'true',
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
          reject(new Error(`POST /v1/correo respondió ${res.statusCode}: ${raw || '(sin cuerpo)'}`));
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Marca (mismo azul que usa el Sidebar/Login de TLS450FE) — todo inline porque
// los clientes de correo (Outlook sobre todo) ignoran <style> en el <head>.
const BRAND = {
  blue900: '#1e3a8a',
  blue200: '#93c5fd',
  slate900: '#0f172a',
  slate600: '#475569',
  slate500: '#64748b',
  slate200: '#e2e8f0',
  slate50: '#f8fafc',
  red600: '#dc2626',
  amber600: '#d97706',
};

/**
 * Envoltorio visual compartido por todos los correos de TLS450Api: header con
 * el nombre de la app, el `bodyHtml` de cada llamador en el medio, footer con
 * fecha. `accentColor` tiñe la franja debajo del header (severidad de la
 * alerta, o el azul de marca para algo neutral como el reporte de prueba).
 */
function emailShell({ subtitle, accentColor = BRAND.blue900, bodyHtml }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.slate50};padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid ${BRAND.slate200};overflow:hidden;">
            <tr>
              <td style="background:${BRAND.blue900};padding:20px 28px;">
                <span style="color:#ffffff;font-size:20px;font-weight:bold;">Insight360</span><br/>
                <span style="color:${BRAND.blue200};font-size:12px;">${subtitle}</span>
              </td>
            </tr>
            <tr>
              <td style="background:${accentColor};height:4px;line-height:4px;font-size:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:28px;">${bodyHtml}</td>
            </tr>
            <tr>
              <td style="padding:14px 28px;background:${BRAND.slate50};border-top:1px solid ${BRAND.slate200};">
                <span style="color:#94a3b8;font-size:11px;">${new Date().toLocaleString('es-HN')} · Insight360, Monitoreo de Combustible</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function statusRow(label, value, opts = {}) {
  const { valueColor = BRAND.slate900, bold = true } = opts;
  return `
    <tr style="border-bottom:1px solid ${BRAND.slate200};">
      <td style="padding:8px 0;color:${BRAND.slate500};font-size:14px;">${label}</td>
      <td align="right" style="padding:8px 0;color:${valueColor};font-size:14px;font-weight:${bold ? 700 : 400};">${value}</td>
    </tr>
  `;
}

/**
 * Envía el correo de alerta de nivel bajo para un tanque, vía POST /v1/correo
 * de AuthServiceApi (EsHtml: true — ese endpoint ahora soporta HTML de forma
 * opcional, ver postCorreo).
 * @param {{name:string, id:number, stationName:string, volumeGallons:number, percent:number, capacityGallons:number|null}} tank
 */
async function sendLowLevelAlert(tank) {
  const subject = `⛽ Nivel bajo — ${tank.stationName} / Tanque ${tank.id} (${tank.name}): ${tank.percent.toFixed(1)}%`;
  // El umbral ya se cruzó para que esta función se dispare — un nivel de 10% o
  // menos se marca "crítico" (rojo) en vez de solo "bajo" (ámbar). tank.percent
  // es SIEMPRE percentFromUllage (veederClient.js) — la única fórmula de %, no
  // depende de que comb_capacidades esté bien cargada (ver monitor.js).
  const severityColor = tank.percent <= 10 ? BRAND.red600 : BRAND.amber600;
  const severityLabel = tank.percent <= 10 ? 'NIVEL CRÍTICO' : 'NIVEL BAJO';

  const capacityRow =
    tank.capacityGallons == null
      ? ''
      : statusRow('Capacidad (comb_capacidades)', `${tank.capacityGallons} gal`, { bold: false });

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:${severityColor}1a;color:${severityColor};font-size:12px;font-weight:bold;letter-spacing:0.5px;padding:5px 12px;border-radius:999px;">${severityLabel}</td>
      </tr>
    </table>
    <h1 style="margin:16px 0 4px;color:${BRAND.slate900};font-size:22px;">${tank.name} — ${tank.percent.toFixed(1)}%</h1>
    <p style="margin:0 0 20px;color:${BRAND.slate600};font-size:14px;line-height:1.5;">
      Tanque ${tank.id} de <b>${tank.stationName}</b> cayó por debajo del umbral de alerta configurado.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${statusRow('Estación', tank.stationName)}
      ${statusRow('Volumen actual', `${tank.volumeGallons.toFixed(0)} gal`)}
      ${capacityRow}
      ${statusRow('Nivel', `${tank.percent.toFixed(1)}%`, { valueColor: severityColor })}
    </table>
    <p style="margin:24px 0 0;padding:14px 16px;background:${BRAND.slate50};border-left:4px solid ${severityColor};color:#334155;font-size:13px;border-radius:0 4px 4px 0;">
      Se recomienda coordinar el reabastecimiento.
    </p>
  `;

  const mensaje = emailShell({ subtitle: 'Alerta de nivel bajo', accentColor: severityColor, bodyHtml: body });

  const destinatarios = process.env.MAIL_TO.split(',').map((email) => email.trim());
  await postCorreo({ destinatarios, asunto: subject, mensaje, isHtml: true });

  console.log(`[correo] Enviado a ${destinatarios.join(', ')} vía AuthServiceApi`);
}

/**
 * Envía un correo de prueba con el inventario de tanques de todas las estaciones
 * que respondieron, sin depender del umbral de alerta. Útil para validar que la
 * consulta a los Veeder-Root y el envío por AuthServiceApi funcionan de punta a
 * punta. HTML, una tabla por estación. Incluye capacidad (comb_capacidades) y %
 * (percentFromUllage, la misma fórmula que usa la alerta de nivel bajo).
 * @param {Array<{station:{name:string}, tanks:Array<{id:number, product:string, volumeGallons:number, tcVolumeGallons:number, ullageGallons:number, heightInches:number, waterInches:number, temperatureF:number, capacityGallons:number|null, percent:number|null}>}>} stationResults
 */
async function sendTestReport(stationResults) {
  const totalTanks = stationResults.reduce((sum, r) => sum + r.tanks.length, 0);

  const th = (label) =>
    `<th align="left" style="padding:8px 10px;color:${BRAND.slate500};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid ${BRAND.slate200};">${label}</th>`;
  const td = (value, align = 'left') =>
    `<td align="${align}" style="padding:8px 10px;color:${BRAND.slate900};font-size:13px;border-bottom:1px solid ${BRAND.slate200};">${value}</td>`;
  const pct = (value) => (value == null ? '—' : `${value.toFixed(1)}%`);

  const tablas = stationResults
    .map(({ station, tanks }, stationIndex) => {
      const filas = tanks
        .map(
          (t, i) => `
        <tr style="background:${i % 2 === 0 ? '#ffffff' : BRAND.slate50};">
          ${td(t.id)}
          ${td(t.product)}
          ${td(t.volumeGallons.toFixed(0), 'right')}
          ${td(t.tcVolumeGallons.toFixed(0), 'right')}
          ${td(t.ullageGallons.toFixed(0), 'right')}
          ${td(t.heightInches.toFixed(2), 'right')}
          ${td(t.waterInches.toFixed(2), 'right')}
          ${td(t.temperatureF.toFixed(1), 'right')}
          ${td(t.capacityGallons != null ? t.capacityGallons.toFixed(0) : '—', 'right')}
          ${td(pct(t.percent), 'right')}
        </tr>`
        )
        .join('');

      return `
        <h3 style="margin:${stationIndex === 0 ? '0' : '28px'} 0 10px;color:${BRAND.slate900};font-size:15px;">${station.name}</h3>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            ${th('Tanque')}${th('Producto')}${th('Volumen (gal)')}${th('Compensado (gal)')}${th('Vacío (gal)')}${th('Altura (in)')}${th('Agua (in)')}${th('Temp (°F)')}${th('Capacidad (gal)')}${th('% lleno')}
          </tr>
          ${filas}
        </table>`;
    })
    .join('');

  const subject = `🧪 Prueba de servicio — Inventario Veeder-Root (${stationResults.length} estaciones, ${totalTanks} tanques)`;
  const body = `
    <p style="margin:0 0 20px;color:${BRAND.slate600};font-size:14px;line-height:1.5;">
      Correo de prueba de conexión — no está atado al umbral de alerta de ningún tanque.
    </p>
    ${tablas}
  `;
  const mensaje = emailShell({ subtitle: 'Prueba de servicio', bodyHtml: body });

  const destinatarios = process.env.MAIL_TO.split(',').map((email) => email.trim());
  await postCorreo({ destinatarios, asunto: subject, mensaje, isHtml: true });

  console.log(`[correo] Prueba enviada a ${destinatarios.join(', ')} vía AuthServiceApi`);
}

module.exports = { sendLowLevelAlert, sendTestReport };
