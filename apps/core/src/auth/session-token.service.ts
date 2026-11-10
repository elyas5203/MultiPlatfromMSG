import * as crypto from 'node:crypto';

export class SessionTokenService {
  /**
   * Generates a cryptographically secure random bearer token (>= 256 bits).
   * 32 bytes = 256 bits of entropy, hex encoded (64 characters).
   */
  static generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Computes the SHA-256 hash of the bearer token for secure database storage.
   * Only the hash is persisted in the database; raw token is never stored.
   */
  static hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }
}
