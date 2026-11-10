import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { encryptSecret, decryptSecret, SecretCryptoError } from '../src/security/secret-crypto';

const key = Buffer.alloc(32, 0x73); // Synthetic key, never a real credential.
const tenant = 'org_test_alpha';
const purpose = 'connector.token';
const plaintext = Buffer.from('synthetic-secret-نمونه-🔒');
const encrypt = () => encryptSecret(plaintext, key, tenant, purpose);

function rejectsSafely(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof SecretCryptoError);
    assert.equal(error.message, 'Secret cryptography operation failed.');
    assert.equal('cause' in error, false);
    for (const sensitive of [plaintext.toString(), key.toString('hex'), tenant, purpose]) {
      assert.equal(inspect(error).includes(sensitive), false);
    }
    return true;
  });
}

describe('Standalone AES-256-GCM secret cryptography', () => {
  it('round-trips Unicode, empty and arbitrary binary data without mutating inputs', () => {
    for (const input of [plaintext, Buffer.alloc(0), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]) {
      const before = Buffer.from(input);
      const keyBefore = Buffer.from(key);
      const envelope = encryptSecret(input, key, tenant, purpose);
      assert.deepEqual(decryptSecret(envelope, key, tenant, purpose), input);
      assert.deepEqual(input, before);
      assert.deepEqual(key, keyBefore);
      assert.equal(envelope.includes(plaintext.toString()), false);
      assert.match(envelope, /^v1\.[0-9a-f]{24}\.[0-9a-f]{32}\.(?:[0-9a-f]{2})*$/);
    }
  });

  it('generates fresh nonces and different envelopes for repeated plaintext', () => {
    const envelopes = Array.from({ length: 64 }, encrypt);
    assert.equal(new Set(envelopes).size, 64);
    assert.equal(new Set(envelopes.map((value) => value.split('.')[1])).size, 64);
  });

  it('rejects another tenant, purpose, key and ambiguous context framing', () => {
    const envelope = encrypt();
    rejectsSafely(() => decryptSecret(envelope, key, 'org_test_beta', purpose));
    rejectsSafely(() => decryptSecret(envelope, key, tenant, 'connector.session'));
    rejectsSafely(() => decryptSecret(envelope, Buffer.alloc(32, 0x74), tenant, purpose));
    const framed = encryptSecret(plaintext, key, 'a', 'b:c');
    rejectsSafely(() => decryptSecret(framed, key, 'a_b', 'c'));
  });

  it('rejects invalid context and key inputs on both operations', () => {
    const envelope = encrypt();
    for (const invalid of ['', ' ', ' a', 'a ', 'a\n', 'a\nb', 'a/b', 'é', 'x'.repeat(129), null, undefined, 123, {}]) {
      rejectsSafely(() => encryptSecret(plaintext, key, invalid as string, purpose));
      rejectsSafely(() => decryptSecret(envelope, key, invalid as string, purpose));
      rejectsSafely(() => encryptSecret(plaintext, key, tenant, invalid as string));
      rejectsSafely(() => decryptSecret(envelope, key, tenant, invalid as string));
    }
    rejectsSafely(() => encryptSecret(plaintext, key, 'x'.repeat(65), purpose));
    rejectsSafely(() => decryptSecret(envelope, key, 'x'.repeat(65), purpose));
    for (const invalid of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), 'x'.repeat(32), null, new Uint8Array(32)]) {
      rejectsSafely(() => encryptSecret(plaintext, invalid as Buffer, tenant, purpose));
      rejectsSafely(() => decryptSecret(envelope, invalid as Buffer, tenant, purpose));
    }
    rejectsSafely(() => encryptSecret('invalid' as unknown as Buffer, key, tenant, purpose));
  });

  it('rejects bit changes in every nonce, tag and ciphertext byte', () => {
    const parts = encrypt().split('.');
    for (const field of [1, 2, 3]) {
      const original = Buffer.from(parts[field], 'hex');
      for (let i = 0; i < original.length; i++) {
        const changed = Buffer.from(original);
        changed[i] ^= 1;
        const tampered = [...parts];
        tampered[field] = changed.toString('hex');
        rejectsSafely(() => decryptSecret(tampered.join('.'), key, tenant, purpose));
      }
    }
  });

  it('rejects malformed envelopes, unsupported versions and noncanonical encoding', () => {
    const envelope = encrypt();
    const parts = envelope.split('.');
    const malformed: unknown[] = ['', null, undefined, 123, {}, 'v1', envelope + '.', envelope.slice(0, -1),
      envelope.replace(/^v1/, 'v2'), envelope.replace(/^v1/, 'V1')];
    for (const field of [1, 2, 3]) {
      for (const value of ['gg', '0', parts[field] + '00', parts[field].toUpperCase(), ' ' + parts[field], parts[field] + '\n']) {
        const changed = [...parts];
        changed[field] = value;
        malformed.push(changed.join('.'));
      }
    }
    for (const value of malformed) rejectsSafely(() => decryptSecret(value as string, key, tenant, purpose));
  });
});
