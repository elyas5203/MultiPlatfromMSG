export interface AuthConfigValues {
  maxLoginAttempts: number;
  lockoutDurationSeconds: number;
  minPasswordLength: number;
  sessionTtlSeconds: number;
}

export class AuthConfig {
  static getValues(): AuthConfigValues {
    const parseEnvInt = (key: string, defaultValue: number): number => {
      const val = process.env[key];
      if (!val) return defaultValue;
      const parsed = parseInt(val, 10);
      return Number.isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
    };

    return {
      maxLoginAttempts: parseEnvInt('AUTH_MAX_LOGIN_ATTEMPTS', 5),
      lockoutDurationSeconds: parseEnvInt('AUTH_LOCKOUT_DURATION_SECONDS', 900),
      minPasswordLength: parseEnvInt('AUTH_MIN_PASSWORD_LENGTH', 8),
      sessionTtlSeconds: parseEnvInt('AUTH_SESSION_TTL_SECONDS', 86400),
    };
  }
}
