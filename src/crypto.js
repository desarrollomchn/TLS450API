const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

// CREDENTIALS_ENCRYPTION_KEY debe ser una clave de 32 bytes en hex (64 caracteres).
// Generarla una sola vez con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// y guardarla SOLO en el .env del servidor — nunca en git, nunca en la base de datos.
function getKey() {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY no está configurada en el entorno.');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY debe ser una clave hex de 32 bytes (64 caracteres).');
  }
  return key;
}

// Cifra un texto plano (ej. la clave de un controlador VOX/Fusion). Devuelve los tres
// campos que van a comb_controladores_venta como VARBINARY: cipherText, iv, authTag.
function encrypt(plainText) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { cipherText, iv, authTag };
}

// Inverso de encrypt(). Lanza si authTag no valida (dato corrupto o clave incorrecta),
// en vez de devolver texto basura silenciosamente.
function decrypt({ cipherText, iv, authTag }) {
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return plainText.toString('utf8');
}

module.exports = { encrypt, decrypt };
