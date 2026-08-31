const net = require('net');

/**
 * Cliente para consultar un Veeder-Root TLS-3xx / TLS-4 vía TCP/IP (puerto 10001 por defecto).
 *
 * IMPORTANTE — lee esto antes de usarlo en producción:
 * El comando de inventario de tanques es "I20100". El framing correcto para el
 * TLS-450 PLUS es <SOH> (0x01) al inicio y <ETX> (0x03) al final del comando —
 * confirmado contra un equipo real. Firmwares más viejos podían aceptar texto
 * plano + CR/LF, por eso queda disponible como alternativa vía `framing`.
 *
 * Antes de integrarlo, corre `npm run test:connection` y revisa la respuesta cruda
 * (rawResponse) que se imprime — con eso ajustamos el parser a tu formato exacto,
 * porque el layout de columnas puede variar según la configuración del sitio.
 */

const SOH = 0x01;
const ETX = 0x03;

class VeederRootClient {
  /**
   * `volumeUnit` es config por sitio, no del protocolo: el I20100 no dice en qué
   * unidad reporta, y confirmamos contra equipos reales que varía por estación
   * (ver src/config/stationVolumeUnits.json) — las Texaco vienen en litros, el
   * resto ya en galones. Default 'LITROS' porque tratar litros como si ya fueran
   * galones infla el nivel reportado y puede tapar una alerta real; al revés
   * (convertir de más) solo genera falsas alarmas, más seguro por defecto.
   */
  constructor({ host, port = 10001, timeoutMs = 8000, framing = 'soh-etx', volumeUnit = 'LITROS' } = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.framing = framing; // 'soh-etx' (TLS-450 PLUS) o 'plain' (texto + CR/LF)
    this.volumeUnit = volumeUnit; // 'LITROS' o 'GALONES'
  }

  /**
   * Envía un comando crudo y devuelve la respuesta como string.
   */
  _sendCommand(command) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = Buffer.alloc(0);
      let settled = false;

      const finish = (err, data) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(data);
      };

      socket.setTimeout(this.timeoutMs);

      socket.on('timeout', () => finish(new Error(`Timeout conectando a ${this.host}:${this.port}`)));
      socket.on('error', (err) => finish(err));

      socket.connect(this.port, this.host, () => {
        const payload =
          this.framing === 'plain'
            ? Buffer.from(command + '\r\n')
            : Buffer.concat([Buffer.from([SOH]), Buffer.from(command), Buffer.from([ETX])]);
        socket.write(payload);
      });

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        // Muchos controladores cierran la conexión al terminar de enviar,
        // o terminan la respuesta con ETX. Cubrimos ambos casos.
        if (buffer.includes(ETX)) {
          finish(null, buffer.toString('ascii'));
        }
      });

      socket.on('close', () => {
        if (!settled && buffer.length > 0) {
          finish(null, buffer.toString('ascii'));
        } else if (!settled) {
          finish(new Error('Conexión cerrada sin datos'));
        }
      });
    });
  }

  /**
   * Pide el inventario de todos los tanques (comando I20100).
   * Devuelve { rawResponse, tanks: [...] }
   */
  async getTankInventory() {
    const rawResponse = await this._sendCommand('I20100');
    const tanks = parseInventoryResponse(rawResponse, this.volumeUnit);
    return { rawResponse, tanks };
  }
}

/**
 * Parsea la respuesta típica del comando I20100.
 *
 * Formato de referencia (puede variar por firmware):
 *   TANK PRODUCT       VOLUME  TC VOLUME  ULLAGE  HEIGHT  WATER  TEMP
 *    1   UNL PLUS       1234      1230       766   45.23   0.00  70.5
 *    2   PREMIUM        2345      2300       655   50.10   0.00  71.2
 *
 * Ajusta esta regex si tu equipo entrega las columnas en otro orden.
 */
const LITERS_TO_GALLONS = 1 / 3.78541;

/**
 * `volumeUnit` viene del cliente (config por sitio, ver stationVolumeUnits.json) —
 * esta función solo aplica la conversión si corresponde, nunca la asume.
 */
function parseInventoryResponse(raw, volumeUnit = 'LITROS') {
  const factor = volumeUnit === 'GALONES' ? 1 : LITERS_TO_GALLONS;

  const lines = raw
    .replace(/[\x02\x03]/g, '') // quita STX/ETX si vinieran incluidos
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const tankLineRegex =
    /^(\d{1,2})\s+([A-Za-z0-9 .\-]+?)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/;

  const tanks = [];
  for (const line of lines) {
    const match = line.match(tankLineRegex);
    if (match) {
      const [, id, product, volume, tcVolume, ullage, height, water, temp] = match;
      tanks.push({
        id: Number(id),
        product: product.trim(),
        volumeGallons: Number(volume) * factor,
        tcVolumeGallons: Number(tcVolume) * factor,
        ullageGallons: Number(ullage) * factor,
        heightInches: Number(height),
        waterInches: Number(water),
        temperatureF: Number(temp),
      });
    }
  }

  return tanks;
}

module.exports = { VeederRootClient, parseInventoryResponse };
