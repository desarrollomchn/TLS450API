const swaggerJsdoc = require('swagger-jsdoc');
const path = require('path');
const { version } = require('../package.json');

/**
 * Genera el spec OpenAPI 3.0 leyendo los bloques @openapi ubicados como comentarios
 * JSDoc directamente encima de cada app.METHOD(...) en server.js. Si en el futuro
 * las rutas se separan en más archivos, agregar sus paths acá (`apis`).
 */
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'TLS450Api',
      version,
      description:
        'API para monitoreo de niveles de combustible (Veeder-Root TLS-3xx/TLS-4) y ' +
        'consulta de datos de despacho de bombas (controlador de venta Gilbarco VOX) ' +
        'en las estaciones de Grupo Montecristo. Guarda histórico de lecturas de tanque ' +
        'en SQL Server y notifica por correo cuando un tanque baja de su umbral de alerta.',
    },
    servers: [{ url: '/', description: 'Servidor actual' }],
    tags: [
      { name: 'Tanques', description: 'Niveles de combustible por tanque (Veeder-Root)' },
      { name: 'Estaciones', description: 'Estaciones, su configuración de bombas y su controlador de venta' },
      { name: 'Despachos', description: 'Reportes de despacho de bomba (Gilbarco VOX)' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'JWT RS256 emitido por AuthServiceApi (audience "tls450"), validado contra su JWKS. ' +
            'Todas las rutas lo requieren excepto /health.',
        },
      },
      schemas: {
        TankReading: {
          type: 'object',
          description: 'Lectura de un tanque (última guardada en /tanks, o en vivo en /tanks/live). Los campos de lectura vienen en null para un tanque provisional que todavía no fue confirmado por su Veeder-Root.',
          properties: {
            idTanque: { type: 'integer', description: 'TankNumber del Veeder-Root (identidad del tanque dentro de la estación).', example: 2 },
            nombre: { type: 'string', description: 'Nombre/producto del tanque.', example: 'Diesel' },
            volumenGalones: { type: 'number', nullable: true, example: 4820.5 },
            capacidadGalones: { type: 'number', nullable: true, example: 8000 },
            porcentaje: { type: 'number', nullable: true, description: 'volumenGalones / capacidadGalones * 100, redondeado a 1 decimal.', example: 60.3 },
            umbralAlertaPorcentaje: { type: 'number', nullable: true, description: 'Umbral (%) configurado para disparar la alerta de nivel bajo.', example: 20 },
            temperaturaF: { type: 'number', nullable: true, example: 68.4 },
            aguaPulgadas: { type: 'number', nullable: true, example: 0 },
            ultimaActualizacion: { type: 'string', format: 'date-time', nullable: true, description: 'Fecha de la lectura (UTC). null si el tanque nunca fue poleado.', example: '2026-09-16T14:32:00.000Z' },
          },
        },
        TankHistoryEntry: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 15234 },
            idTanque: { type: 'integer', example: 2 },
            producto: { type: 'string', example: 'DIESEL' },
            volumenGalones: { type: 'number', example: 4820.5 },
            alturaPulgadas: { type: 'number', example: 48.2 },
            aguaPulgadas: { type: 'number', example: 0 },
            temperaturaF: { type: 'number', example: 68.4 },
            fecha: { type: 'string', format: 'date-time', example: '2026-09-16T14:32:00.000Z' },
          },
        },
        Station: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'EstacionId (gen_estaciones.Id).', example: 4 },
            name: { type: 'string', example: 'Victoria' },
            tieneVeederRoot: { type: 'boolean', description: 'Si la estación tiene un Veeder-Root activo (comb_estaciones).' },
            tieneControladorVenta: { type: 'boolean', description: 'Si la estación tiene un controlador de venta activo (comb_controladores_venta).' },
          },
        },
        PumpConfig: {
          type: 'object',
          description: 'Productos y surtidores reales de una estación, sincronizados desde Business Central (comb_bombas/comb_bahias).',
          properties: {
            productos: { type: 'array', items: { type: 'string' }, example: ['DIESEL', 'REGULAR', 'SUPER'] },
            surtidores: { type: 'array', items: { type: 'integer' }, example: [1, 2, 3, 4, 5, 6] },
          },
        },
        DispatchRecord: {
          type: 'object',
          properties: {
            fechaHora: { type: 'string', format: 'date-time', example: '2026-09-16T08:15:00.000Z' },
            surtidor: { type: 'string', example: '3' },
            producto: { type: 'string', example: 'DIESEL' },
            tipoPago: { type: 'string', example: 'EFECTIVO' },
            monto: { type: 'number', example: 450.75 },
            volumen: { type: 'number', example: 32.1 },
            ppu: { type: 'number', description: 'Precio por unidad.', example: 14.04 },
            densidad: { type: 'number', example: 0.832 },
          },
        },
        DispatchesResponse: {
          type: 'object',
          properties: {
            records: { type: 'array', items: { $ref: '#/components/schemas/DispatchRecord' } },
            totales: {
              type: 'object',
              properties: {
                monto: { type: 'number', example: 125430.5 },
                volumen: { type: 'number', example: 8920.44 },
              },
            },
            ventasSinControl: { type: 'number', description: 'Total de ventas sin control detectadas en el rango.', example: 0 },
            cantidadDespachos: { type: 'integer', example: 342 },
            totalRegistros: { type: 'integer', description: 'Cantidad de registros en `records` (el set completo del rango; el frontend pagina del lado del cliente).', example: 342 },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Mensaje de error en español.' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [path.join(__dirname, 'server.js')],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
