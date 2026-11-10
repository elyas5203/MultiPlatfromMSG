import {
  SecretCryptoError,
  decryptSecret,
  encryptSecretV2,
  decryptSecretV2,
} from './secret-crypto';

export { SecretCryptoError };

export class KeyRingError extends SecretCryptoError {}

export interface KeyRingEntry {
  id: string;
  key: string | Buffer;
}

export interface KeyRingConfig {
  activeKeyId: string;
  keys: KeyRingEntry[] | Record<string, string | Buffer>;
}

function validateKeyId(id: unknown): string {
  if (typeof id !== 'string' || id.trim() !== id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new SecretCryptoError();
  }
  return id;
}

function parseKeyBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 32) {
      throw new SecretCryptoError();
    }
    return Buffer.from(raw);
  }
  if (typeof raw !== 'string') {
    throw new SecretCryptoError();
  }
  const trimmed = raw.trim();
  const isBase64 = /^[A-Za-z0-9+/]{43}=$/.test(trimmed);
  const isBase64Url = /^[A-Za-z0-9_-]{43}=?$/.test(trimmed);
  if (!isBase64 && !isBase64Url) {
    throw new SecretCryptoError();
  }
  const buf = Buffer.from(trimmed, isBase64Url ? 'base64url' : 'base64');
  if (buf.length !== 32) {
    throw new SecretCryptoError();
  }
  if (isBase64 && buf.toString('base64') !== trimmed) {
    throw new SecretCryptoError();
  }
  return buf;
}

function parseObjectConfig(obj: any): { activeKeyId: string; keys: Map<string, Buffer> } {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SecretCryptoError();
  }

  const activeKeyId = validateKeyId(obj.activeKeyId);
  const keysMap = new Map<string, Buffer>();

  if (Array.isArray(obj.keys)) {
    if (obj.keys.length === 0) {
      throw new SecretCryptoError();
    }
    for (const item of obj.keys) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new SecretCryptoError();
      }
      const id = validateKeyId(item.id);
      if (keysMap.has(id)) {
        throw new SecretCryptoError();
      }
      const keyBuf = parseKeyBuffer(item.key);
      keysMap.set(id, keyBuf);
    }
  } else if (typeof obj.keys === 'object' && obj.keys !== null) {
    const entries = Object.entries(obj.keys);
    if (entries.length === 0) {
      throw new SecretCryptoError();
    }
    for (const [idStr, keyVal] of entries) {
      const id = validateKeyId(idStr);
      if (keysMap.has(id)) {
        throw new SecretCryptoError();
      }
      const keyBuf = parseKeyBuffer(keyVal);
      keysMap.set(id, keyBuf);
    }
  } else {
    throw new SecretCryptoError();
  }

  if (!keysMap.has(activeKeyId)) {
    throw new SecretCryptoError();
  }

  return { activeKeyId, keys: keysMap };
}

function parseDelimitedConfig(str: string): { activeKeyId: string; keys: Map<string, Buffer> } {
  const parts = str.split(/[;\n]/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new SecretCryptoError();
  }

  let activeKeyId: string | undefined;
  const keysMap = new Map<string, Buffer>();

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    const colonIdx = part.indexOf(':');
    let separatorIndex = -1;
    if (eqIdx !== -1 && colonIdx !== -1) {
      separatorIndex = Math.min(eqIdx, colonIdx);
    } else if (eqIdx !== -1) {
      separatorIndex = eqIdx;
    } else {
      separatorIndex = colonIdx;
    }

    if (separatorIndex === -1) {
      if (!activeKeyId) {
        activeKeyId = validateKeyId(part);
      } else {
        throw new SecretCryptoError();
      }
    } else {
      const k = part.slice(0, separatorIndex).trim();
      const v = part.slice(separatorIndex + 1).trim();
      if (k.toLowerCase() === 'active' || k.toLowerCase() === 'activekeyid') {
        if (activeKeyId !== undefined) {
          throw new SecretCryptoError();
        }
        activeKeyId = validateKeyId(v);
      } else {
        const id = validateKeyId(k);
        if (keysMap.has(id)) {
          throw new SecretCryptoError();
        }
        const keyBuf = parseKeyBuffer(v);
        keysMap.set(id, keyBuf);
      }
    }
  }

  if (!activeKeyId || keysMap.size === 0 || !keysMap.has(activeKeyId)) {
    throw new SecretCryptoError();
  }

  return { activeKeyId, keys: keysMap };
}

function parseConfig(raw: string | KeyRingConfig): { activeKeyId: string; keys: Map<string, Buffer> } {
  try {
    if (!raw) {
      throw new SecretCryptoError();
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) {
        throw new SecretCryptoError();
      }

      if (trimmed.startsWith('{')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new SecretCryptoError();
        }
        return parseObjectConfig(parsed);
      }

      return parseDelimitedConfig(trimmed);
    }

    if (typeof raw === 'object' && raw !== null) {
      return parseObjectConfig(raw);
    }

    throw new SecretCryptoError();
  } catch {
    throw new SecretCryptoError();
  }
}

export class KeyRing {
  private readonly keys: Map<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(config: KeyRingConfig | string) {
    const parsed = parseConfig(config);
    this.keys = parsed.keys;
    this.activeKeyId = parsed.activeKeyId;
  }

  static fromEnv(raw: string): KeyRing {
    return new KeyRing(raw);
  }

  static fromConfig(config: KeyRingConfig | string): KeyRing {
    return new KeyRing(config);
  }

  getActiveKeyId(): string {
    return this.activeKeyId;
  }

  getKeyIds(): string[] {
    return Array.from(this.keys.keys());
  }

  hasKey(keyId: string): boolean {
    return typeof keyId === 'string' && this.keys.has(keyId);
  }

  encrypt(plaintext: Buffer, tenantId: string, purpose: string): string {
    const activeKey = this.keys.get(this.activeKeyId);
    if (!activeKey) {
      throw new SecretCryptoError();
    }
    return encryptSecretV2(plaintext, activeKey, this.activeKeyId, tenantId, purpose);
  }

  decrypt(envelope: string, tenantId: string, purpose: string): Buffer {
    if (typeof envelope !== 'string') {
      throw new SecretCryptoError();
    }

    const parts = envelope.split('.');

    // Version 2 envelope: v2.<keyId>.<12-byte nonce hex>.<16-byte tag hex>.<ciphertext hex>
    if (parts.length === 5 && parts[0] === 'v2') {
      const keyId = parts[1];
      const key = this.keys.get(keyId);
      if (!key) {
        throw new SecretCryptoError();
      }
      return decryptSecretV2(envelope, key, keyId, tenantId, purpose);
    }

    // Version 1 envelope (TASK-0014 backward compatibility): v1.<nonce hex>.<tag hex>.<ciphertext hex>
    if (parts.length === 4 && parts[0] === 'v1') {
      const activeKey = this.keys.get(this.activeKeyId);
      if (activeKey) {
        try {
          return decryptSecret(envelope, activeKey, tenantId, purpose);
        } catch {
          // Fall through to try other keys in ring
        }
      }
      for (const [keyId, key] of this.keys.entries()) {
        if (keyId === this.activeKeyId) continue;
        try {
          return decryptSecret(envelope, key, tenantId, purpose);
        } catch {
          // Continue trying next key
        }
      }
      throw new SecretCryptoError();
    }

    throw new SecretCryptoError();
  }

  reencrypt(envelope: string, tenantId: string, purpose: string): string {
    const plaintext = this.decrypt(envelope, tenantId, purpose);
    return this.encrypt(plaintext, tenantId, purpose);
  }
}