import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { KeyRing, SecretCryptoError } from '../src/security/key-ring';
import {
  SendersRepository,
  SendersService,
  SenderQuotaExceededError,
  SenderInactiveError,
  SENDER_SESSION_CRYPTO_PURPOSE,
} from '../src/senders';
import {
  SenderNotFoundError,
  SenderAlreadyExistsError,
  InvalidSenderConfigError,
} from '../src/senders/types';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';
import { PrismaService } from '../src/database/prisma.service';
export const TEST_MARKER_TABLE = '__multiplatformmsg_test_marker__';
export const TEST_MARKER_KEY = 'TEST_ENVIRONMENT_PERMITTED';

export class InsecureDatabaseTargetError extends Error {
  constructor(message = 'Refusing to run tests: Target database is not verified as a dedicated test database.') {
    super(message);
    this.name = 'InsecureDatabaseTargetError';
  }
}

export function validateDatabaseUrlSafety(dbUrl: string | undefined): void {
  if (!dbUrl || typeof dbUrl !== 'string' || dbUrl.trim().length === 0) {
    throw new InsecureDatabaseTargetError('DATABASE_URL environment variable is missing.');
  }

  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new InsecureDatabaseTargetError('DATABASE_URL is malformed or invalid.');
  }

  const dbName = parsed.pathname.replace(/^\//, '').trim();
  const isDedicatedTestDb =
    dbName === 'multiplatformmsg_test' ||
    dbName.endsWith('_test') ||
    dbName.includes('test_') ||
    dbName.includes('synthetic');

  if (!isDedicatedTestDb) {
    throw new InsecureDatabaseTargetError(
      'Target database is not an authorized test database. Target must match dedicated test database pattern.',
    );
  }
}

export async function assertDatabaseMarkerSafe(prisma: PrismaService): Promise<void> {
  const expectedToken = process.env.TEST_DATABASE_MARKER_TOKEN;
  if (!expectedToken || typeof expectedToken !== 'string' || expectedToken.trim().length === 0) {
    throw new InsecureDatabaseTargetError(
      'TEST_DATABASE_MARKER_TOKEN environment variable is missing or empty. Fail-closed safety guard active.',
    );
  }

  const trimmedExpectedToken = expectedToken.trim();

  let rows: { marker_key: string; marker_token: string }[] = [];
  try {
    rows = (await prisma.$queryRawUnsafe(
      `SELECT "marker_key", "marker_token" FROM "${TEST_MARKER_TABLE}" WHERE "marker_key" = $1 LIMIT 1`,
      TEST_MARKER_KEY,
    )) as { marker_key: string; marker_token: string }[];
  } catch {
    throw new InsecureDatabaseTargetError(
      'Target database missing pre-provisioned test marker table. Test target is unverified.',
    );
  }

  if (!rows || rows.length === 0 || rows[0].marker_token !== trimmedExpectedToken) {
    throw new InsecureDatabaseTargetError(
      'Target database missing required pre-provisioned test marker record or token mismatch.',
    );
  }
}

/**
 * Mock Prisma Client for in-memory / unit verification of SendersRepository & SendersService
 */
function createMockPrismaService() {
  const store = new Map<string, any>();

  return {
    senderAccount: {
      create: async ({ data }: { data: any }) => {
        const key = `${data.tenantId}:${data.id}`;
        if (store.has(key)) {
          const error: any = new Error('Unique constraint failed');
          error.code = 'P2002';
          throw error;
        }
        const record = {
          ...data,
          id: data.id || crypto.randomUUID(),
          sentTodayCount: data.sentTodayCount || 0,
          dailyQuota: data.dailyQuota || 50,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.set(`${record.tenantId}:${record.id}`, record);
        return record;
      },
      findFirst: async ({ where }: { where: any }) => {
        for (const record of store.values()) {
          let match = true;
          if (where.tenantId && record.tenantId !== where.tenantId) match = false;
          if (where.id && record.id !== where.id) match = false;
          if (where.platform && record.platform !== where.platform) match = false;
          if (where.status && record.status !== where.status) match = false;
          if (match) return { ...record };
        }
        return null;
      },
      findMany: async ({ where }: { where: any }) => {
        const results: any[] = [];
        for (const record of store.values()) {
          let match = true;
          if (where.tenantId && record.tenantId !== where.tenantId) match = false;
          if (where.platform && record.platform !== where.platform) match = false;
          if (where.status && record.status !== where.status) match = false;
          if (where.ownershipType && record.ownershipType !== where.ownershipType) match = false;
          if (match) results.push({ ...record });
        }
        return results;
      },
      update: async ({ where, data }: { where: any; data: any }) => {
        const targetId = where.tenantId_id ? where.tenantId_id.id : where.id;
        const targetTenant = where.tenantId_id ? where.tenantId_id.tenantId : where.tenantId;
        const key = `${targetTenant}:${targetId}`;
        const record = store.get(key);
        if (!record) {
          throw new Error('Record not found for update');
        }

        const updated = { ...record };
        if (data.status !== undefined) updated.status = data.status;
        if (data.cooldownUntil !== undefined) updated.cooldownUntil = data.cooldownUntil;
        if (data.cooldownReason !== undefined) updated.cooldownReason = data.cooldownReason;
        if (data.sessionEncrypted !== undefined) updated.sessionEncrypted = data.sessionEncrypted;
        if (data.sentTodayCount !== undefined) {
          if (typeof data.sentTodayCount === 'object' && data.sentTodayCount.increment) {
            updated.sentTodayCount += data.sentTodayCount.increment;
          } else {
            updated.sentTodayCount = data.sentTodayCount;
          }
        }
        updated.updatedAt = new Date();
        store.set(key, updated);
        return updated;
      },
      delete: async ({ where }: { where: any }) => {
        const targetId = where.tenantId_id ? where.tenantId_id.id : where.id;
        const targetTenant = where.tenantId_id ? where.tenantId_id.tenantId : where.tenantId;
        const key = `${targetTenant}:${targetId}`;
        store.delete(key);
        return {};
      },
      deleteMany: async ({ where }: { where: any }) => {
        for (const [key, record] of Array.from(store.entries())) {
          if (where.tenantId && record.tenantId === where.tenantId) {
            store.delete(key);
          }
        }
        return { count: 1 };
      },
    },
    $disconnect: async () => {},
  } as unknown as PrismaService;
}

describe('TASK-0027: Senders Module & Tenant Account Management', () => {
  const TENANT_ALPHA = 'org_alpha_senders';
  const TENANT_BETA = 'org_beta_senders';

  const testKeyBuf1 = Buffer.alloc(32, 0xa1);
  const testKeyBuf2 = Buffer.alloc(32, 0xb2);
  let keyRing: KeyRing;
  let mockPrisma: PrismaService;
  let repository: SendersRepository;
  let service: SendersService;

  beforeEach(() => {
    keyRing = new KeyRing({
      activeKeyId: 'key-v2-1',
      keys: [
        { id: 'key-v2-1', key: testKeyBuf1 },
        { id: 'key-v2-2', key: testKeyBuf2 },
      ],
    });
    mockPrisma = createMockPrismaService();
    repository = new SendersRepository(mockPrisma);
    service = new SendersService(repository, keyRing);
  });

  describe('AC-01: Prisma Schema & SenderAccount Model Definition', () => {
    it('verifies SenderAccount model fields structure and defaults', async () => {
      const created = await repository.create(TENANT_ALPHA, {
        id: 'sender_ac01_test',
        platform: 'TELEGRAM',
        name: 'Alpha Primary Telegram',
        dailyQuota: 100,
      });

      assert.equal(created.id, 'sender_ac01_test');
      assert.equal(created.tenantId, TENANT_ALPHA);
      assert.equal(created.channel, 'TELEGRAM');
      assert.equal(created.type, 'CUSTOMER_CONNECTED');
      assert.equal(created.status, 'ACTIVE');
      assert.equal(created.dailyQuota, 100);
      assert.equal(created.sentTodayCount, 0);
      assert.equal(created.name, 'Alpha Primary Telegram');
    });

    it('rejects duplicate sender registration with SenderAlreadyExistsError', async () => {
      await repository.create(TENANT_ALPHA, {
        id: 'sender_dup_1',
        platform: 'BALE',
      });

      await assert.rejects(
        async () => {
          await repository.create(TENANT_ALPHA, {
            id: 'sender_dup_1',
            platform: 'BALE',
          });
        },
        (err: any) => err instanceof SenderAlreadyExistsError,
      );
    });
  });

  describe('AC-02: SendersRepository & SendersService Implementation', () => {
    it('registers sender with encrypted session using v2 Key Ring envelope', async () => {
      const rawSession = 'telegram_session_auth_token_secret_12345';
      const sender = await service.registerSender(TENANT_ALPHA, {
        id: 'sender_enc_1',
        platform: 'TELEGRAM',
        ownershipType: 'CUSTOMER_CONNECTED',
        sessionData: rawSession,
        dailyQuota: 50,
      });

      assert.equal(sender.id, 'sender_enc_1');
      assert.equal(sender.tenantId, TENANT_ALPHA);
      assert.ok(sender.sessionEncrypted, 'Session must be encrypted');

      // Envelope structure must be v2.<keyId>.<12-byte nonce hex>.<16-byte tag hex>.<ciphertext hex>
      const parts = sender.sessionEncrypted.split('.');
      assert.equal(parts.length, 5, 'Envelope must have 5 parts');
      assert.equal(parts[0], 'v2');
      assert.equal(parts[1], 'key-v2-1'); // Active key ID

      // Verify successful decryption
      const decrypted = await service.decryptSession(TENANT_ALPHA, 'sender_enc_1');
      assert.equal(decrypted, rawSession);
    });

    it('manages sender health states (ACTIVE -> COOLDOWN -> auto-restore)', async () => {
      await service.registerSender(TENANT_ALPHA, {
        id: 'sender_health_1',
        platform: 'TELEGRAM',
        dailyQuota: 10,
      });

      // Mark cooldown for 10 seconds
      await service.markCooldown(TENANT_ALPHA, 'sender_health_1', 10, 'Flood limit warning');
      let sender = await service.getSender(TENANT_ALPHA, 'sender_health_1');
      assert.equal(sender?.status, 'COOLDOWN');
      assert.equal(sender?.cooldownReason, 'Flood limit warning');

      // Check quota during cooldown -> should be blocked
      const blockedCheck = await service.checkQuota(TENANT_ALPHA, 'sender_health_1');
      assert.equal(blockedCheck.allowed, false);
      assert.equal(blockedCheck.status, 'COOLDOWN');

      // Fast forward past cooldown expiry -> auto-restore to ACTIVE
      const futureTime = new Date(Date.now() + 15000);
      const restoredCheck = await service.checkQuota(TENANT_ALPHA, 'sender_health_1', futureTime);
      assert.equal(restoredCheck.allowed, true);
      assert.equal(restoredCheck.status, 'ACTIVE');

      sender = await service.getSender(TENANT_ALPHA, 'sender_health_1');
      assert.equal(sender?.status, 'ACTIVE');
    });

    it('enforces permanent BANNED state and blocks dispatches', async () => {
      await service.registerSender(TENANT_ALPHA, {
        id: 'sender_banned_1',
        platform: 'BALE',
        dailyQuota: 50,
      });

      await service.markBanned(TENANT_ALPHA, 'sender_banned_1', 'Permanent platform block');
      const sender = await service.getSender(TENANT_ALPHA, 'sender_banned_1');
      assert.equal(sender?.status, 'BANNED');

      const quota = await service.checkQuota(TENANT_ALPHA, 'sender_banned_1');
      assert.equal(quota.allowed, false);
      assert.equal(quota.status, 'BANNED');

      await assert.rejects(
        async () => {
          await service.recordSentMessage(TENANT_ALPHA, 'sender_banned_1');
        },
        (err: any) => err instanceof SenderInactiveError,
      );
    });

    it('enforces daily quota limit and throws SenderQuotaExceededError on overflow', async () => {
      await service.registerSender(TENANT_ALPHA, {
        id: 'sender_quota_1',
        platform: 'TELEGRAM',
        dailyQuota: 2,
        sentTodayCount: 0,
      });

      // Message 1: allowed
      await service.recordSentMessage(TENANT_ALPHA, 'sender_quota_1');
      let check = await service.checkQuota(TENANT_ALPHA, 'sender_quota_1');
      assert.equal(check.allowed, true);
      assert.equal(check.remainingQuota, 1);

      // Message 2: allowed
      await service.recordSentMessage(TENANT_ALPHA, 'sender_quota_1');
      check = await service.checkQuota(TENANT_ALPHA, 'sender_quota_1');
      assert.equal(check.allowed, false);
      assert.equal(check.remainingQuota, 0);

      // Message 3: rejected with SenderQuotaExceededError
      await assert.rejects(
        async () => {
          await service.recordSentMessage(TENANT_ALPHA, 'sender_quota_1');
        },
        (err: any) => {
          assert.ok(err instanceof SenderQuotaExceededError);
          assert.equal(err.code, 'SENDER_QUOTA_EXCEEDED');
          return true;
        },
      );
    });

    it('supports session re-encryption under key rotation', async () => {
      const rawSession = 'auth_session_credentials_rotate';
      await service.registerSender(TENANT_ALPHA, {
        id: 'sender_rotate_1',
        platform: 'TELEGRAM',
        sessionData: rawSession,
      });

      // Initially encrypted with key-v2-1
      let sender = await service.getSender(TENANT_ALPHA, 'sender_rotate_1');
      assert.ok(sender?.sessionEncrypted?.startsWith('v2.key-v2-1.'));

      // Rotate keyRing active key to key-v2-2
      const rotatedKeyRing = new KeyRing({
        activeKeyId: 'key-v2-2',
        keys: [
          { id: 'key-v2-1', key: testKeyBuf1 },
          { id: 'key-v2-2', key: testKeyBuf2 },
        ],
      });
      const rotatedService = new SendersService(repository, rotatedKeyRing);

      // Re-encrypt session
      await rotatedService.reencryptSession(TENANT_ALPHA, 'sender_rotate_1');
      sender = await rotatedService.getSender(TENANT_ALPHA, 'sender_rotate_1');
      assert.ok(sender?.sessionEncrypted?.startsWith('v2.key-v2-2.'));

      // Decrypt with rotated key ring successfully
      const decrypted = await rotatedService.decryptSession(TENANT_ALPHA, 'sender_rotate_1');
      assert.equal(decrypted, rawSession);
    });
  });

  describe('AC-03: Multi-Tenant Boundary Isolation', () => {
    it('strictly isolates sender accounts between Tenant Alpha and Tenant Beta', async () => {
      // Register accounts in both tenants
      await service.registerSender(TENANT_ALPHA, {
        id: 'sender_alpha_common',
        platform: 'TELEGRAM',
        name: 'Alpha Customer Account',
        ownershipType: 'CUSTOMER_CONNECTED',
        dailyQuota: 100,
        sessionData: 'alpha_secret_session',
      });

      await service.registerSender(TENANT_BETA, {
        id: 'sender_beta_common',
        platform: 'BALE',
        name: 'Beta Customer Account',
        ownershipType: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
        sessionData: 'beta_secret_session',
      });

      // Tenant Alpha CANNOT see Tenant Beta sender
      const betaFromAlpha = await service.getSender(TENANT_ALPHA, 'sender_beta_common');
      assert.equal(betaFromAlpha, null, 'Tenant Alpha must not see Tenant Beta sender');

      // Tenant Beta CANNOT see Tenant Alpha sender
      const alphaFromBeta = await service.getSender(TENANT_BETA, 'sender_alpha_common');
      assert.equal(alphaFromBeta, null, 'Tenant Beta must not see Tenant Alpha sender');

      // Listing senders returns strictly tenant-scoped accounts
      const listAlpha = await service.listSenders(TENANT_ALPHA);
      assert.equal(listAlpha.length, 1);
      assert.equal(listAlpha[0].id, 'sender_alpha_common');

      const listBeta = await service.listSenders(TENANT_BETA);
      assert.equal(listBeta.length, 1);
      assert.equal(listBeta[0].id, 'sender_beta_common');
    });

    it('prevents Tenant Beta from modifying or dispatching via Tenant Alpha sender', async () => {
      await service.registerSender(TENANT_ALPHA, {
        id: 'sender_alpha_exclusive',
        platform: 'TELEGRAM',
        dailyQuota: 50,
      });

      // Tenant Beta attempts to update health of Tenant Alpha account -> SenderNotFoundError
      await assert.rejects(
        async () => {
          await service.markBanned(TENANT_BETA, 'sender_alpha_exclusive', 'Attacking Alpha');
        },
        (err: any) => err instanceof SenderNotFoundError,
      );

      // Tenant Beta attempts to dispatch via Tenant Alpha account -> SenderNotFoundError
      await assert.rejects(
        async () => {
          await service.recordSentMessage(TENANT_BETA, 'sender_alpha_exclusive');
        },
        (err: any) => err instanceof SenderNotFoundError,
      );

      // Verify Alpha account remained untouched
      const original = await service.getSender(TENANT_ALPHA, 'sender_alpha_exclusive');
      assert.equal(original?.status, 'ACTIVE');
      assert.equal(original?.sentTodayCount, 0);
    });

    it('prevents cross-tenant cryptographic session decryption (Fail-Closed AAD Mismatch)', async () => {
      const alphaSecret = 'super_secret_alpha_telegram_credentials';
      const alphaSender = await service.registerSender(TENANT_ALPHA, {
        id: 'sender_alpha_crypto',
        platform: 'TELEGRAM',
        sessionData: alphaSecret,
      });

      // Attempting to decrypt Alpha session directly with Beta tenant ID throws SecretCryptoError
      assert.throws(
        () => {
          keyRing.decrypt(alphaSender.sessionEncrypted!, TENANT_BETA, SENDER_SESSION_CRYPTO_PURPOSE);
        },
        (err: any) => {
          assert.ok(err instanceof SecretCryptoError);
          return true;
        },
      );
    });

    it('rejects missing or invalid tenant identifiers with strict tenant-scope errors', async () => {
      await assert.rejects(
        async () => {
          await service.getSender('', 'any_id');
        },
        (err: any) => err instanceof TenantScopeMissingError,
      );

      await assert.rejects(
        async () => {
          await service.getSender('   ', 'any_id');
        },
        (err: any) => err instanceof TenantScopeMissingError,
      );

      await assert.rejects(
        async () => {
          await service.getSender('tenant with spaces', 'any_id');
        },
        (err: any) => err instanceof TenantScopeInvalidError,
      );

      await assert.rejects(
        async () => {
          await service.getSender('tenant;DROP TABLE;', 'any_id');
        },
        (err: any) => err instanceof TenantScopeInvalidError,
      );
    });

    it('clears only targeted tenant records without affecting other tenants', async () => {
      await service.registerSender(TENANT_ALPHA, {
        id: 'sender_a_wipe',
        platform: 'TELEGRAM',
      });
      await service.registerSender(TENANT_BETA, {
        id: 'sender_b_survive',
        platform: 'TELEGRAM',
      });

      // Clear Tenant Alpha only
      await repository.clearTenant(TENANT_ALPHA);

      const listAlpha = await service.listSenders(TENANT_ALPHA);
      assert.equal(listAlpha.length, 0, 'Tenant Alpha senders must be cleared');

      const listBeta = await service.listSenders(TENANT_BETA);
      assert.equal(listBeta.length, 1, 'Tenant Beta senders must remain intact');
      assert.equal(listBeta[0].id, 'sender_b_survive');
    });
  });

  // Database Integration Tests (Active when DATABASE_URL is set on verified test DB)
  describe('PostgreSQL Live Database Integration (when DATABASE_URL is configured)', () => {
    let livePrisma: PrismaService | null = null;
    let liveRepo: SendersRepository | null = null;
    let liveService: SendersService | null = null;
    const LIVE_SEED = crypto.randomBytes(4).toString('hex');
    const LIVE_TENANT_A = `org_db_a_${LIVE_SEED}`;
    const LIVE_TENANT_B = `org_db_b_${LIVE_SEED}`;

    before(async () => {
      if (!process.env.DATABASE_URL) {
        return;
      }
      try {
        validateDatabaseUrlSafety(process.env.DATABASE_URL);
        livePrisma = new PrismaService();
        await assertDatabaseMarkerSafe(livePrisma);

        // Create test tenants in database
        await livePrisma.tenant.createMany({
          data: [
            { id: LIVE_TENANT_A, name: 'Live Tenant A', slug: `slug-live-a-${LIVE_SEED}` },
            { id: LIVE_TENANT_B, name: 'Live Tenant B', slug: `slug-live-b-${LIVE_SEED}` },
          ],
        });

        liveRepo = new SendersRepository(livePrisma);
        liveService = new SendersService(liveRepo, keyRing);
      } catch (e) {
        livePrisma = null;
      }
    });

    after(async () => {
      if (livePrisma) {
        try {
          await livePrisma.senderAccount.deleteMany({
            where: { tenantId: { in: [LIVE_TENANT_A, LIVE_TENANT_B] } },
          });
          await livePrisma.tenant.deleteMany({
            where: { id: { in: [LIVE_TENANT_A, LIVE_TENANT_B] } },
          });
          await livePrisma.$disconnect();
        } catch {}
      }
    });

    it('persists and enforces constraints in real PostgreSQL database', async (t) => {
      if (!livePrisma || !liveService) {
        t.skip('Live PostgreSQL database not configured or unverified.');
        return;
      }

      const created = await liveService.registerSender(LIVE_TENANT_A, {
        id: `live_sender_a_${LIVE_SEED}`,
        platform: 'TELEGRAM',
        ownershipType: 'CUSTOMER_CONNECTED',
        dailyQuota: 25,
        sessionData: 'live_test_session_credentials',
      });

      assert.equal(created.id, `live_sender_a_${LIVE_SEED}`);
      assert.equal(created.tenantId, LIVE_TENANT_A);
      assert.ok(created.sessionEncrypted?.startsWith('v2.key-v2-1.'));

      // Increment in live DB
      const incremented = await liveService.recordSentMessage(LIVE_TENANT_A, created.id);
      assert.equal(incremented.sentTodayCount, 1);

      // Verify Tenant B cannot query this sender in live DB
      const crossTenant = await liveService.getSender(LIVE_TENANT_B, created.id);
      assert.equal(crossTenant, null);
    });
  });
});
