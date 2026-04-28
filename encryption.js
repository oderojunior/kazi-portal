// src/utils/encryption.js
// AES-256-GCM for encrypting sensitive fields (ID scan S3 keys, audit metadata)
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes

if (KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes)');
}

/**
 * Encrypt plaintext string → base64 encoded "iv:authTag:ciphertext"
 */
const encrypt = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString('base64')).join(':');
};

/**
 * Decrypt "iv:authTag:ciphertext" → plaintext string
 */
const decrypt = (payload) => {
  const [ivB64, tagB64, encB64] = payload.split(':');
  const iv       = Buffer.from(ivB64,  'base64');
  const authTag  = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};

/**
 * SHA-256 hash for audit trail (non-reversible)
 */
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

module.exports = { encrypt, decrypt, hash };
