// Cliente HTTP para el Gilbarco VOX Forecourt Controller — scraping del frontend web
// legacy (no expone API/JSON, todo es PHP server-rendered). Reverse-engineered contra
// una unidad real (estación "TEXACO David", 192.168.3.55) con autorización.
//
// No hay paginación del lado de VOX: el reporte de despachos devuelve el rango de
// fechas completo en una sola respuesta. La paginación, si se necesita, se hace acá
// (sobre el array de records ya parseado), no contra el equipo.

const DATE_FORMAT_REGEX = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;

// Ninguno de los fetch() contra VOX tenía timeout — si el equipo se cuelga de
// verdad (no solo "lento"), el proceso Node quedaba esperando para siempre, sin
// que el caller (getDispatchReport, y arriba de eso la ruta /dispatches) tuviera
// forma de enterarse. Estos son solo la red de seguridad contra un cuelgue real,
// no un límite ajustado al caso normal: un rango de 24hs con mucho tráfico midió
// 151s de punta a punta en la práctica (TEXACO La Curva, 1374 registros), así que
// FETCH_REPORT_TIMEOUT_MS queda con margen amplio sobre eso. login/fetchAllConfig
// piden páginas chicas (no el reporte pesado) y no deberían tardar ni cerca de eso.
const FETCH_LOGIN_TIMEOUT_MS = 30_000;
const FETCH_REPORT_TIMEOUT_MS = 240_000;

function formatVoxDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').trim();
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return undefined;
  const match = setCookie.match(/PHPSESSID=[^;]+/);
  return match ? match[0] : undefined;
}

function looksLikeLoginPage(html) {
  // Sesión vencida (o credenciales inválidas): VOX redirige silenciosamente al login,
  // sin devolver un HTTP error — hay que detectarlo mirando el contenido.
  return html.includes('name="password"') && html.includes('name="username"');
}

/**
 * Login contra VOX. Devuelve la cookie de sesión (PHPSESSID=...) para reusar en
 * requests siguientes. Lanza si las credenciales no son válidas.
 */
async function login(ip, usuario, password) {
  const base = `http://${ip}`;

  const loginResponse = await fetch(`${base}/loginresults.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: usuario,
      password: password,
      submitted: '1',
      lastPage: 'index.php',
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_LOGIN_TIMEOUT_MS),
  });

  const cookie = extractCookie(loginResponse);
  if (!cookie) {
    throw new Error(`VOX (${ip}): login no devolvió cookie de sesión — credenciales inválidas.`);
  }

  return cookie;
}

/**
 * Lee los checkboxes de producto y surtidor realmente presentes en el formulario
 * — no todas las estaciones tienen los mismos productos (algunas tienen KEROSENE
 * además de SUPER/REGULAR/DIESEL) ni la misma cantidad de surtidores (algunas
 * tienen más de 6), así que asumir una lista/cantidad fija dejaba productos y
 * surtidores reales fuera de cualquier consulta que no los pidiera explícito
 * (incluida la consulta "traer todo" cuando no se manda ningún filtro).
 */
function parseFormOptions(html) {
  const productos = [...html.matchAll(/name="checkboxesDispRepProd(\d+)"[^>]*>\s*([^\s<]+)/g)].map((m) => ({
    index: Number(m[1]),
    nombre: m[2],
  }));
  const pumpIndexes = [...html.matchAll(/name="checkboxesDispRepPump(\d+)"/g)].map((m) => Number(m[1]));
  return { productos, pumpIndexes };
}

/**
 * Extrae el bloque hidden "allConfig" del formulario de reporte de despachos, junto
 * con los productos/surtidores reales de esta estación (ver parseFormOptions).
 * Es estable entre sesiones (confirmado empíricamente) pero se re-obtiene fresco en
 * cada llamada para no depender de eso — el costo extra es una sola request GET.
 * OJO: la página trae DOS campos allConfig (uno por cada <form> de la pantalla) con
 * el mismo valor — hay que tomar solo el primero, nunca concatenarlos.
 */
async function fetchAllConfig(ip, cookie) {
  const response = await fetch(`http://${ip}/dispatchsreport.php`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(FETCH_LOGIN_TIMEOUT_MS),
  });
  const html = await response.text();

  if (looksLikeLoginPage(html)) {
    return { sessionExpired: true };
  }

  const match = html.match(/name="allConfig" value="([^"]*)"/);
  if (!match) {
    throw new Error('No se encontró el campo allConfig en dispatchsreport.php — ¿cambió el frontend de VOX?');
  }
  return { sessionExpired: false, allConfig: match[1], formOptions: parseFormOptions(html) };
}

function parseSummary(html) {
  const ventasSinControlMatch = html.match(/Cantidad de Ventas Sin Control:<\/th><td>([^<]*)<\/td>/);
  const cantidadDespachosMatch = html.match(/Cantidad de Despachos:<\/th><td>([^<]*)<\/td>/);
  return {
    ventasSinControl: ventasSinControlMatch ? Number(ventasSinControlMatch[1]) : 0,
    cantidadDespachos: cantidadDespachosMatch ? Number(cantidadDespachosMatch[1]) : 0,
  };
}

function parseDispatchTable(html) {
  if (html.includes('No se obtuvieron reportes')) {
    return { records: [], totals: { monto: 0, volumen: 0 }, ...parseSummary(html) };
  }

  const tableMatch = html.match(/id="tableDispatchsReport"[\s\S]*?<\/table>/);
  if (!tableMatch) {
    throw new Error('No se encontró la tabla de despachos en la respuesta — ¿cambió el frontend de VOX?');
  }
  const tableHtml = tableMatch[0];

  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);

  const records = [];
  let totals = { monto: 0, volumen: 0 };

  for (const row of rows) {
    const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => stripTags(m[1]));

    if (cells[0] === 'Totales Generales:') {
      totals = { monto: Number(cells[1]) || 0, volumen: Number(cells[2]) || 0 };
      continue;
    }

    if (cells.length >= 8 && /^\d{2}\/\d{2}\/\d{4}/.test(cells[0])) {
      records.push({
        fechaHora: cells[0],
        surtidor: cells[1],
        producto: cells[2],
        tipoPago: cells[3],
        monto: Number(cells[4]) || 0,
        volumen: Number(cells[5]) || 0,
        ppu: Number(cells[6]) || 0,
        densidad: Number(cells[7]) || 0,
      });
    }
  }

  return { records, totals, ...parseSummary(html) };
}

/**
 * Pide el reporte de despachos a VOX para un rango de fechas. `from`/`to` son Date.
 * No pagina del lado del servidor: siempre devuelve el rango completo.
 *
 * `formOptions` (de fetchAllConfig/parseFormOptions) son los productos/surtidores
 * REALES de esta estación — nunca se asume una lista/cantidad fija, porque varía
 * por estación (algunas tienen KEROSENE, algunas tienen más de 6 surtidores).
 * `productos` (nombres, ej. ['SUPER','DIESEL']) y `surtidores` (números, 1-based)
 * filtran qué checkboxes de esa lista real se tildan — si se omiten (undefined),
 * se tildan todos los que la estación realmente tiene.
 */
async function fetchDispatchReport(ip, cookie, allConfig, formOptions, from, to, { productos, surtidores } = {}) {
  const params = new URLSearchParams();
  params.set('timestampFrom', formatVoxDate(from));
  params.set('timestampTo', formatVoxDate(to));

  // Checkboxes reales (value="0","1",... por cada uno) — VOX los ignora silenciosamente
  // si se manda "on" en vez del valor exacto (ver memoria: no devuelve error, devuelve
  // "No se obtuvieron reportes." como si no hubiera datos).
  const productIndexes = productos
    ? formOptions.productos
        .filter((p) => productos.some((wanted) => wanted.toUpperCase() === p.nombre.toUpperCase()))
        .map((p) => p.index)
    : formOptions.productos.map((p) => p.index);
  const pumpIndexes = surtidores
    ? surtidores.map((n) => n - 1).filter((i) => formOptions.pumpIndexes.includes(i))
    : formOptions.pumpIndexes;

  for (const i of productIndexes) params.set(`checkboxesDispRepProd${i}`, String(i));
  for (const i of pumpIndexes) params.set(`checkboxesDispRepPump${i}`, String(i));
  for (let i = 0; i <= 6; i += 1) params.set(`checkboxesDispRepWDays${i}`, String(i));

  params.set('allConfig', allConfig);
  params.set('lastPage', 'dispatchsreport.php');

  const response = await fetch(`http://${ip}/dispatchsreportresults.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: params,
    signal: AbortSignal.timeout(FETCH_REPORT_TIMEOUT_MS),
  });

  const html = await response.text();
  if (looksLikeLoginPage(html)) {
    return { sessionExpired: true };
  }

  return { sessionExpired: false, ...parseDispatchTable(html) };
}

/**
 * Login + fetchAllConfig + fetchDispatchReport, con UN reintento automático si la
 * sesión resulta vencida (vuelve a loguearse y repite la secuencia una sola vez).
 */
async function getDispatchReport({ ip, usuario, password }, from, to, filters = {}) {
  if (!DATE_FORMAT_REGEX.test(formatVoxDate(from)) || !DATE_FORMAT_REGEX.test(formatVoxDate(to))) {
    throw new Error('Rango de fechas inválido.');
  }

  let cookie = await login(ip, usuario, password);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const configResult = await fetchAllConfig(ip, cookie);
    if (configResult.sessionExpired) {
      cookie = await login(ip, usuario, password);
      continue;
    }

    const reportResult = await fetchDispatchReport(ip, cookie, configResult.allConfig, configResult.formOptions, from, to, filters);
    if (reportResult.sessionExpired) {
      cookie = await login(ip, usuario, password);
      continue;
    }

    const { sessionExpired, ...report } = reportResult;
    return report;
  }

  throw new Error(`VOX (${ip}): la sesión se venció incluso después de reintentar el login.`);
}

module.exports = { login, getDispatchReport };
