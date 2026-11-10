import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramConnector,
  BaleConnector,
  DispatchRateLimiter,
  DispatcherService,
  KillSwitchService,
  MessageQueueEnvelope,
  TelegramTransportAdapter,
  BaleTransportAdapter,
} from '../src/messaging';
import { SenderAccount } from '../src/senders/types';

describe('Phase 6: Multi-Platform Connectors, Rate Limiter & Dispatcher Engine', () => {
  const TENANT_1 = 'tenant_prod_1';
  const TENANT_2 = 'tenant_prod_2';

  const sampleSenderTg: SenderAccount = {
    id: 'sender_tg_01',
    tenantId: TENANT_1,
    name: 'Marketing TG Sender',
    channel: 'TELEGRAM',
    type: 'CUSTOMER_CONNECTED',
    status: 'ACTIVE',
    dailyQuota: 500,
    sentTodayCount: 12,
    activeWorkloadCount: 0,
  };

  const sampleSenderBale: SenderAccount = {
    id: 'sender_bale_01',
    tenantId: TENANT_1,
    name: 'Official Bale Bot',
    channel: 'BALE',
    type: 'CUSTOMER_CONNECTED',
    status: 'ACTIVE',
    dailyQuota: 1000,
    sentTodayCount: 50,
    activeWorkloadCount: 0,
  };

  function createEnvelope(overrides: Partial<MessageQueueEnvelope> = {}): MessageQueueEnvelope {
    return {
      messageId: `msg_${Math.random().toString(36).substring(2, 9)}`,
      tenantId: TENANT_1,
      channel: 'TELEGRAM',
      origin: 'CAMPAIGN',
      recipientPhone: '+989121112233',
      recipientContactId: 'cnt_001',
      payload: {
        text: 'سلام، این یک پیام آزمایشی است.',
      },
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('1. Telegram Connector', () => {
    it('should validate valid Telegram recipients (international phone, username, user ID)', () => {
      const connector = new TelegramConnector();
      assert.strictEqual(connector.validateRecipient('+989121234567'), true);
      assert.strictEqual(connector.validateRecipient('989121234567'), true);
      assert.strictEqual(connector.validateRecipient('@official_channel'), true);
      assert.strictEqual(connector.validateRecipient('123456789'), true);

      // Invalid
      assert.strictEqual(connector.validateRecipient(''), false);
      assert.strictEqual(connector.validateRecipient('invalid_plain_text'), false);
      assert.strictEqual(connector.validateRecipient('@a'), false); // Too short
    });

    it('should normalize Telegram recipients correctly', () => {
      const connector = new TelegramConnector();
      assert.strictEqual(connector.normalizeRecipient('989121234567'), '+989121234567');
      assert.strictEqual(connector.normalizeRecipient('+989121234567'), '+989121234567');
      assert.strictEqual(connector.normalizeRecipient('  @MyUser  '), '@myuser');
    });

    it('should parse FLOOD_WAIT and extract wait seconds accurately', () => {
      const connector = new TelegramConnector();
      const res1 = connector.parseError(new Error('RPCError: 420 FLOOD_WAIT_180'));
      assert.strictEqual(res1.isFloodWait, true);
      assert.strictEqual(res1.floodWaitSeconds, 180);
      assert.strictEqual(res1.code, 'FLOOD_WAIT');

      const res2 = connector.parseError(new Error('429 Too Many Requests: retry after 25'));
      assert.strictEqual(res2.isFloodWait, true);
      assert.strictEqual(res2.floodWaitSeconds, 25);
    });

    it('should detect banned and deactivated accounts as permanent failure', () => {
      const connector = new TelegramConnector();
      const res1 = connector.parseError(new Error('401: USER_DEACTIVATED_BAN'));
      assert.strictEqual(res1.isBanned, true);
      assert.strictEqual(res1.isPermanent, true);
      assert.strictEqual(res1.code, 'SENDER_BANNED');

      const res2 = connector.parseError(new Error('PEER_ID_INVALID: The peer is not recognized'));
      assert.strictEqual(res2.isPermanent, true);
      assert.strictEqual(res2.code, 'PERMANENT_DISPATCH_FAILURE');
    });

    it('should successfully dispatch through transport adapter', async () => {
      const mockTransport: TelegramTransportAdapter = {
        async sendMessage(params) {
          assert.strictEqual(params.recipient, '+989121112233');
          return { messageId: 'tg_msg_9999', date: 1700000000 };
        },
      };

      const connector = new TelegramConnector(mockTransport);
      const envelope = createEnvelope();
      const res = await connector.send(envelope, sampleSenderTg);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.status, 'SENT');
      assert.strictEqual(res.externalMessageId, 'tg_msg_9999');
      assert.strictEqual(res.channel, 'TELEGRAM');
      assert.strictEqual(res.recipient, '+989121112233');
    });

    it('should reject invalid recipient before invoking transport', async () => {
      const connector = new TelegramConnector();
      const envelope = createEnvelope({ recipientPhone: 'invalid-number' });
      const res = await connector.send(envelope, sampleSenderTg);

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.status, 'FAILED');
      assert.strictEqual(res.errorCode, 'INVALID_RECIPIENT');
      assert.strictEqual(res.isPermanentFailure, true);
    });
  });

  describe('2. Bale Connector', () => {
    it('should validate Iranian phone formats and Bale user IDs', () => {
      const connector = new BaleConnector();
      assert.strictEqual(connector.validateRecipient('09121234567'), true);
      assert.strictEqual(connector.validateRecipient('+989121234567'), true);
      assert.strictEqual(connector.validateRecipient('00989121234567'), true);
      assert.strictEqual(connector.validateRecipient('9121234567'), true);
      assert.strictEqual(connector.validateRecipient('12345678'), true); // Bale user ID

      // Invalid
      assert.strictEqual(connector.validateRecipient(''), false);
      assert.strictEqual(connector.validateRecipient('+12025550199'), false); // Non-Iranian
      assert.strictEqual(connector.validateRecipient('abcde'), false);
    });

    it('should normalize local 09... numbers to +989... international format', () => {
      const connector = new BaleConnector();
      assert.strictEqual(connector.normalizeRecipient('09123456789'), '+989123456789');
      assert.strictEqual(connector.normalizeRecipient('00989123456789'), '+989123456789');
      assert.strictEqual(connector.normalizeRecipient('9123456789'), '+989123456789');
      assert.strictEqual(connector.normalizeRecipient('+989123456789'), '+989123456789');
    });

    it('should parse Bale rate limit and retry errors', () => {
      const connector = new BaleConnector();
      const res = connector.parseError(new Error('429 Too Many Requests: wait after 40'));
      assert.strictEqual(res.isFloodWait, true);
      assert.strictEqual(res.floodWaitSeconds, 40);
      assert.strictEqual(res.code, 'FLOOD_WAIT');
    });

    it('should successfully dispatch message through Bale adapter', async () => {
      const mockTransport: BaleTransportAdapter = {
        async sendMessage(params) {
          assert.strictEqual(params.recipient, '+989123456789');
          return { messageId: 'bale_msg_555', timestamp: 1700000000000 };
        },
      };

      const connector = new BaleConnector(mockTransport);
      const envelope = createEnvelope({
        channel: 'BALE',
        recipientPhone: '09123456789',
      });
      const res = await connector.send(envelope, sampleSenderBale);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.status, 'SENT');
      assert.strictEqual(res.externalMessageId, 'bale_msg_555');
      assert.strictEqual(res.channel, 'BALE');
      assert.strictEqual(res.recipient, '+989123456789');
    });
  });

  describe('3. Dispatch Rate Limiter & Anti-Spam Jitter', () => {
    let rateLimiter: DispatchRateLimiter;

    beforeEach(() => {
      rateLimiter = new DispatchRateLimiter({
        defaultMinDelayMs: 1000,
        defaultMaxDelayMs: 2000,
        maxPerMinute: 3,
        maxPerHour: 10,
        maxConcurrentPerSender: 1,
      });
    });

    it('should calculate pseudo-randomized jitter delay within bounded window', () => {
      for (let i = 0; i < 20; i++) {
        const delayTg = rateLimiter.calculateJitterDelay('TELEGRAM', 1000, 2000);
        // Multiplier for TG is 1.2 => range 1200..2400
        assert.ok(delayTg >= 1200 && delayTg <= 2400, `Telegram delay ${delayTg} out of expected range`);

        const delayBale = rateLimiter.calculateJitterDelay('BALE', 1000, 2000);
        assert.ok(delayBale >= 1000 && delayBale <= 2000, `Bale delay ${delayBale} out of expected range`);
      }
    });

    it('should track cooldown and block dispatch during cooldown window', () => {
      const senderId = 'sender_cool_1';
      assert.strictEqual(rateLimiter.getCooldownRemainingSeconds(senderId), 0);

      rateLimiter.applyCooldown(senderId, 60, 'FloodWait test');
      assert.ok(rateLimiter.getCooldownRemainingSeconds(senderId) > 0);

      const check = rateLimiter.canDispatch(senderId);
      assert.strictEqual(check.allowed, false);
      assert.strictEqual(check.isCooldown, true);
      assert.ok(check.waitTimeMs > 0);

      // Clearing cooldown allows dispatch again
      rateLimiter.clearCooldown(senderId);
      assert.strictEqual(rateLimiter.canDispatch(senderId).allowed, true);
    });

    it('should throttle dispatch when per-minute limit is exceeded', () => {
      const senderId = 'sender_throttle_1';

      assert.strictEqual(rateLimiter.canDispatch(senderId).allowed, true);
      rateLimiter.recordDispatch(senderId);

      assert.strictEqual(rateLimiter.canDispatch(senderId).allowed, true);
      rateLimiter.recordDispatch(senderId);

      assert.strictEqual(rateLimiter.canDispatch(senderId).allowed, true);
      rateLimiter.recordDispatch(senderId);

      // 4th dispatch exceeds maxPerMinute = 3
      const check = rateLimiter.canDispatch(senderId);
      assert.strictEqual(check.allowed, false);
      assert.strictEqual(check.isCooldown, false);
      assert.match(check.reason!, /rate limit exceeded/i);
    });

    it('should enforce concurrency slot limit per sender', () => {
      const senderId = 'sender_conc_1';
      assert.strictEqual(rateLimiter.acquireSlot(senderId), true);
      assert.strictEqual(rateLimiter.getInFlightCount(senderId), 1);

      // Second acquire fails because maxConcurrentPerSender = 1
      assert.strictEqual(rateLimiter.acquireSlot(senderId), false);

      rateLimiter.releaseSlot(senderId);
      assert.strictEqual(rateLimiter.getInFlightCount(senderId), 0);
      assert.strictEqual(rateLimiter.acquireSlot(senderId), true);
    });
  });

  describe('4. Dispatcher Service (End-to-End Orchestration & Safety Gates)', () => {
    let killSwitch: KillSwitchService;
    let rateLimiter: DispatchRateLimiter;
    let tgConnector: TelegramConnector;
    let baleConnector: BaleConnector;
    let dispatcher: DispatcherService;

    beforeEach(() => {
      killSwitch = new KillSwitchService();
      rateLimiter = new DispatchRateLimiter();
      tgConnector = new TelegramConnector();
      baleConnector = new BaleConnector();
      dispatcher = new DispatcherService(killSwitch, rateLimiter, tgConnector, baleConnector);
    });

    it('should reject dispatch if tenantId violates tenant isolation', async () => {
      const envelope = createEnvelope({ tenantId: TENANT_1 });
      const crossTenantSender: SenderAccount = { ...sampleSenderTg, tenantId: TENANT_2 };

      await assert.rejects(
        async () => {
          await dispatcher.dispatch(envelope, crossTenantSender);
        },
        /Cross-tenant dispatch violation/,
      );
    });

    it('should cleanly abort dispatch if Global Kill Switch is active', async () => {
      killSwitch.activate({
        reason: 'Emergency security audit',
        triggeredBy: 'sysadmin',
      });

      const envelope = createEnvelope();
      const res = await dispatcher.dispatch(envelope, sampleSenderTg);

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.status, 'KILLED_ABORTED');
      assert.strictEqual(res.errorCode, 'KILL_SWITCH_ACTIVE');
      assert.match(res.errorMessage!, /Emergency security audit/);
    });

    it('should cleanly abort dispatch if Tenant Kill Switch is active for this tenant only', async () => {
      killSwitch.activate({
        tenantId: TENANT_1,
        reason: 'Tenant account suspended for billing review',
        triggeredBy: 'billing_service',
      });

      const envelope1 = createEnvelope({ tenantId: TENANT_1 });
      const res1 = await dispatcher.dispatch(envelope1, sampleSenderTg);
      assert.strictEqual(res1.status, 'KILLED_ABORTED');

      // Another tenant is unaffected
      const envelope2 = createEnvelope({ tenantId: TENANT_2 });
      const senderTenant2: SenderAccount = { ...sampleSenderTg, tenantId: TENANT_2 };
      const res2 = await dispatcher.dispatch(envelope2, senderTenant2);
      assert.strictEqual(res2.success, true);
    });

    it('should cleanly abort dispatch if Channel Kill Switch is active for that specific channel', async () => {
      killSwitch.activate({
        channel: 'TELEGRAM',
        reason: 'Telegram upstream maintenance',
        triggeredBy: 'ops',
      });

      // Telegram dispatch blocked
      const tgEnvelope = createEnvelope({ channel: 'TELEGRAM' });
      const tgRes = await dispatcher.dispatch(tgEnvelope, sampleSenderTg);
      assert.strictEqual(tgRes.status, 'KILLED_ABORTED');

      // Bale dispatch allowed
      const baleEnvelope = createEnvelope({ channel: 'BALE', recipientPhone: '09121112233' });
      const baleRes = await dispatcher.dispatch(baleEnvelope, sampleSenderBale);
      assert.strictEqual(baleRes.success, true);
    });

    it('should automatically apply cooldown when platform connector returns FloodWait', async () => {
      const mockFloodTg: TelegramTransportAdapter = {
        async sendMessage() {
          throw new Error('420 FLOOD_WAIT_120');
        },
      };

      tgConnector.setTransport(mockFloodTg);

      const envelope = createEnvelope();
      const res = await dispatcher.dispatch(envelope, sampleSenderTg);

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.isFloodWait, true);
      assert.strictEqual(res.retryAfterSeconds, 120);

      // RateLimiter must now have this sender in active cooldown
      assert.ok(rateLimiter.getCooldownRemainingSeconds(sampleSenderTg.id) > 100);

      // Next dispatch attempt must be rejected immediately by RateLimiter without calling connector
      const nextRes = await dispatcher.dispatch(envelope, sampleSenderTg);
      assert.strictEqual(nextRes.success, false);
      assert.strictEqual(nextRes.status, 'REJECTED');
      assert.strictEqual(nextRes.errorCode, 'SENDER_IN_COOLDOWN');
    });

    it('should return error when channel is not supported', async () => {
      const envelope = createEnvelope({ channel: 'UNKNOWN_PLATFORM' });
      const weirdSender: SenderAccount = { ...sampleSenderTg, channel: 'UNKNOWN_PLATFORM' };

      const res = await dispatcher.dispatch(envelope, weirdSender);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.errorCode, 'UNSUPPORTED_CHANNEL');
    });
  });
});
