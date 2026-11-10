import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { KeyRing, KeyRingError, SecretCryptoError } from '../src/security/key-ring';
import { encryptSecret, decryptSecret } from '../src/security/secret-crypto';

// Synthetic test keys - 32 bytes base64 encoded, never production credentials
const keyBuf1 = Buffer.alloc(32, 0x11);
const keyBuf2 = Buffer.alloc(32, 0x22);
const keyBuf3 = Buffer.alloc(32, 0x33);
const keyB64_1 = keyBuf1.toString('base64');
const keyB64_2 = keyBuf2.toString('base64');
const keyB64_3 = keyBuf3.toString('base64');

const tenant = 'org_test_alpha';
const purpose = 'connector.token';
const plaintext = Buffer.from('synthetic-secret-نمونه-🔒');

function rejectsSafely(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof SecretCryptoError);
    assert.equal(error.message, 'Secret cryptography operation failed.');
    assert.equal('cause' in (error as any), false);
    for (const sensitive of [
      plaintext.toString(),
      keyBuf1.toString('hex'),
      keyBuf2.toString('hex'),
      keyB64_1,
      keyB64_2,
    ]) {
      assert.equal(inspect(error).includes(sensitive), false);
    }
    return true;
  });
}

describe('Versioned Key Ring and Rotation (TASK-0016)', () => {
  describe('AC-01: Configuration loading and fail-closed validation', () => {
    it('creates key ring from JSON env string with array of keys', () => {
      const configStr = JSON.stringify({
        activeKeyId: 'key-2',
        keys: [
          { id: 'key-1', key: keyB64_1 },
          { id: 'key-2', key: keyB64_2 },
        ],
      });
      const ring = KeyRing.fromEnv(configStr);
      assert.equal(ring.getActiveKeyId(), 'key-2');
      assert.deepEqual(ring.getKeyIds().sort(), ['key-1', 'key-2'].sort());
      assert.equal(ring.hasKey('key-1'), true);
      assert.equal(ring.hasKey('key-2'), true);
      assert.equal(ring.hasKey('key-unknown'), false);
    });

    it('creates key ring from JSON env string with dictionary of keys', () => {
      const configStr = JSON.stringify({
        activeKeyId: 'key-1',
        keys: {
          'key-1': keyB64_1,
          'key-2': keyB64_2,
        },
      });
      const ring = KeyRing.fromConfig(configStr);
      assert.equal(ring.getActiveKeyId(), 'key-1');
      assert.equal(ring.hasKey('key-1'), true);
      assert.equal(ring.hasKey('key-2'), true);
    });

    it('creates key ring from delimited env string (semicolon and colon/equals)', () => {
      const delimited1 = `active=key-2;key-1=${keyB64_1};key-2=${keyB64_2}`;
      const ring1 = KeyRing.fromEnv(delimited1);
      assert.equal(ring1.getActiveKeyId(), 'key-2');
      assert.equal(ring1.hasKey('key-1'), true);
      assert.equal(ring1.hasKey('key-2'), true);

      const delimited2 = `key-1;key-1:${keyB64_1};key-2:${keyB64_2}`;
      const ring2 = KeyRing.fromEnv(delimited2);
      assert.equal(ring2.getActiveKeyId(), 'key-1');
      assert.equal(ring2.hasKey('key-1'), true);
      assert.equal(ring2.hasKey('key-2'), true);
    });

    it('creates key ring from programmatic config object with Buffers', () => {
      const ring = new KeyRing({
        activeKeyId: 'key-1',
        keys: [
          { id: 'key-1', key: keyBuf1 },
          { id: 'key-2', key: keyBuf2 },
        ],
      });
      assert.equal(ring.getActiveKeyId(), 'key-1');
      assert.equal(ring.hasKey('key-2'), true);
    });

    it('rejects empty or whitespace-only configurations', () => {
      for (const empty of ['', '   ', '\n\t', null, undefined, '{}', '[]']) {
        rejectsSafely(() => KeyRing.fromEnv(empty as any));
        rejectsSafely(() => KeyRing.fromConfig(empty as any));
        rejectsSafely(() => new KeyRing(empty as any));
      }
    });

    it('rejects keys with wrong lengths (not 32 bytes)', () => {
      const shortKey = Buffer.alloc(31, 0x11).toString('base64');
      const longKey = Buffer.alloc(33, 0x11).toString('base64');
      const zeroKey = Buffer.alloc(0).toString('base64');

      for (const invalidKey of [shortKey, longKey, zeroKey, 'not-base64-at-all']) {
        rejectsSafely(() =>
          KeyRing.fromEnv(
            JSON.stringify({
              activeKeyId: 'k1',
              keys: [{ id: 'k1', key: invalidKey }],
            }),
          ),
        );
      }
    });

    it('rejects duplicate key identifiers in configuration', () => {
      // In array format
      rejectsSafely(() =>
        KeyRing.fromEnv(
          JSON.stringify({
            activeKeyId: 'k1',
            keys: [
              { id: 'k1', key: keyB64_1 },
              { id: 'k1', key: keyB64_2 },
            ],
          }),
        ),
      );

      // In delimited format
      rejectsSafely(() =>
        KeyRing.fromEnv(`active=k1;k1=${keyB64_1};k1=${keyB64_2}`),
      );
    });

    it('rejects unknown or invalid active key ID', () => {
      // Active key not in keys list
      rejectsSafely(() =>
        KeyRing.fromEnv(
          JSON.stringify({
            activeKeyId: 'key-nonexistent',
            keys: [{ id: 'key-1', key: keyB64_1 }],
          }),
        ),
      );

      // Invalid active key identifier format
      for (const badId of ['', ' ', 'key.1', 'key/1', 'key@1', 'x'.repeat(65)]) {
        rejectsSafely(() =>
          KeyRing.fromEnv(
            JSON.stringify({
              activeKeyId: badId,
              keys: [{ id: 'key-1', key: keyB64_1 }],
            }),
          ),
        );
      }
    });

    it('rejects invalid key ID formats in keys list', () => {
      for (const badId of ['', ' ', 'key.1', 'key/1', 'a b', 'é', 'x'.repeat(65)]) {
        rejectsSafely(() =>
          KeyRing.fromEnv(
            JSON.stringify({
              activeKeyId: badId,
              keys: [{ id: badId, key: keyB64_1 }],
            }),
          ),
        );
      }
    });
  });

  describe('AC-02: Versioned envelope, AAD binding, tampering, and v1 compatibility', () => {
    const ring = KeyRing.fromConfig({
      activeKeyId: 'key-2',
      keys: [
        { id: 'key-1', key: keyB64_1 },
        { id: 'key-2', key: keyB64_2 },
      ],
    });

    it('encrypts with active key carrying key ID in versioned envelope (v2.<keyId>...) and roundtrips', () => {
      for (const input of [
        plaintext,
        Buffer.alloc(0),
        Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      ]) {
        const inputCopy = Buffer.from(input);
        const envelope = ring.encrypt(input, tenant, purpose);

        // Envelope structure: v2.<keyId>.<12-byte nonce hex>.<16-byte tag hex>.<ciphertext hex>
        assert.match(
          envelope,
          /^v2\.key-2\.[0-9a-f]{24}\.[0-9a-f]{32}\.(?:[0-9a-f]{2})*$/,
        );
        assert.equal(envelope.includes(plaintext.toString()), false);

        const decrypted = ring.decrypt(envelope, tenant, purpose);
        assert.deepEqual(decrypted, input);
        assert.deepEqual(input, inputCopy); // input not mutated
      }
    });

    it('generates fresh nonces for repeated encryption with active key', () => {
      const envelopes = Array.from({ length: 32 }, () =>
        ring.encrypt(plaintext, tenant, purpose),
      );
      assert.equal(new Set(envelopes).size, 32);
      const nonces = envelopes.map((e) => e.split('.')[2]);
      assert.equal(new Set(nonces).size, 32);
    });

    it('rejects when keyId in envelope is tampered to another valid key in the ring (AAD binding)', () => {
      // Encrypt with key-2
      const envelope = ring.encrypt(plaintext, tenant, purpose);
      const parts = envelope.split('.');
      assert.equal(parts[1], 'key-2');

      // Tamper keyId in envelope to key-1 (which is also known in ring)
      parts[1] = 'key-1';
      const tampered = parts.join('.');

      // Must fail because AAD was constructed with key-2
      rejectsSafely(() => ring.decrypt(tampered, tenant, purpose));
    });

    it('rejects when keyId in envelope is unknown to the ring', () => {
      const envelope = ring.encrypt(plaintext, tenant, purpose);
      const parts = envelope.split('.');
      parts[1] = 'key-unknown';
      const tampered = parts.join('.');
      rejectsSafely(() => ring.decrypt(tampered, tenant, purpose));
    });

    it('rejects different tenant or purpose context', () => {
      const envelope = ring.encrypt(plaintext, tenant, purpose);
      rejectsSafely(() => ring.decrypt(envelope, 'org_test_beta', purpose));
      rejectsSafely(() => ring.decrypt(envelope, tenant, 'connector.session'));
    });

    it('rejects bit changes in keyId, nonce, tag, and ciphertext', () => {
      const envelope = ring.encrypt(plaintext, tenant, purpose);
      const parts = envelope.split('.');

      // Bit tampering in nonce (index 2), tag (index 3), ciphertext (index 4)
      for (const field of [2, 3, 4]) {
        const original = Buffer.from(parts[field], 'hex');
        if (original.length === 0) continue;
        for (let i = 0; i < original.length; i++) {
          const changed = Buffer.from(original);
          changed[i] ^= 1;
          const tampered = [...parts];
          tampered[field] = changed.toString('hex');
          rejectsSafely(() => ring.decrypt(tampered.join('.'), tenant, purpose));
        }
      }
    });

    it('rejects malformed envelopes and unsupported versions', () => {
      const envelope = ring.encrypt(plaintext, tenant, purpose);
      const malformed = [
        '',
        'v2',
        'v2.key-2',
        envelope + '.',
        envelope.slice(0, -1),
        envelope.replace(/^v2/, 'v3'),
        envelope.replace(/^v2/, 'V2'),
        null,
        undefined,
        123,
      ];
      for (const m of malformed) {
        rejectsSafely(() => ring.decrypt(m as any, tenant, purpose));
      }
    });

    it('reads TASK-0014 v1 envelopes when key is present in ring', () => {
      // Create v1 envelope with standalone encryptSecret using keyBuf1
      const v1Envelope = encryptSecret(plaintext, keyBuf1, tenant, purpose);
      assert.match(v1Envelope, /^v1\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]+$/);

      // Ring contains key-1 (keyBuf1) and key-2 (keyBuf2)
      const decrypted = ring.decrypt(v1Envelope, tenant, purpose);
      assert.deepEqual(decrypted, plaintext);

      // Rejects v1 envelope if tenant or purpose differs
      rejectsSafely(() => ring.decrypt(v1Envelope, 'org_other', purpose));
      rejectsSafely(() => ring.decrypt(v1Envelope, tenant, 'other.purpose'));

      // Rejects v1 envelope when its key is NOT in the ring
      const ringWithoutKey1 = KeyRing.fromConfig({
        activeKeyId: 'key-2',
        keys: [{ id: 'key-2', key: keyB64_2 }],
      });
      rejectsSafely(() => ringWithoutKey1.decrypt(v1Envelope, tenant, purpose));
    });
  });

  describe('AC-03: Key rotation and re-encryption', () => {
    it('re-encrypts value encrypted with old key using active key and preserves tenant/purpose isolation', () => {
      // Step 1: Initial ring with key-1 active
      const ringPhase1 = KeyRing.fromConfig({
        activeKeyId: 'key-1',
        keys: [
          { id: 'key-1', key: keyB64_1 },
        ],
      });
      const envelopeOld = ringPhase1.encrypt(plaintext, tenant, purpose);
      assert.match(envelopeOld, /^v2\.key-1\./);

      // Step 2: Rotated ring with key-2 active, but key-1 still retained
      const ringPhase2 = KeyRing.fromConfig({
        activeKeyId: 'key-2',
        keys: [
          { id: 'key-1', key: keyB64_1 },
          { id: 'key-2', key: keyB64_2 },
        ],
      });

      // Both old and new envelopes can be decrypted by phase 2 ring
      assert.deepEqual(ringPhase2.decrypt(envelopeOld, tenant, purpose), plaintext);

      // Re-encrypt old envelope using phase 2 ring
      const envelopeReencrypted = ringPhase2.reencrypt(envelopeOld, tenant, purpose);
      assert.match(envelopeReencrypted, /^v2\.key-2\./);
      assert.deepEqual(ringPhase2.decrypt(envelopeReencrypted, tenant, purpose), plaintext);

      // Step 3: Phase 3 ring after retiring old key-1 (only key-2 remains)
      const ringPhase3 = KeyRing.fromConfig({
        activeKeyId: 'key-2',
        keys: [
          { id: 'key-2', key: keyB64_2 },
        ],
      });

      // Old envelope with key-1 FAILS on phase 3 ring
      rejectsSafely(() => ringPhase3.decrypt(envelopeOld, tenant, purpose));

      // Re-encrypted envelope with key-2 SUCCEEDS on phase 3 ring
      assert.deepEqual(ringPhase3.decrypt(envelopeReencrypted, tenant, purpose), plaintext);
    });

    it('re-encrypts v1 envelopes to v2 active key envelopes during migration', () => {
      // TASK-0014 v1 envelope encrypted with keyBuf1
      const v1Envelope = encryptSecret(plaintext, keyBuf1, tenant, purpose);

      // Ring with key-2 active and key-1 retained
      const ring = KeyRing.fromConfig({
        activeKeyId: 'key-2',
        keys: [
          { id: 'key-1', key: keyB64_1 },
          { id: 'key-2', key: keyB64_2 },
        ],
      });

      // Re-encrypt converts v1 envelope to v2 envelope under active key-2
      const reencrypted = ring.reencrypt(v1Envelope, tenant, purpose);
      assert.match(reencrypted, /^v2\.key-2\./);
      assert.deepEqual(ring.decrypt(reencrypted, tenant, purpose), plaintext);

      // Post-migration ring with key-1 removed
      const postMigrationRing = KeyRing.fromConfig({
        activeKeyId: 'key-2',
        keys: [{ id: 'key-2', key: keyB64_2 }],
      });
      // v1 envelope fails
      rejectsSafely(() => postMigrationRing.decrypt(v1Envelope, tenant, purpose));
      // re-encrypted envelope succeeds
      assert.deepEqual(postMigrationRing.decrypt(reencrypted, tenant, purpose), plaintext);
    });

    it('reencrypt rejects mismatched tenant or purpose', () => {
      const ring = KeyRing.fromConfig({
        activeKeyId: 'key-1',
        keys: [{ id: 'key-1', key: keyB64_1 }],
      });
      const envelope = ring.encrypt(plaintext, tenant, purpose);
      rejectsSafely(() => ring.reencrypt(envelope, 'wrong_tenant', purpose));
      rejectsSafely(() => ring.reencrypt(envelope, tenant, 'wrong_purpose'));
    });
  });

  describe('AC-04: Security hygiene and non-mutation', () => {
    it('does not mutate input buffers or expose internal key buffers', () => {
      const keyBuffer = Buffer.from(keyBuf1);
      const ring = new KeyRing({
        activeKeyId: 'k1',
        keys: [{ id: 'k1', key: keyBuffer }],
      });

      // Mutate external key buffer after ring construction
      keyBuffer.fill(0xff);

      // Ring must have cloned the buffer and remain unaffected
      const envelope = ring.encrypt(plaintext, tenant, purpose);
      assert.deepEqual(ring.decrypt(envelope, tenant, purpose), plaintext);
    });

    it('never leaks secret or key in error object', () => {
      const ring = KeyRing.fromConfig({
        activeKeyId: 'k1',
        keys: [{ id: 'k1', key: keyB64_1 }],
      });
      try {
        ring.decrypt('v2.k1.invalid.envelope.format', tenant, purpose);
        assert.fail('Expected error');
      } catch (err: any) {
        assert.ok(err instanceof SecretCryptoError);
        assert.equal(err.message, 'Secret cryptography operation failed.');
        assert.equal('cause' in err, false);
        const inspected = inspect(err);
        assert.equal(inspected.includes(keyB64_1), false);
        assert.equal(inspected.includes(keyBuf1.toString('hex')), false);
      }
    });
  });
});