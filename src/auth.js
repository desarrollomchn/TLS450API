const https = require('https');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

/**
 * Valida los JWT emitidos por AuthServiceApi contra su JWKS.
 * Mismo esquema que usa BackOfficeApi: RS256, issuer/audience fijos
 * (audience = nombre de la aplicación registrada, "tls450" en este caso).
 */
const client = jwksClient({
  jwksUri: process.env.AUTH_JWKS_URI,
  requestHeaders: {},
  timeout: 8000,
  requestAgent:
    process.env.AUTH_ALLOW_INSECURE_TLS === 'true'
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Falta el token de autenticación (Bearer)' });
  }

  jwt.verify(
    token,
    getSigningKey,
    {
      algorithms: ['RS256'],
      issuer: process.env.AUTH_ISSUER,
      audience: process.env.AUTH_AUDIENCE,
    },
    (err, decoded) => {
      if (err) {
        return res.status(401).json({ error: 'Token inválido o expirado', detail: err.message });
      }
      req.user = decoded;
      next();
    }
  );
}

module.exports = { requireAuth };
