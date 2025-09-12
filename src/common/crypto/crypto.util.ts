import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const AAD = Buffer.from('danbooru-gateway'); // Associated Data for authenticity

/**
 * Encrypts plaintext using AES-256-GCM with a secret key.
 * Returns base64-encoded ciphertext (IV + authTag + encryptedData).
 * @param plaintext - The text to encrypt (e.g., query string)
 * @param secretKey - 32-byte secret key (from ENCRYPTION_KEY env var)
 * @returns Base64-encoded encrypted string
 * @throws Error if encryption fails
 */
export function encrypt(plaintext: string, secretKey: string): string {
  if (!secretKey || secretKey.length !== 64) { // Hex-encoded 32 bytes = 64 chars
    throw new Error('Invalid secret key: must be 32 bytes (64 hex chars)');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const keyBuffer = Buffer.from(secretKey, 'hex');
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  cipher.setAAD(AAD);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypts base64-encoded ciphertext using AES-256-GCM.
 * @param encryptedBase64 - Base64-encoded (IV + authTag + encryptedData)
 * @param secretKey - 32-byte secret key (from ENCRYPTION_KEY env var)
 * @returns Original plaintext
 * @throws Error if decryption fails (wrong key, corrupted data, etc.)
 */
export function decrypt(encryptedBase64: string, secretKey: string): string {
  if (!secretKey || secretKey.length !== 64) {
    throw new Error('Invalid secret key: must be 32 bytes (64 hex chars)');
  }

  const combined = Buffer.from(encryptedBase64, 'base64');
  if (combined.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = combined.slice(0, IV_LENGTH);
  const authTag = combined.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.slice(IV_LENGTH + TAG_LENGTH);

  const keyBuffer = Buffer.from(secretKey, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Generates a cryptographically secure 32-byte key as hex string.
 * Use this to create ENCRYPTION_KEY for .env (run once, store securely).
 * @returns 64-character hex string
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
