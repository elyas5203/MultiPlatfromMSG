/**
 * RabbitMQ Queue & Messaging Delivery Contract Types
 *
 * Implements architectural contracts, event structures, and queue definitions
 * for MultiPlatformMsg messaging core (Phase 4B).
 *
 * Compliant with:
 * - docs/ai/architecture/MODULE_MAP.md (Messaging & Delivery owns Message ID & Status)
 * - docs/ai/architecture/DATA_MODEL.md
 * - docs/ai/product/DEVELOPMENT_PHASES.md
 * - docs/ai/governance/ABSOLUTE_PROHIBITIONS.md
 */

export type ChannelType = 'TELEGRAM' | 'BALE' | 'SMS' | string;

export type MessageOrigin = 'CAMPAIGN' | 'INBOX_REPLY' | 'SYSTEM_NOTIFICATION';

export type MessageDeliveryStatus =
  | 'QUEUED'
  | 'ADMITTED'
  | 'DISPATCHING'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'REJECTED'
  | 'KILLED_ABORTED'
  | 'KILLED_SUSPENDED';

/**
 * Standard RabbitMQ Queue Topologies
 */
export const QUEUE_TOPOLOGY = {
  EXCHANGE: 'msg.direct',
  EXCHANGE_DLX: 'msg.dlx',
  EXCHANGE_CONTROL: 'msg.control',
  QUEUES: {
    INBOUND_EVENTS: 'msg.events.inbound',
    OUTBOUND_DISPATCH: 'msg.dispatch.outbound',
    OUTBOUND_RETRY: 'msg.dispatch.retry',
    DEAD_LETTER: 'msg.dead-letter',
    KILL_SWITCH_BROADCAST: 'msg.control.kill-switch',
  },
  ROUTING_KEYS: {
    DISPATCH: 'msg.dispatch.*',
    INBOUND: 'msg.inbound.*',
    RETRY: 'msg.retry',
    DEAD: 'msg.dead',
    KILL_SIGNAL: 'msg.control.kill',
  },
} as const;

/**
 * Standard Message Envelope for RabbitMQ Queues
 */
export interface MessageQueueEnvelope {
  readonly messageId: string;
  readonly tenantId: string;
  readonly channel: ChannelType;
  readonly origin: MessageOrigin;
  readonly recipientContactId?: string;
  readonly recipientPhone?: string;
  readonly senderAccountId?: string;
  readonly payload: Readonly<{
    text?: string;
    mediaUrl?: string;
    mediaType?: string;
    attributes?: Record<string, unknown>;
  }>;
  readonly correlationId?: string;
  readonly campaignId?: string;
  readonly conversationId?: string;
  readonly priority?: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string; // ISO-8601
  readonly traceId?: string;
}

/**
 * In-Flight Task Descriptor
 */
export interface InFlightTask {
  readonly taskId: string;
  readonly messageId: string;
  readonly tenantId: string;
  readonly channel: ChannelType;
  readonly senderAccountId?: string;
  readonly startedAt: Date;
  readonly abortController: AbortController;
  readonly envelope: MessageQueueEnvelope;
  status: 'PROCESSING' | 'COMPLETED' | 'ABORTED' | 'FAILED';
}

/**
 * State of Consumer Queue Suspension
 */
export interface QueueConsumerState {
  readonly queueName: string;
  readonly channel: ChannelType;
  readonly isSuspended: boolean;
  readonly suspendedAt?: Date | null;
  readonly messageCount: number;
  readonly consumerCount: number;
}
