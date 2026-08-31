# Veeder-Root API + Notificaciones de nivel bajo

API en Node.js/Express que consulta un controlador Veeder-Root (TLS-3xx / TLS-4) por
TCP/IP, guarda el histórico de niveles en SQL Server (base `MonteCristoBO`, compartida
con BackOfficeApi), y envía un correo al equipo de compras cuando algún tanque cae
bajo el umbral configurado.

## 1. Instalación

```bash
npm install
cp .env.example .env
```

Edita `.env` con:
- La IP y puerto del Veeder-Root (por defecto el puerto TCP es **10001**).
- Los datos SMTP para el envío de correos.
- El correo de destino de compras (`MAIL_TO`).
- La conexión a SQL Server (`MSSQL_SERVER`, `MSSQL_INSTANCE`, `MSSQL_DATABASE`,
  `MSSQL_USER`, `MSSQL_PASSWORD`, `MSSQL_TRUST_SERVER_CERTIFICATE`).
- `STATION_HOST`: el mismo host del Veeder-Root, usado para resolver la fila de
  `comb_estaciones` que identifica esta estación.

Edita `src/config/tanks.json` con los tanques reales de tu sitio: id, nombre,
capacidad en galones y el umbral de alerta (%) de cada uno. Al arrancar, el
proceso siembra (upsert, sin duplicar) una fila en `comb_tanques` por cada
tanque de este archivo, asociada a la estación resuelta por `STATION_HOST`.

Este proceso atiende **una sola estación / un solo Veeder-Root por instancia**
(no hace polling multi-estación); `comb_estaciones`, `comb_tanques`,
`comb_lecturas` y `comb_alertas` son tablas compartidas — este servicio solo
lee/escribe filas, no las crea ni las altera (ver `sql/001_create_comb_tables.sql`).

## 2. Antes de correr el servidor: probar la conexión

El protocolo de Veeder-Root varía ligeramente según el modelo/firmware, así que el
primer paso siempre es verificar qué está devolviendo tu equipo:

```bash
npm run test:connection
```

Esto imprime la **respuesta cruda** del Veeder-Root y lo que el parser logró
interpretar. Si la tabla sale vacía, copia la respuesta cruda (rawResponse) y
ajustamos la expresión regular en `src/veederClient.js` (función
`parseInventoryResponse`) — el formato de columnas puede no coincidir exactamente
con el de referencia que dejé documentado ahí.

Si tu equipo requiere el framing con bytes STX/ETX (0x02/0x03) en vez de texto
plano + CR/LF, actívalo así:

```js
new VeederRootClient({ host, port, useStxEtxFraming: true })
```

## 3. Correr la API

```bash
npm start
```

Esto levanta:
- La API REST en `http://localhost:3000`
- Un cron interno que consulta el Veeder-Root cada `POLL_INTERVAL_MINUTES`
  minutos, guarda la lectura, y envía correo si algún tanque está bajo el umbral.

## 4. Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/tanks` | Última lectura de cada tanque, con % de nivel calculado |
| GET | `/tanks/:id/history?limit=100` | Histórico de lecturas de un tanque |
| POST | `/tanks/check-now` | Fuerza una consulta inmediata (útil para pruebas) |
| GET | `/health` | Estado del servicio |

## 5. Cómo funciona el anti-spam de alertas

Si un tanque sigue bajo el umbral en consultas consecutivas, **no** se reenvía un
correo cada vez — solo se vuelve a notificar después de `ALERT_COOLDOWN_HOURS`
horas (configurable en `.env`). Esto evita saturar el buzón de compras.

## 6. Notas sobre el protocolo Veeder-Root

- Comando usado: `I20100` (inventario de tanques).
- Puerto TCP por defecto: `10001`.
- El parser asume una tabla con columnas: tanque, producto, volumen, volumen
  compensado por temperatura, ullage, altura, agua, temperatura. Esto es el
  formato más común mostrado en la documentación pública del TLS-350, pero
  **confírmalo contra la salida real de tu equipo** con `npm run test:connection`.
- Si prefieres no exponer el Veeder-Root directamente a la red donde corre este
  servicio, puedes correr este proyecto en una máquina/Raspberry Pi dentro de la
  misma red local que el controlador.

## 7. Siguientes pasos sugeridos

- Agregar autenticación a la API si se va a exponer fuera de la red local.
- Agregar más canales de notificación (Slack/WhatsApp) reutilizando la misma
  lógica de `monitor.js` (solo hace falta otro módulo como `notifier.js`).
- Agregar un dashboard simple que consuma `/tanks` y `/tanks/:id/history`.
