import { Injectable } from '@nestjs/common';
import { assertValidTenantId } from '../tenant/tenant-scope';
import {
  ChannelType,
  InFlightTask,
  MessageQueueEnvelope,
  QueueConsumerState,
  QUEUE_TOPOLOGY,
} from './queue.types';

export type KillSwitchScope = 'GLOBAL' | 'TENANT' | 'CHANNEL';

export interface KillSwitchActivationOptions {
  readonly reason: string;
  readonly triggeredBy: string;
  readonly tenantId?: string;
  readonly channel?: ChannelType;
  readonly abortInFlightImmediately?: boolean;
}

export interface KillSwitchStatus {
  readonly isGlobalActive: boolean;
  readonly activatedAt?: Date | null;
  readonly reason?: string | null;
  readonly triggeredBy?: string | null;
  readonly tenantOverrides: Readonly<Record<string, {
    readonly isActive: boolean;
    readonly activatedAt: Date;
    readonly reason: string;
  }>>;
  readonly channelOverrides: Readonly<Record<string, {
    readonly isActive: boolean;
    readonly activatedAt: Date;
    readonly reason: string;
  }>>;
}

export class KillSwitchActiveError extends Error {
  public readonly code = 'KILL_SWITCH_ACTIVE';
  public readonly scope: KillSwitchScope;
  public readonly tenantId?: string;
  public readonly channel?: string;

  constructor(message: string, scope: KillSwitchScope, tenantId?: string, channel?: string) {
    super(message);
    this.name = 'KillSwitchActiveError';
    this.scope = scope;
    this.tenantId = tenantId;
    this.channel = channel;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InFlightTaskAbortedError extends Error {
  public readonly code = 'IN_FLIGHT_TASK_ABORTED';
  public readonly taskId: string;
  public readonly messageId: string;

  constructor(taskId: string, messageId: string, reason: string) {
    super(`In-flight task '${taskId}' (message: '${messageId}') was aborted by Kill Switch: ${reason}`);
    this.name = 'InFlightTaskAbortedError';
    this.taskId = taskId;
    this.messageId = messageId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * KillSwitchService: Emergency Kill Switch Core
 *
 * Implements 3 safe emergency stop behaviors:
 * 1) Stop New Admissions (canAdmit, admitMessage)
 * 2) Manage In-Flight Tasks (register, complete, fail, abort on trigger)
 * 3) Suspend Queue Consumers (suspendConsumers, resumeConsumers, isConsumerSuspended)
 */
@Injectable()
export class KillSwitchService {
  private globalActive = false;
  private globalActivatedAt: Date | null = null;
  private globalReason: string | null = null;
  private globalTriggeredBy: string | null = null;

  // Tenant-scoped switches: tenantId -> { isActive, activatedAt, reason }
  private readonly tenantSwitches = new Map<
    string,
    { isActive: boolean; activatedAt: Date; reason: string }
  >();

  // Channel-scoped switches: channel -> { isActive, activatedAt, reason }
  private readonly channelSwitches = new Map<
    string,
    { isActive: boolean; activatedAt: Date; reason: string }
  >();

  // In-flight active tasks: taskId -> InFlightTask
  private readonly inFlightTasks = new Map<string, InFlightTask>();

  // Consumers suspended state: queueName -> QueueConsumerState
  private readonly suspendedConsumers = new Map<string, QueueConsumerState>();

  // Event listeners for audit/broadcast
  private readonly listeners: Array<(event: {
    type: 'ACTIVATED' | 'DEACTIVATED' | 'IN_FLIGHT_ABORTED' | 'CONSUMERS_SUSPENDED' | 'CONSUMERS_RESUMED';
    scope: KillSwitchScope;
    details: Record<string, unknown>;
    timestamp: Date;
  }) => void> = [];

  // -------------------------------------------------------------
  // 1. BEHAVIOR 1: STOP NEW ADMISSIONS
  // -------------------------------------------------------------

  /**
   * Activates the emergency Kill Switch.
   */
  public activate(options: KillSwitchActivationOptions): void {
    const now = new Date();

    if (options.tenantId) {
      const validTenant = assertValidTenantId(options.tenantId);
      this.tenantSwitches.set(validTenant, {
        isActive: true,
        activatedAt: now,
        reason: options.reason,
      });

      this.emitEvent('ACTIVATED', 'TENANT', {
        tenantId: validTenant,
        reason: options.reason,
        triggeredBy: options.triggeredBy,
      });

      if (options.abortInFlightImmediately) {
        this.abortInFlightTasks({ tenantId: validTenant, reason: options.reason });
      }
      return;
    }

    if (options.channel) {
      const normalizedChannel = options.channel.toUpperCase();
      this.channelSwitches.set(normalizedChannel, {
        isActive: true,
        activatedAt: now,
        reason: options.reason,
      });

      this.emitEvent('ACTIVATED', 'CHANNEL', {
        channel: normalizedChannel,
        reason: options.reason,
        triggeredBy: options.triggeredBy,
      });

      if (options.abortInFlightImmediately) {
        this.abortInFlightTasks({ channel: normalizedChannel, reason: options.reason });
      }
      return;
    }

    // Global activation
    this.globalActive = true;
    this.globalActivatedAt = now;
    this.globalReason = options.reason;
    this.globalTriggeredBy = options.triggeredBy;

    // Automatically suspend outbound dispatch consumers
    this.suspendConsumerQueue(QUEUE_TOPOLOGY.QUEUES.OUTBOUND_DISPATCH, 'GLOBAL');
    this.suspendConsumerQueue(QUEUE_TOPOLOGY.QUEUES.OUTBOUND_RETRY, 'GLOBAL');

    this.emitEvent('ACTIVATED', 'GLOBAL', {
      reason: options.reason,
      triggeredBy: options.triggeredBy,
    });

    if (options.abortInFlightImmediately) {
      this.abortInFlightTasks({ reason: options.reason });
    }
  }

  /**
   * Deactivates the Kill Switch for global or specified scope.
   */
  public deactivate(scope: { tenantId?: string; channel?: ChannelType } = {}): void {
    if (scope.tenantId) {
      const validTenant = assertValidTenantId(scope.tenantId);
      this.tenantSwitches.delete(validTenant);
      this.emitEvent('DEACTIVATED', 'TENANT', { tenantId: validTenant });
      return;
    }

    if (scope.channel) {
      const normalizedChannel = scope.channel.toUpperCase();
      this.channelSwitches.delete(normalizedChannel);
      this.emitEvent('DEACTIVATED', 'CHANNEL', { channel: normalizedChannel });
      return;
    }

    // Global deactivation
    this.globalActive = false;
    this.globalActivatedAt = null;
    this.globalReason = null;
    this.globalTriggeredBy = null;

    this.resumeConsumerQueue(QUEUE_TOPOLOGY.QUEUES.OUTBOUND_DISPATCH);
    this.resumeConsumerQueue(QUEUE_TOPOLOGY.QUEUES.OUTBOUND_RETRY);

    this.emitEvent('DEACTIVATED', 'GLOBAL', {});
  }

  /**
   * Checks whether new message admissions are allowed.
   * Returns true if allowed, false if stopped by Kill Switch.
   */
  public canAdmit(tenantId: string, channel?: ChannelType): boolean {
    const validTenant = assertValidTenantId(tenantId);

    if (this.globalActive) {
      return false;
    }

    const tenantSwitch = this.tenantSwitches.get(validTenant);
    if (tenantSwitch?.isActive) {
      return false;
    }

    if (channel) {
      const channelSwitch = this.channelSwitches.get(channel.toUpperCase());
      if (channelSwitch?.isActive) {
        return false;
      }
    }

    return true;
  }

  /**
   * Asserts whether new admission is allowed, throws KillSwitchActiveError if stopped.
   */
  public assertCanAdmit(tenantId: string, channel?: ChannelType): void {
    const validTenant = assertValidTenantId(tenantId);

    if (this.globalActive) {
      throw new KillSwitchActiveError(
        `Global Kill Switch is ACTIVE: ${this.globalReason ?? 'Emergency stop'}`,
        'GLOBAL',
      );
    }

    const tenantSwitch = this.tenantSwitches.get(validTenant);
    if (tenantSwitch?.isActive) {
      throw new KillSwitchActiveError(
        `Tenant '${validTenant}' Kill Switch is ACTIVE: ${tenantSwitch.reason}`,
        'TENANT',
        validTenant,
      );
    }

    if (channel) {
      const normalizedChannel = channel.toUpperCase();
      const channelSwitch = this.channelSwitches.get(normalizedChannel);
      if (channelSwitch?.isActive) {
        throw new KillSwitchActiveError(
          `Channel '${normalizedChannel}' Kill Switch is ACTIVE: ${channelSwitch.reason}`,
          'CHANNEL',
          undefined,
          normalizedChannel,
        );
      }
    }
  }

  /**
   * Validates and admits a new message for processing.
   * Throws KillSwitchActiveError if kill switch is triggered.
   */
  public admitMessage(envelope: MessageQueueEnvelope): MessageQueueEnvelope {
    this.assertCanAdmit(envelope.tenantId, envelope.channel);
    return Object.freeze({ ...envelope });
  }

  // -------------------------------------------------------------
  // 2. BEHAVIOR 2: MANAGE IN-FLIGHT TASKS
  // -------------------------------------------------------------

  /**
   * Registers a task as currently in-flight.
   * Fails-closed if Kill Switch is already active.
   */
  public registerInFlightTask(
    taskId: string,
    envelope: MessageQueueEnvelope,
  ): InFlightTask {
    this.assertCanAdmit(envelope.tenantId, envelope.channel);

    if (this.inFlightTasks.has(taskId)) {
      throw new Error(`In-flight task '${taskId}' is already registered.`);
    }

    const task: InFlightTask = {
      taskId,
      messageId: envelope.messageId,
      tenantId: envelope.tenantId,
      channel: envelope.channel,
      senderAccountId: envelope.senderAccountId,
      startedAt: new Date(),
      abortController: new AbortController(),
      envelope,
      status: 'PROCESSING',
    };

    this.inFlightTasks.set(taskId, task);
    return task;
  }

  /**
   * Completes an in-flight task normally.
   */
  public completeInFlightTask(taskId: string): void {
    const task = this.inFlightTasks.get(taskId);
    if (task) {
      task.status = 'COMPLETED';
      this.inFlightTasks.delete(taskId);
    }
  }

  /**
   * Marks an in-flight task as failed.
   */
  public failInFlightTask(taskId: string, _error?: unknown): void {
    const task = this.inFlightTasks.get(taskId);
    if (task) {
      task.status = 'FAILED';
      this.inFlightTasks.delete(taskId);
    }
  }

  /**
   * Aborts in-flight tasks matching the given filter (or all if filter empty).
   * Signals their AbortController to cleanly abort I/O and prevent duplicate dispatch.
   */
  public abortInFlightTasks(filter: {
    tenantId?: string;
    channel?: ChannelType;
    reason?: string;
  } = {}): InFlightTask[] {
    const aborted: InFlightTask[] = [];
    const reason = filter.reason ?? 'Emergency Kill Switch Abort';

    for (const [taskId, task] of this.inFlightTasks.entries()) {
      if (filter.tenantId && task.tenantId !== filter.tenantId) {
        continue;
      }
      if (filter.channel && task.channel.toUpperCase() !== filter.channel.toUpperCase()) {
        continue;
      }

      task.status = 'ABORTED';
      task.abortController.abort(new InFlightTaskAbortedError(taskId, task.messageId, reason));
      aborted.push(task);
      this.inFlightTasks.delete(taskId);

      this.emitEvent('IN_FLIGHT_ABORTED', filter.tenantId ? 'TENANT' : filter.channel ? 'CHANNEL' : 'GLOBAL', {
        taskId,
        messageId: task.messageId,
        tenantId: task.tenantId,
        channel: task.channel,
        reason,
      });
    }

    return aborted;
  }

  public getInFlightTask(taskId: string): InFlightTask | undefined {
    return this.inFlightTasks.get(taskId);
  }

  public getInFlightTasksCount(tenantId?: string): number {
    if (!tenantId) {
      return this.inFlightTasks.size;
    }
    const validTenant = assertValidTenantId(tenantId);
    let count = 0;
    for (const task of this.inFlightTasks.values()) {
      if (task.tenantId === validTenant) {
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------
  // 3. BEHAVIOR 3: SUSPEND PENDING QUEUE CONSUMERS
  // -------------------------------------------------------------

  /**
   * Suspends consumption on a RabbitMQ queue (stops pulling messages, preserving queue contents).
   */
  public suspendConsumerQueue(queueName: string, channel: ChannelType = 'ALL'): QueueConsumerState {
    const existing = this.suspendedConsumers.get(queueName);
    if (existing?.isSuspended) {
      return existing;
    }

    const state: QueueConsumerState = {
      queueName,
      channel,
      isSuspended: true,
      suspendedAt: new Date(),
      messageCount: existing?.messageCount ?? 0,
      consumerCount: 0,
    };

    this.suspendedConsumers.set(queueName, state);
    this.emitEvent('CONSUMERS_SUSPENDED', 'GLOBAL', { queueName, channel });
    return state;
  }

  /**
   * Resumes consumption on a RabbitMQ queue.
   */
  public resumeConsumerQueue(queueName: string): QueueConsumerState | null {
    const existing = this.suspendedConsumers.get(queueName);
    if (!existing) {
      return null;
    }

    const resumedState: QueueConsumerState = {
      queueName,
      channel: existing.channel,
      isSuspended: false,
      suspendedAt: null,
      messageCount: existing.messageCount,
      consumerCount: 1,
    };

    this.suspendedConsumers.delete(queueName);
    this.emitEvent('CONSUMERS_RESUMED', 'GLOBAL', { queueName });
    return resumedState;
  }

  /**
   * Checks if consumers for a queue are suspended.
   */
  public isConsumerSuspended(queueName: string): boolean {
    if (this.globalActive) {
      return true;
    }
    return this.suspendedConsumers.get(queueName)?.isSuspended ?? false;
  }

  // -------------------------------------------------------------
  // AUDIT & STATE INSPECTION
  // -------------------------------------------------------------

  public getStatus(): KillSwitchStatus {
    const tenantObj: Record<string, { isActive: boolean; activatedAt: Date; reason: string }> = {};
    for (const [k, v] of this.tenantSwitches.entries()) {
      tenantObj[k] = { ...v };
    }

    const channelObj: Record<string, { isActive: boolean; activatedAt: Date; reason: string }> = {};
    for (const [k, v] of this.channelSwitches.entries()) {
      channelObj[k] = { ...v };
    }

    return {
      isGlobalActive: this.globalActive,
      activatedAt: this.globalActivatedAt,
      reason: this.globalReason,
      triggeredBy: this.globalTriggeredBy,
      tenantOverrides: Object.freeze(tenantObj),
      channelOverrides: Object.freeze(channelObj),
    };
  }

  public onEvent(
    listener: (event: {
      type: 'ACTIVATED' | 'DEACTIVATED' | 'IN_FLIGHT_ABORTED' | 'CONSUMERS_SUSPENDED' | 'CONSUMERS_RESUMED';
      scope: KillSwitchScope;
      details: Record<string, unknown>;
      timestamp: Date;
    }) => void,
  ): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  private emitEvent(
    type: 'ACTIVATED' | 'DEACTIVATED' | 'IN_FLIGHT_ABORTED' | 'CONSUMERS_SUSPENDED' | 'CONSUMERS_RESUMED',
    scope: KillSwitchScope,
    details: Record<string, unknown>,
  ): void {
    const event = {
      type,
      scope,
      details,
      timestamp: new Date(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Prevent listener failures from breaking kill switch core execution
      }
    }
  }

  /**
   * Reset all switches (for testing/cleanup only).
   */
  public resetAll(): void {
    this.globalActive = false;
    this.globalActivatedAt = null;
    this.globalReason = null;
    this.globalTriggeredBy = null;
    this.tenantSwitches.clear();
    this.channelSwitches.clear();
    this.inFlightTasks.clear();
    this.suspendedConsumers.clear();
  }
}
