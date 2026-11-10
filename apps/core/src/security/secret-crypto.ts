import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class SecretCryptoError extends Error {
  constructor() {
    super('Secret cryptography operation failed.');
    this.name = 'SecretCryptoError';
  }
}

// Strict identifiers avoid normalization aliases; the tenant alphabet matches Core.
// JSON tuple framing makes tenant/purpose boundaries unambiguous in authenticated data.
function authenticatedContext(key: Buffer, tenantId: string, purpose: string): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32 ||
      typeof tenantId !== 'string' || tenantId.trim() !== tenantId || !/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId) ||
      typeof purpose !== 'string' || purpose.trim() !== purpose || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(purpose)) {
    throw new SecretCryptoError();
  }
  return Buffer.from(JSON.stringify(['secret-crypto', 'v1', tenantId, purpose]), 'utf8');
}

function decodeHex(value: string, bytes?: number): Buffer {
  if (/[^0-9a-f]/.test(value) || value.length % 2 !== 0 || (bytes !== undefined && value.length !== bytes * 2)) {
    throw new SecretCryptoError();
  }
  return Buffer.from(value, 'hex');
}

/** Binary-safe, storage-free envelope: v1.<12-byte nonce hex>.<16-byte tag hex>.<ciphertext hex>.
 * Caller owns key storage and lifecycle. No key or tenant metadata is stored in the envelope.
 */
export function encryptSecret(plaintext: Buffer, key: Buffer, tenantId: string, purpose: string): string {
  try {
    const aad = authenticatedContext(key, tenantId, purpose);
    if (!Buffer.isBuffer(plaintext)) throw new SecretCryptoError();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return ['v1', nonce.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join('.');
  } catch {
    // Never attach a cause: upstream errors may carry caller data.
    throw new SecretCryptoError();
  }
}

/** Returns plaintext only after GCM authentication has succeeded. */
export function decryptSecret(envelope: string, key: Buffer, tenantId: string, purpose: string): Buffer {
  try {
    const aad = authenticatedContext(key, tenantId, purpose);
    if (typeof envelope !== 'string') throw new SecretCryptoError();
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new SecretCryptoError();
    const nonce = decodeHex(parts[1], 12);
    const tag = decodeHex(parts[2], 16);
    const ciphertext = decodeHex(parts[3]);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SecretCryptoError();
  }
}
