import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  SenderRoutingEngine,
  SenderAccount,
  NoEligibleSenderError,
  SenderNotFoundError,
  SenderAlreadyExistsError,
  InvalidSenderConfigError,
} from '../src/senders';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';

describe('Sender Routing Engine (TASK-0029)', () => {
  const TENANT_A = 'org_test_sender_alpha';
  const TENANT_B = 'org_test_sender_beta';
  const RECIPIENT_PHONE = '+989121111111';

  describe('AC-01: Optimal sender selection ranking & load balancing', () => {
    it('prioritizes mutual contact sender over non-mutual senders even with lower quota', () => {
      const engine = new SenderRoutingEngine();

      // Sender 1: Non-mutual, large remaining quota (100)
      engine.registerSender({
        id: 'sender_high_quota',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'MANAGED',
        dailyQuota: 100,
        sentTodayCount: 0,
        activeWorkloadCount: 0,
      });

      // Sender 2: Mutual contact, smaller remaining quota (20)
      engine.registerSender({
        id: 'sender_mutual',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 20,
        sentTodayCount: 0,
        activeWorkloadCount: 5,
      });

      // Mark mutual contact
      engine.recordMutualContact(TENANT_A, 'sender_mutual', RECIPIENT_PHONE);

      const decision = engine.selectOptimalSender({
        tenantId: TENANT_A,
        contactPhone: RECIPIENT_PHONE,
        channel: 'TELEGRAM',
      });

      assert.equal(decision.selectedSender.id, 'sender_mutual');
      assert.equal(decision.isMutualContact, true);
      assert.equal(decision.evaluatedCandidatesCount, 2);
      assert.equal(decision.eligibleCandidatesCount, 2);
      assert.match(decision.selectionReason, /mutual contact/i);
    });

    it('prioritizes higher remaining daily quota when mutual contact status is identical', () => {
      const engine = new SenderRoutingEngine();

      // Account 1: 50 quota, 40 used -> 10 remaining
      engine.registerSender({
        id: 'sender_quota_10',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
        sentTodayCount: 40,
        activeWorkloadCount: 0,
      });

      // Account 2: 50 quota, 15 used -> 35 remaining
      engine.registerSender({
        id: 'sender_quota_35',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
        sentTodayCount: 15,
        activeWorkloadCount: 0,
      });

      const decision = engine.selectOptimalSender({
        tenantId: TENANT_A,
        contactPhone: RECIPIENT_PHONE,
        channel: 'TELEGRAM',
      });

      assert.equal(decision.selectedSender.id, 'sender_quota_35');
      assert.equal(decision.remainingQuota, 35);
    });

    it('prioritizes lower active workload (load balancing) when remaining quota is identical', () => {
      const engine = new SenderRoutingEngine();

      // Both have 50 remaining quota, but sender_busy has 10 active jobs
      engine.registerSender({
        id: 'sender_busy',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 100,
        sentTodayCount: 50,
        activeWorkloadCount: 10,
      });

      // sender_idle has only 1 active job
      engine.registerSender({
        id: 'sender_idle',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 100,
        sentTodayCount: 50,
        activeWorkloadCount: 1,
      });

      const decision = engine.selectOptimalSender({
        tenantId: TENANT_A,
        contactPhone: RECIPIENT_PHONE,
        channel: 'TELEGRAM',
      });

      assert.equal(decision.selectedSender.id, 'sender_idle');
      assert.equal(decision.selectedSender.activeWorkloadCount, 1);
    });

    it('prioritizes preferred sender type when specified and candidates are non-mutual', () => {
      const engine = new SenderRoutingEngine();

      engine.registerSender({
        id: 'sender_managed',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'MANAGED',
        dailyQuota: 100,
        sentTodayCount: 0,
        activeWorkloadCount: 0,
      });

      engine.registerSender({
        id: 'sender_connected',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 100,
        sentTodayCount: 0,
        activeWorkloadCount: 0,
      });

      // Request prefers CUSTOMER_CONNECTED
      const decision = engine.selectOptimalSender({
        tenantId: TENANT_A,
        contactPhone: RECIPIENT_PHONE,
        channel: 'TELEGRAM',
        preferredType: 'CUSTOMER_CONNECTED',
      });

      assert.equal(decision.selectedSender.id, 'sender_connected');
      assert.equal(decision.selectedSender.type, 'CUSTOMER_CONNECTED');
    });

    it('respects required tags filter', () => {
      const engine = new SenderRoutingEngine();

      engine.registerSender({
        id: 'sender_general',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'MANAGED',
        dailyQuota: 100,
        tags: ['general'],
      });

      engine.registerSender({
        id: 'sender_sales',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'MANAGED',
        dailyQuota: 100,
        tags: ['sales', 'priority'],
      });

      const decision = engine.selectOptimalSender({
        tenantId: TENANT_A,
        contactPhone: RECIPIENT_PHONE,
        channel: 'TELEGRAM',
        requiredTags: ['sales', 'priority'],
      });

      assert.equal(decision.selectedSender.id, 'sender_sales');
    });

    it('supports custom candidates list passed directly in request', () => {
      const engine = new SenderRoutingEngine();

      const customCandidates: SenderAccount[] = [
        {
          id: 'custom_1',
          tenantId: TENANT_A,
          channel: 'TELEGRAM',
          type: 'MANAGED',
          status: 'ACTIVE',
          dailyQuota: 50,
          sentTodayCount: 10,
          activeWorkloadCount: 2,
        },
        {
          id: 'custom_2',
          tenantId: TENANT_A,
          channel: 'TELEGRAM',
          type: 'MANAGED',
          status: 'ACTIVE',
          dailyQuota: 50,
          sentTodayCount: 5,
          activeWorkloadCount: 0,
        },
      ];

      const decision = engine.selectOptimalSender({
        tenantId: TENANT_A,
        contactPhone: RECIPIENT_PHONE,
        channel: 'TELEGRAM',
        candidates: customCandidates,
      });

      assert.equal(decision.selectedSender.id, 'custom_2');
      assert.equal(decision.remainingQuota, 45);
    });
  });

  describe('AC-02: Strict health status & quota filtering', () => {
    it('strictly excludes BANNED sender accounts', () => {
      const engine = new SenderRoutingEngine();

      engine.registerSender({
        id: 'sender_banned',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        status: 'BANNED',
        dailyQuota: 100,
        sentTodayCount: 0,
        activeWorkloadCount: 0,
      });

      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: TENANT_A,
            contactPhone: RECIPIENT_PHONE,
            channel: 'TELEGRAM',
          }),
        (err) => {
          assert.ok(err instanceof NoEligibleSenderError);
          assert.equal(err.rejectionReasons.STATUS_BANNED, 1);
          return true;
        },
      );
    });

    it('strictly excludes DISABLED sender accounts', () => {
      const engine = new SenderRoutingEngine();

      engine.registerSender({
        id: 'sender_disabled',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'MANAGED',
        status: 'DISABLED',
        dailyQuota: 100,
        sentTodayCount: 0,
        activeWorkloadCount: 0,
      });

      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: TENANT_A,
            contactPhone: RECIPIENT_PHONE,
            channel: 'TELEGRAM',
          }),
        (err) => {
          assert.ok(err instanceof NoEligibleSenderError);
          assert.equal(err.rejectionReasons.STATUS_DISABLED, 1);
          return true;
        },
      );
    });

    it('strictly excludes accounts in COOLDOWN (FloodWait) until cooldown expires', () => {
      const engine = new SenderRoutingEngine();

      const sender = engine.registerSender({
        id: 'sender_flood',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 100,
      });

      // Simulate receiving FloodWait: 60 seconds cooldown
      const now = new Date('2026-11-10T12:00:00Z');
      const cooldownUntil = new Date('2026-11-10T12:01:00Z');

      const updated = engine.markCooldown(TENANT_A, sender.id, 60, 'Telegram FloodWait 60s');
      assert.equal(updated.status, 'COOLDOWN');

      // Attempting to select at 12:00:30 (during cooldown) -> Rejected
      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: TENANT_A,
            contactPhone: RECIPIENT_PHONE,
            channel: 'TELEGRAM',
            now: new Date('2026-11-10T12:00:30Z'),
          }),
        (err) => {
          assert.ok(err instanceof NoEligibleSenderError);
          assert.equal(err.rejectionReasons.STATUS_COOLDOWN, 1);
          return true;
        },
      );

      // Attempting to select at 12:01:01 (after cooldown) -> Auto-recovered and eligible
      const decision = engine.selectOptimalSender({
        tenantId: TENANT_A,
        contactPhone: RECIPIENT_PHONE,
        channel: 'TELEGRAM',
        now: new Date(Date.now() + 65 * 1000), // comfortably past cooldown
      });

      assert.equal(decision.selectedSender.id, 'sender_flood');
    });

    it('strictly excludes accounts with exhausted daily quota', () => {
      const engine = new SenderRoutingEngine();

      engine.registerSender({
        id: 'sender_exhausted',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
        sentTodayCount: 50, // 0 remaining
        activeWorkloadCount: 0,
      });

      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: TENANT_A,
            contactPhone: RECIPIENT_PHONE,
            channel: 'TELEGRAM',
          }),
        (err) => {
          assert.ok(err instanceof NoEligibleSenderError);
          assert.equal(err.rejectionReasons.QUOTA_EXHAUSTED, 1);
          return true;
        },
      );
    });

    it('dynamically tracks recordDispatch, completeDispatch, and daily quota reset', () => {
      const engine = new SenderRoutingEngine();

      const sender = engine.registerSender({
        id: 'sender_dispatch',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 2,
        sentTodayCount: 0,
        activeWorkloadCount: 0,
      });

      // Dispatch 1
      engine.recordDispatch(TENANT_A, sender.id);
      let s = engine.getSender(TENANT_A, sender.id);
      assert.equal(s?.sentTodayCount, 1);
      assert.equal(s?.activeWorkloadCount, 1);

      // Dispatch 2 (hits quota)
      engine.recordDispatch(TENANT_A, sender.id);
      s = engine.getSender(TENANT_A, sender.id);
      assert.equal(s?.sentTodayCount, 2);
      assert.equal(s?.activeWorkloadCount, 2);

      // Now quota is exhausted -> routing should fail
      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: TENANT_A,
            contactPhone: RECIPIENT_PHONE,
            channel: 'TELEGRAM',
          }),
        (err) => err instanceof NoEligibleSenderError,
      );

      // Complete 1 job -> activeWorkload drops to 1, but sentToday is still 2
      engine.completeDispatch(TENANT_A, sender.id);
      s = engine.getSender(TENANT_A, sender.id);
      assert.equal(s?.activeWorkloadCount, 1);
      assert.equal(s?.sentTodayCount, 2);

      // Reset daily quota (midnight routine)
      engine.resetDailyQuotas(TENANT_A);
      s = engine.getSender(TENANT_A, sender.id);
      assert.equal(s?.sentTodayCount, 0);

      // Now eligible again!
      const decision = engine.selectOptimalSender({
        tenantId: TENANT_A,
        contactPhone: RECIPIENT_PHONE,
        channel: 'TELEGRAM',
      });
      assert.equal(decision.selectedSender.id, 'sender_dispatch');
    });

    it('allows marking an account as permanently BANNED', () => {
      const engine = new SenderRoutingEngine();
      engine.registerSender({
        id: 'sender_temp',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
      });

      engine.markBanned(TENANT_A, 'sender_temp', 'Platform TOS violation');
      const sender = engine.getSender(TENANT_A, 'sender_temp');
      assert.equal(sender?.status, 'BANNED');
      assert.equal(sender?.cooldownReason, 'Platform TOS violation');
    });
  });

  describe('AC-03: Zero-exception tenant boundary isolation', () => {
    it('never considers sender accounts belonging to other tenants', () => {
      const engine = new SenderRoutingEngine();

      // Register healthy account in Tenant B
      engine.registerSender({
        id: 'sender_tenant_b',
        tenantId: TENANT_B,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 100,
        sentTodayCount: 0,
        activeWorkloadCount: 0,
      });

      // Tenant A has NO accounts registered
      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: TENANT_A,
            contactPhone: RECIPIENT_PHONE,
            channel: 'TELEGRAM',
          }),
        (err) => {
          assert.ok(err instanceof NoEligibleSenderError);
          assert.equal(err.tenantId, TENANT_A);
          assert.equal(err.totalEvaluated, 0);
          return true;
        },
      );
    });

    it('rejects candidate list containing another tenant accounts during custom candidate routing', () => {
      const engine = new SenderRoutingEngine();

      const rogueCandidates: SenderAccount[] = [
        {
          id: 'rogue_sender',
          tenantId: 'different_tenant',
          channel: 'TELEGRAM',
          type: 'MANAGED',
          status: 'ACTIVE',
          dailyQuota: 100,
          sentTodayCount: 0,
          activeWorkloadCount: 0,
        },
      ];

      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: TENANT_A,
            contactPhone: RECIPIENT_PHONE,
            channel: 'TELEGRAM',
            candidates: rogueCandidates,
          }),
        (err) => {
          assert.ok(err instanceof NoEligibleSenderError);
          assert.equal(err.rejectionReasons.WRONG_TENANT, 1);
          return true;
        },
      );
    });

    it('rejects missing or empty tenant_id with TenantScopeMissingError', () => {
      const engine = new SenderRoutingEngine();

      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: '',
            contactPhone: RECIPIENT_PHONE,
          }),
        (err) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: '   ',
            contactPhone: RECIPIENT_PHONE,
          }),
        (err) => err instanceof TenantScopeMissingError,
      );
    });

    it('rejects invalid characters in tenant_id with TenantScopeInvalidError', () => {
      const engine = new SenderRoutingEngine();

      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: 'invalid tenant with spaces',
            contactPhone: RECIPIENT_PHONE,
          }),
        (err) => err instanceof TenantScopeInvalidError,
      );

      assert.throws(
        () =>
          engine.selectOptimalSender({
            tenantId: 'tenant;DROP TABLE;',
            contactPhone: RECIPIENT_PHONE,
          }),
        (err) => err instanceof TenantScopeInvalidError,
      );
    });

    it('isolates mutual contact status strictly by tenant', () => {
      const engine = new SenderRoutingEngine();

      engine.registerSender({
        id: 'sender_a',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
      });

      engine.registerSender({
        id: 'sender_b',
        tenantId: TENANT_B,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
      });

      // Record mutual contact in Tenant A only
      engine.recordMutualContact(TENANT_A, 'sender_a', RECIPIENT_PHONE);

      assert.equal(engine.isMutualContact(TENANT_A, 'sender_a', RECIPIENT_PHONE), true);
      assert.equal(engine.isMutualContact(TENANT_B, 'sender_b', RECIPIENT_PHONE), false);
      assert.equal(engine.isMutualContact(TENANT_B, 'sender_a', RECIPIENT_PHONE), false);
    });

    it('strictly isolates listSenders and getSender by tenant', () => {
      const engine = new SenderRoutingEngine();

      engine.registerSender({
        id: 's_alpha',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
      });

      engine.registerSender({
        id: 's_beta',
        tenantId: TENANT_B,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
      });

      const sendersA = engine.listSenders(TENANT_A);
      assert.equal(sendersA.length, 1);
      assert.equal(sendersA[0].id, 's_alpha');

      const sendersB = engine.listSenders(TENANT_B);
      assert.equal(sendersB.length, 1);
      assert.equal(sendersB[0].id, 's_beta');

      assert.equal(engine.getSender(TENANT_A, 's_alpha')?.id, 's_alpha');
      assert.equal(engine.getSender(TENANT_A, 's_beta'), undefined);
    });
  });

  describe('Validation & Edge Cases', () => {
    it('rejects duplicate sender registration with SenderAlreadyExistsError', () => {
      const engine = new SenderRoutingEngine();

      engine.registerSender({
        id: 'dup_sender',
        tenantId: TENANT_A,
        channel: 'TELEGRAM',
        type: 'CUSTOMER_CONNECTED',
        dailyQuota: 50,
      });

      assert.throws(
        () =>
          engine.registerSender({
            id: 'dup_sender',
            tenantId: TENANT_A,
            channel: 'TELEGRAM',
            type: 'CUSTOMER_CONNECTED',
            dailyQuota: 50,
          }),
        (err) => err instanceof SenderAlreadyExistsError,
      );
    });

    it('rejects invalid sender configuration', () => {
      const engine = new SenderRoutingEngine();

      assert.throws(
        () =>
          engine.registerSender({
            id: '',
            tenantId: TENANT_A,
            channel: 'TELEGRAM',
            type: 'CUSTOMER_CONNECTED',
            dailyQuota: 50,
          }),
        (err) => err instanceof InvalidSenderConfigError,
      );

      assert.throws(
        () =>
          engine.registerSender({
            id: 'valid_id',
            tenantId: TENANT_A,
            channel: 'TELEGRAM',
            type: 'CUSTOMER_CONNECTED',
            dailyQuota: -5,
          }),
        (err) => err instanceof InvalidSenderConfigError,
      );
    });

    it('throws SenderNotFoundError when mutating non-existent sender', () => {
      const engine = new SenderRoutingEngine();

      assert.throws(
        () => engine.recordDispatch(TENANT_A, 'non_existent'),
        (err) => err instanceof SenderNotFoundError,
      );

      assert.throws(
        () => engine.completeDispatch(TENANT_A, 'non_existent'),
        (err) => err instanceof SenderNotFoundError,
      );

      assert.throws(
        () => engine.markCooldown(TENANT_A, 'non_existent', 60),
        (err) => err instanceof SenderNotFoundError,
      );

      assert.throws(
        () => engine.markBanned(TENANT_A, 'non_existent'),
        (err) => err instanceof SenderNotFoundError,
      );
    });
  });
});
