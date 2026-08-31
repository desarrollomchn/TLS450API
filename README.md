# Veeder-Root API + Notificaciones de nivel bajo

API en Node.js/Express que consulta en paralelo los controladores Veeder-Root
(TLS-3xx / TLS-4) de varias estaciones por TCP/IP, guarda el histórico de niveles
en SQL Server (base `MonteCristoBO`, compartida con BackOfficeApi), y envía un
correo al equipo de compras cuando algún tanque de alguna estación cae bajo el
umbral configurado.

## 1. Instalación

```bash
npm install
cp .env.example .env
```

Edita `.env` con:
- El puerto y timeout compartidos de conexión a los Veeder-Root (`VEEDER_PORT`,
  `VEEDER_TIMEOUT_MS`) — el host ya no se configura aquí, ver abajo.
- Los datos SMTP para el envío de correos.
- El correo de destino de compras (`MAIL_TO`).
- La conexión a SQL Server (`MSSQL_SERVER`, `MSSQL_INSTANCE`, `MSSQL_DATABASE`,
  `MSSQL_USER`, `MSSQL_PASSWORD`, `MSSQL_TRUST_SERVER_CERTIFICATE`).

### Estaciones y capacidades: 100% en base de datos, no en archivos de config

Este proceso atiende **varias estaciones en un solo proceso**, una conexión TCP
propia por cada una. Al arrancar, resuelve dinámicamente la lista de estaciones
activas con:

```sql
SELECT ce.Id, ce.Host, ge.Nombre
FROM comb_estaciones ce
INNER JOIN gen_estaciones ge ON ge.Id = ce.EstacionId
WHERE ce.Activo = 1
```

Es decir: **toda estación `Activo = 1` en `comb_estaciones` se agrega sola**,
sin tocar código ni redeployar — hoy son las 10 estaciones con Veeder-Root real
instalado (confirmado contra el inventario de controladores). Ya no se filtra
por marca (`Nombre LIKE 'TEXACO%'`): ese filtro era solo un guardarraíl temporal
del rollout inicial, cuando solo 5 de las 10 estaciones con hardware ya estaban
confirmadas. `comb_estaciones` en sí ya solo contiene estaciones con Veeder-Root
funcionando, así que `Activo = 1` alcanza.

La capacidad de cada tanque (en galones, por estación y producto) vive en la
tabla `comb_capacidades` (`EstacionId`, `Producto`, `CapacidadGalones`) — ver
`sql/005_recreate_comb_capacidades.sql` y `sql/006_seed_comb_capacidades_full.sql`.
`EstacionId` es `gen_estaciones.Id`, **no** `comb_estaciones.Id`: la capacidad
es una propiedad de la estación física, independiente de si ya tiene hardware
Veeder-Root instalado, así que cubre las 34 estaciones de combustible reales
(no solo las 10 monitoreadas activamente). Al sembrar `comb_tanques` para una
estación activa, `src/db.js` resuelve la capacidad con un join adicional
`comb_estaciones.EstacionId -> comb_capacidades.EstacionId`. Se edita
directamente en la base de datos cuando cambie una capacidad real; el proceso
nunca hardcodea ni asume una capacidad. Si un producto reportado por un
Veeder-Root no tiene fila en `comb_capacidades`, ese tanque se registra sin
capacidad (o se omite la siembra) y queda un warning en el log — nunca se
inventa un número.

`comb_estaciones`, `comb_tanques`, `comb_lecturas`, `comb_alertas` y
`comb_capacidades` son tablas compartidas — este servicio solo lee/escribe
filas, no altera su esquema (ver `sql/001_create_comb_tables.sql` y
`sql/005_recreate_comb_capacidades.sql`).

`comb_tanques` (nombre, capacidad, TankNumber) se siembra/corrige automáticamente
la primera vez que cada estación responde con éxito en este proceso — no es un
paso previo al arranque, así una estación offline hoy no bloquea a las demás; se
sembrará sola en cuanto vuelva a responder.

## 2. Antes de correr el servidor: probar la conexión

El protocolo de Veeder-Root varía ligeramente según el modelo/firmware, así que el
primer paso siempre es verificar qué está devolviendo tu equipo. Como ahora el
host ya no vive en `.env` (hay varias estaciones, cada una con el suyo en
`comb_estaciones.Host`), pásalo como argumento:

```bash
npm run test:connection -- 192.168.14.56
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
- Un cron interno que consulta **todas** las estaciones activas en paralelo
  (`Promise.allSettled`, una conexión TCP por estación) cada
  `POLL_INTERVAL_MINUTES` minutos, guarda la lectura de cada una, y envía correo
  si algún tanque de alguna estación está bajo el umbral. Una estación caída u
  offline se registra en el log y **no** detiene el sondeo de las demás.

## 4. Endpoints

Todos (menos `/health`) requieren `Authorization: Bearer <token>` (ver sección de
autenticación en `.env.example`).

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/stations` | Estaciones activas (todas las que tienen Veeder-Root, sin filtro de marca): `[{ id, name }]` (`id` = `comb_estaciones.Id`) |
| GET | `/tanks?stationId=` | Última lectura de cada tanque de la estación, con % de nivel calculado. `stationId` es opcional, por defecto `7` (Victoria) para no romper llamadas existentes |
| GET | `/tanks/:id/history?stationId=&limit=100` | Histórico de lecturas de un tanque (`:id` = `TankNumber`, único solo dentro de una estación — por eso `stationId` importa aquí también). `stationId` opcional, mismo default `7` |
| POST | `/tanks/check-now?stationId=` | Sin `stationId`: fuerza una consulta a **todas** las estaciones. Con `stationId`: solo esa estación |
| GET | `/health` | Estado del servicio (sin autenticación) |

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

- Agregar más canales de notificación (Slack/WhatsApp) reutilizando la misma
  lógica de `monitor.js` (solo hace falta otro módulo como `notifier.js`).
- Agregar un dashboard simple que consuma `/stations`, `/tanks` y
  `/tanks/:id/history` con un selector de estación.
