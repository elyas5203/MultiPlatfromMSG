/**
 * Sender Account & Routing Engine Types
 *
 * Implements architectural contracts and models for MultiPlatformMsg
 * sender account management, multi-channel dispatch, and intelligent routing.
 */

export type SenderChannel = 'TELEGRAM' | 'BALE' | 'SMS' | string;

export type SenderType = 'CUSTOMER_CONNECTED' | 'MANAGED';

export type SenderStatus = 'ACTIVE' | 'COOLDOWN' | 'BANNED' | 'DISABLED';

export interface SenderAccount {
  readonly id: string;
  readonly tenantId: string;
  readonly name?: string;
  readonly channel: SenderChannel;
  readonly type: SenderType;
  readonly status: SenderStatus;
  readonly dailyQuota: number;
  readonly sentTodayCount: number;
  readonly activeWorkloadCount: number;
  readonly cooldownUntil?: Date | null;
  readonly cooldownReason?: string | null;
  readonly lastUsedAt?: Date | null;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RegisterSenderInput {
  readonly id: string;
  readonly tenantId: string;
  readonly name?: string;
  readonly channel: SenderChannel;
  readonly type: SenderType;
  readonly status?: SenderStatus;
  readonly dailyQuota: number;
  readonly sentTodayCount?: number;
  readonly activeWorkloadCount?: number;
  readonly cooldownUntil?: Date | null;
  readonly cooldownReason?: string | null;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RouteMessageRequest {
  readonly tenantId: string;
  readonly contactPhone: string;
  readonly contactId?: string;
  readonly channel?: SenderChannel;
  readonly preferredType?: SenderType;
  readonly requiredTags?: readonly string[];
  /**
   * Optional custom candidate accounts.
   * If omitted, candidates are selected from the engine's registered pool.
   */
  readonly candidates?: readonly SenderAccount[];
  readonly now?: Date;
}

export interface RoutingDecision {
  readonly selectedSender: SenderAccount;
  readonly isMutualContact: boolean;
  readonly remainingQuota: number;
  readonly evaluatedCandidatesCount: number;
  readonly eligibleCandidatesCount: number;
  readonly selectionReason: string;
}

/**
 * Base error class for sender routing operations.
 */
export class SenderRoutingError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'SENDER_ROUTING_ERROR') {
    super(message);
    this.name = 'SenderRoutingError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NoEligibleSenderError extends SenderRoutingError {
  public readonly tenantId: string;
  public readonly channel?: string;
  public readonly contactPhone: string;
  public readonly totalEvaluated: number;
  public readonly rejectionReasons: Readonly<Record<string, number>>;

  constructor(details: {
    tenantId: string;
    channel?: string;
    contactPhone: string;
    totalEvaluated: number;
    rejectionReasons: Record<string, number>;
  }) {
    super(
      `No eligible sender account found for tenant '${details.tenantId}' (channel: '${details.channel ?? 'ANY'}', evaluated: ${details.totalEvaluated}).`,
      'NO_ELIGIBLE_SENDER',
    );
    this.name = 'NoEligibleSenderError';
    this.tenantId = details.tenantId;
    this.channel = details.channel;
    this.contactPhone = details.contactPhone;
    this.totalEvaluated = details.totalEvaluated;
    this.rejectionReasons = Object.freeze({ ...details.rejectionReasons });
  }
}

export class SenderNotFoundError extends SenderRoutingError {
  constructor(senderId: string, tenantId: string) {
    super(`Sender account '${senderId}' not found for tenant '${tenantId}'.`, 'SENDER_NOT_FOUND');
    this.name = 'SenderNotFoundError';
  }
}

export class SenderAlreadyExistsError extends SenderRoutingError {
  constructor(senderId: string) {
    super(`Sender account '${senderId}' is already registered.`, 'SENDER_ALREADY_EXISTS');
    this.name = 'SenderAlreadyExistsError';
  }
}

export class InvalidSenderConfigError extends SenderRoutingError {
  constructor(message: string) {
    super(message, 'INVALID_SENDER_CONFIG');
    this.name = 'InvalidSenderConfigError';
  }
}
