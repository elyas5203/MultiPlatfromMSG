// @ts-ignore
import * as bcrypt from 'bcryptjs';

/**
 * Password hashing service.
 * Implements bcrypt with documented technical rationale (AC-01):
 * On the target Windows runtime (Node v20.18.0), argon2 requires Visual Studio C++
 * build tools via node-gyp which are not available. bcryptjs provides standard bcrypt
 * password hashing (cost factor 12) with zero native compilation dependencies.
 */
export class PasswordHasher {
  private static readonly SALT_ROUNDS = 12;

  static async hash(password: string): Promise<string> {
    return bcrypt.hash(password, PasswordHasher.SALT_ROUNDS);
  }

  static async verify(hash: string, plainText: string): Promise<boolean> {
    if (!hash || !plainText) return false;
    try {
      return await bcrypt.compare(plainText, hash);
    } catch {
      return false;
    }
  }
}
