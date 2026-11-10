import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  KillSwitchService,
  KillSwitchActiveError,
  InFlightTaskAbortedError,
  MessageQueueEnvelope,
  QUEUE_TOPOLOGY,
} from '../src/messaging';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';

describe('KillSwitchService (TASK-0028: Emergency Kill Switch Core & Queue Contracts)', () => {
  let service: KillSwitchService;

  const TENANT_A = 'tenant_alpha';
  const TENANT_B = 'tenant_beta';

  function createEnvelope(overrides: Partial<MessageQueueEnvelope> = {}): MessageQueueEnvelope {
    return {
      messageId: 'msg_' + Math.random().toString(36).substring(2, 9),
      tenantId: TENANT_A,
      channel: 'TELEGRAM',
      origin: 'CAMPAIGN',
      recipientPhone: '+989121112233',
      recipientContactId: 'contact_123',
      payload: {
        text: 'Test message payload',
      },
      campaignId: 'camp_456',
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    service = new KillSwitchService();
  });

  describe('Behavior 1: Stop New Admissions (New Admissions Gate)', () => {
    it('allows admissions when kill switch is inactive', () => {
      assert.equal(service.canAdmit(TENANT_A, 'TELEGRAM'), true);
      assert.doesNotThrow(() => service.assertCanAdmit(TENANT_A, 'TELEGRAM'));

      const env = createEnvelope();
      const admitted = service.admitMessage(env);
      assert.equal(admitted.messageId, env.messageId);
    });

    it('blocks admissions globally when global kill switch is activated', () => {
      service.activate({
        reason: 'Severe platform instability',
        triggeredBy: 'admin_security',
      });

      assert.equal(service.canAdmit(TENANT_A, 'TELEGRAM'), false);
      assert.equal(service.canAdmit(TENANT_B, 'BALE'), false);

      assert.throws(
        () => service.assertCanAdmit(TENANT_A, 'TELEGRAM'),
        (err) => {
          assert.ok(err instanceof KillSwitchActiveError);
          assert.equal(err.scope, 'GLOBAL');
          return true;
        },
      );

      const env = createEnvelope();
      assert.throws(() => service.admitMessage(env), KillSwitchActiveError);
    });

    it('blocks admissions strictly per tenant when tenant-scoped switch is activated', () => {
      service.activate({
        tenantId: TENANT_A,
        reason: 'Tenant credit exhaustion and suspect spam',
        triggeredBy: 'billing_sentinel',
      });

      // Tenant A blocked
      assert.equal(service.canAdmit(TENANT_A, 'TELEGRAM'), false);
      assert.throws(
        () => service.assertCanAdmit(TENANT_A, 'TELEGRAM'),
        (err) => {
          assert.ok(err instanceof KillSwitchActiveError);
          assert.equal(err.scope, 'TENANT');
          assert.equal(err.tenantId, TENANT_A);
          return true;
        },
      );

      // Tenant B unaffected
      assert.equal(service.canAdmit(TENANT_B, 'TELEGRAM'), true);
      assert.doesNotThrow(() => service.assertCanAdmit(TENANT_B, 'TELEGRAM'));

      const envB = createEnvelope({ tenantId: TENANT_B });
      assert.doesNotThrow(() => service.admitMessage(envB));
    });

    it('blocks admissions strictly per channel when channel-scoped switch is activated', () => {
      service.activate({
        channel: 'TELEGRAM',
        reason: 'Telegram MTProto upstream network disruption',
        triggeredBy: 'ops_monitor',
      });

      // Telegram blocked across all tenants
      assert.equal(service.canAdmit(TENANT_A, 'TELEGRAM'), false);
      assert.equal(service.canAdmit(TENANT_B, 'TELEGRAM'), false);

      // Bale and SMS unaffected
      assert.equal(service.canAdmit(TENANT_A, 'BALE'), true);
      assert.equal(service.canAdmit(TENANT_B, 'SMS'), true);
    });

    it('restores admissions upon deactivation', () => {
      service.activate({
        tenantId: TENANT_A,
        reason: 'Temp pause',
        triggeredBy: 'admin',
      });
      assert.equal(service.canAdmit(TENANT_A), false);

      service.deactivate({ tenantId: TENANT_A });
      assert.equal(service.canAdmit(TENANT_A), true);
    });

    it('validates tenant_id format on canAdmit and throws TenantScopeMissingError / TenantScopeInvalidError', () => {
      assert.throws(() => service.canAdmit(''), TenantScopeMissingError);
      assert.throws(() => service.canAdmit('   '), TenantScopeMissingError);
      assert.throws(() => service.canAdmit('invalid tenant spaces!'), TenantScopeInvalidError);
    });
  });

  describe('Behavior 2: Manage In-Flight Tasks (In-Flight Tasks Safety)', () => {
    it('registers in-flight task and completes normally', () => {
      const env = createEnvelope();
      const task = service.registerInFlightTask('task_001', env);

      assert.equal(task.taskId, 'task_001');
      assert.equal(task.status, 'PROCESSING');
      assert.equal(service.getInFlightTasksCount(TENANT_A), 1);

      service.completeInFlightTask('task_001');
      assert.equal(service.getInFlightTasksCount(TENANT_A), 0);
      assert.equal(service.getInFlightTask('task_001'), undefined);
    });

    it('handles in-flight task failure', () => {
      const env = createEnvelope();
      service.registerInFlightTask('task_fail', env);
      assert.equal(service.getInFlightTasksCount(), 1);

      service.failInFlightTask('task_fail', new Error('Network timeout'));
      assert.equal(service.getInFlightTasksCount(), 0);
    });

    it('aborts matching in-flight tasks and signals abortController when kill switch aborts', () => {
      const envA = createEnvelope({ tenantId: TENANT_A, messageId: 'msg_a' });
      const envB = createEnvelope({ tenantId: TENANT_B, messageId: 'msg_b' });

      const taskA = service.registerInFlightTask('task_a', envA);
      const taskB = service.registerInFlightTask('task_b', envB);

      let taskAAborted = false;
      let taskBAborted = false;

      taskA.abortController.signal.addEventListener('abort', () => {
        taskAAborted = true;
      });

      taskB.abortController.signal.addEventListener('abort', () => {
        taskBAborted = true;
      });

      // Abort only Tenant A in-flight tasks
      const aborted = service.abortInFlightTasks({
        tenantId: TENANT_A,
        reason: 'Immediate tenant emergency halt',
      });

      assert.equal(aborted.length, 1);
      assert.equal(aborted[0].taskId, 'task_a');
      assert.equal(taskAAborted, true);
      assert.equal(taskBAborted, false);
      assert.equal(service.getInFlightTasksCount(TENANT_A), 0);
      assert.equal(service.getInFlightTasksCount(TENANT_B), 1);
    });

    it('aborts all in-flight tasks when global kill switch activates with abortInFlightImmediately: true', () => {
      const envA = createEnvelope({ tenantId: TENANT_A });
      const envB = createEnvelope({ tenantId: TENANT_B });

      const taskA = service.registerInFlightTask('task_1', envA);
      const taskB = service.registerInFlightTask('task_2', envB);

      let abortCount = 0;
      taskA.abortController.signal.addEventListener('abort', () => abortCount++);
      taskB.abortController.signal.addEventListener('abort', () => abortCount++);

      service.activate({
        reason: 'Emergency shutdown',
        triggeredBy: 'super_admin',
        abortInFlightImmediately: true,
      });

      assert.equal(abortCount, 2);
      assert.equal(service.getInFlightTasksCount(), 0);
    });

    it('rejects duplicate in-flight taskId registration', () => {
      const env = createEnvelope();
      service.registerInFlightTask('task_dup', env);

      assert.throws(
        () => service.registerInFlightTask('task_dup', env),
        /already registered/,
      );
    });

    it('prevents registering in-flight tasks when kill switch is already active (fail-closed)', () => {
      service.activate({
        tenantId: TENANT_A,
        reason: 'Tenant blocked',
        triggeredBy: 'compliance',
      });

      const env = createEnvelope({ tenantId: TENANT_A });
      assert.throws(
        () => service.registerInFlightTask('task_blocked', env),
        KillSwitchActiveError,
      );
    });
  });

  describe('Behavior 3: Suspend Pending Queue Consumers (Pending Queues Protection)', () => {
    it('suspends and resumes specific queue consumers without losing queue contents', () => {
      const queueName = QUEUE_TOPOLOGY.QUEUES.OUTBOUND_DISPATCH;

      assert.equal(service.isConsumerSuspended(queueName), false);

      const suspendedState = service.suspendConsumerQueue(queueName, 'TELEGRAM');
      assert.equal(suspendedState.isSuspended, true);
      assert.equal(service.isConsumerSuspended(queueName), true);

      const resumedState = service.resumeConsumerQueue(queueName);
      assert.equal(resumedState?.isSuspended, false);
      assert.equal(service.isConsumerSuspended(queueName), false);
    });

    it('automatically marks queues suspended when global kill switch is active', () => {
      service.activate({
        reason: 'Global stop',
        triggeredBy: 'sysadmin',
      });

      assert.equal(service.isConsumerSuspended(QUEUE_TOPOLOGY.QUEUES.OUTBOUND_DISPATCH), true);
      assert.equal(service.isConsumerSuspended(QUEUE_TOPOLOGY.QUEUES.OUTBOUND_RETRY), true);
      assert.equal(service.isConsumerSuspended('any.custom.queue'), true);
    });
  });

  describe('Audit Logging & Event Notifications', () => {
    it('emits lifecycle events for audit and dashboard monitoring', () => {
      const events: string[] = [];
      const unsubscribe = service.onEvent((event) => {
        events.push(event.type);
      });

      service.activate({ reason: 'Audit test', triggeredBy: 'test_runner' });
      service.deactivate();

      assert.ok(events.includes('ACTIVATED'));
      assert.ok(events.includes('DEACTIVATED'));

      unsubscribe();
    });

    it('provides snapshot of kill switch status across scopes', () => {
      service.activate({
        tenantId: TENANT_A,
        reason: 'Tenant limit exceeded',
        triggeredBy: 'system',
      });

      service.activate({
        channel: 'BALE',
        reason: 'Bale API maintenance',
        triggeredBy: 'system',
      });

      const status = service.getStatus();
      assert.equal(status.isGlobalActive, false);
      assert.equal(status.tenantOverrides[TENANT_A]?.isActive, true);
      assert.equal(status.channelOverrides['BALE']?.isActive, true);
    });
  });

  describe('Queue Contracts & Topologies Compliance', () => {
    it('exposes defined queue topologies matching architecture contracts', () => {
      assert.equal(QUEUE_TOPOLOGY.EXCHANGE, 'msg.direct');
      assert.equal(QUEUE_TOPOLOGY.QUEUES.OUTBOUND_DISPATCH, 'msg.dispatch.outbound');
      assert.equal(QUEUE_TOPOLOGY.QUEUES.DEAD_LETTER, 'msg.dead-letter');
      assert.equal(QUEUE_TOPOLOGY.ROUTING_KEYS.KILL_SIGNAL, 'msg.control.kill');
    });
  });
});
