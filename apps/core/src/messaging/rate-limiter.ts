/**
 * Dispatch Rate Limiter & Cooldown Manager (Phase 6)
 *
 * Implements per-sender rate limiting, dynamic jitter delays, and platform FloodWait/Cooldown tracking.
 * Compliant with:
 * - docs/ai/architecture/MODULE_MAP.md (Rate limiting & dispatch pacing)
 * - docs/ai/product/CHANNEL_RESEARCH.md (Anti-spam jitter, randomized delays, zero ban policy)
 */

import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from './queue.types';

export interface RateLimiterConfig {
  readonly defaultMinDelayMs: number;
  readonly defaultMaxDelayMs: number;
  readonly maxPerMinute: number;
  readonly maxPerHour: number;
  readonly maxConcurrentPerSender: number;
}

export interface SenderRateState {
  readonly senderId: string;
  cooldownUntil?: Date | null;
  cooldownReason?: string | null;
  lastDispatchedAt?: Date | null;
  activeInFlight: number;
  dispatchTimestamps: number[]; // Epoch timestamps of recent dispatches
}

export interface CanDispatchResult {
  readonly allowed: boolean;
  readonly waitTimeMs: number;
  readonly reason?: string;
  readonly isCooldown?: boolean;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  defaultMinDelayMs: 1500,
  defaultMaxDelayMs: 4000,
  maxPerMinute: 20,
  maxPerHour: 300,
  maxConcurrentPerSender: 1, // Single dispatch at a time per sender MTProto session
};

@Injectable()
export class DispatchRateLimiter {
  private readonly logger = new Logger(DispatchRateLimiter.name);
  private readonly states = new Map<string, SenderRateState>();
  private readonly config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getOrCreateState(senderId: string): SenderRateState {
    let state = this.states.get(senderId);
    if (!state) {
      state = {
        senderId,
        cooldownUntil: null,
        cooldownReason: null,
        lastDispatchedAt: null,
        activeInFlight: 0,
        dispatchTimestamps: [],
      };
      this.states.set(senderId, state);
    }
    return state;
  }

  /**
   * Applies an explicit cooldown to a sender account (e.g. from a FloodWait error).
   */
  public applyCooldown(senderId: string, durationSeconds: number, reason: string): Date {
    const state = this.getOrCreateState(senderId);
    const cooldownUntil = new Date(Date.now() + durationSeconds * 1000);
    state.cooldownUntil = cooldownUntil;
    state.cooldownReason = reason;

    this.logger.warn(
      `Cooldown applied to sender ${senderId} for ${durationSeconds}s until ${cooldownUntil.toISOString()} (Reason: ${reason})`,
    );
    return cooldownUntil;
  }

  /**
   * Clears cooldown status for a sender.
   */
  public clearCooldown(senderId: string): void {
    const state = this.states.get(senderId);
    if (state) {
      state.cooldownUntil = null;
      state.cooldownReason = null;
    }
  }

  /**
   * Returns remaining cooldown in seconds (or 0 if not in cooldown).
   */
  public getCooldownRemainingSeconds(senderId: string, now: Date = new Date()): number {
    const state = this.states.get(senderId);
    if (!state?.cooldownUntil) return 0;

    const diffMs = state.cooldownUntil.getTime() - now.getTime();
    return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0;
  }

  /**
   * Calculates a pseudo-randomized jitter delay (in ms) to simulate natural human activity.
   */
  public calculateJitterDelay(channel: ChannelType, customMinMs?: number, customMaxMs?: number): number {
    const min = customMinMs ?? this.config.defaultMinDelayMs;
    const max = customMaxMs ?? this.config.defaultMaxDelayMs;

    if (min >= max) return min;

    // Platform-specific jitter multipliers
    let channelMultiplier = 1.0;
    if (channel === 'TELEGRAM') {
      channelMultiplier = 1.2; // Telegram anti-spam is more sensitive to burst patterns
    } else if (channel === 'BALE') {
      channelMultiplier = 1.0;
    }

    const randomFactor = Math.random();
    const delay = min + (max - min) * randomFactor;
    return Math.floor(delay * channelMultiplier);
  }

  /**
   * Checks whether a sender is eligible for immediate dispatch.
   */
  public canDispatch(senderId: string, now: Date = new Date()): CanDispatchResult {
    const state = this.getOrCreateState(senderId);
    const nowMs = now.getTime();

    // 1. Cooldown / FloodWait Check
    if (state.cooldownUntil && state.cooldownUntil.getTime() > nowMs) {
      const waitTimeMs = state.cooldownUntil.getTime() - nowMs;
      return {
        allowed: false,
        waitTimeMs,
        reason: `Sender is in cooldown until ${state.cooldownUntil.toISOString()} (${state.cooldownReason || 'FloodWait'})`,
        isCooldown: true,
      };
    }

    // 2. Concurrency Check
    if (state.activeInFlight >= this.config.maxConcurrentPerSender) {
      return {
        allowed: false,
        waitTimeMs: 500,
        reason: `Sender exceeded maximum concurrent in-flight limit (${state.activeInFlight}/${this.config.maxConcurrentPerSender})`,
        isCooldown: false,
      };
    }

    // 3. Sliding Window Cleaning (1 hour window)
    const oneHourAgo = nowMs - 3600 * 1000;
    state.dispatchTimestamps = state.dispatchTimestamps.filter((ts) => ts > oneHourAgo);

    // 4. Per-Minute Check
    const oneMinuteAgo = nowMs - 60 * 1000;
    const sentInLastMinute = state.dispatchTimestamps.filter((ts) => ts > oneMinuteAgo).length;
    if (sentInLastMinute >= this.config.maxPerMinute) {
      return {
        allowed: false,
        waitTimeMs: 5000,
        reason: `Sender rate limit exceeded: ${sentInLastMinute}/${this.config.maxPerMinute} msgs/min`,
        isCooldown: false,
      };
    }

    // 5. Per-Hour Check
    if (state.dispatchTimestamps.length >= this.config.maxPerHour) {
      return {
        allowed: false,
        waitTimeMs: 60000,
        reason: `Sender hourly rate limit exceeded: ${state.dispatchTimestamps.length}/${this.config.maxPerHour} msgs/hour`,
        isCooldown: false,
      };
    }

    return {
      allowed: true,
      waitTimeMs: 0,
    };
  }

  /**
   * Acquires a dispatch slot (increments in-flight counter).
   */
  public acquireSlot(senderId: string): boolean {
    const state = this.getOrCreateState(senderId);
    if (state.activeInFlight >= this.config.maxConcurrentPerSender) {
      return false;
    }
    state.activeInFlight++;
    return true;
  }

  /**
   * Releases an acquired dispatch slot.
   */
  public releaseSlot(senderId: string): void {
    const state = this.states.get(senderId);
    if (state && state.activeInFlight > 0) {
      state.activeInFlight--;
    }
  }

  /**
   * Records a successful or attempted dispatch timestamp.
   */
  public recordDispatch(senderId: string, timestamp: Date = new Date()): void {
    const state = this.getOrCreateState(senderId);
    state.lastDispatchedAt = timestamp;
    state.dispatchTimestamps.push(timestamp.getTime());
  }

  /**
   * Returns current active in-flight count for a sender.
   */
  public getInFlightCount(senderId: string): number {
    return this.states.get(senderId)?.activeInFlight ?? 0;
  }

  /**
   * Resets internal state for all senders (useful in tests).
   */
  public resetAll(): void {
    this.states.clear();
  }
}
