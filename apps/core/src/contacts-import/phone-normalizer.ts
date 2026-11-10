import { RejectionReasonCode } from './types';

const PERSIAN_ARABIC_DIGIT_MAP: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/**
 * Masks a phone number so no full phone number appears in logs or error messages.
 * e.g., "+989123456789" -> "+98912***6789"
 * e.g., "09123456789" -> "0912***6789"
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    return '****';
  }
  const clean = phone.trim();
  if (clean.length <= 4) {
    return '****';
  }
  if (clean.length <= 7) {
    return clean.slice(0, 2) + '***' + clean.slice(-2);
  }
  if (clean.startsWith('+989') && clean.length === 13) {
    return clean.slice(0, 6) + '***' + clean.slice(-4);
  }
  const prefixLen = Math.min(4, Math.floor(clean.length / 3));
  const suffixLen = Math.min(3, Math.floor(clean.length / 3));
  return clean.slice(0, prefixLen) + '***' + clean.slice(-suffixLen);
}

export interface NormalizationSuccess {
  success: true;
  normalized: string;
}

export interface NormalizationFailure {
  success: false;
  reasonCode: RejectionReasonCode;
  message: string;
  maskedPhone: string;
}

export type NormalizationResult = NormalizationSuccess | NormalizationFailure;

/**
 * Normalizes an Iranian mobile phone number to the unified canonical format:
 *   +989XXXXXXXXX (13 characters)
 *
 * Supported inputs:
 *  - 09... (11 digits)
 *  - 9... (10 digits)
 *  - 989... (12 digits)
 *  - +989... (13 chars)
 *  - 00989... (14 digits)
 *
 * Handles Persian (۰-۹) and Arabic (٠-٩) digits, spaces, hyphens, and parentheses.
 * Invalid inputs are strictly rejected with a specific reason code without guessing.
 */
export function normalizeIranianMobile(input: string | undefined | null): NormalizationResult {
  if (input === undefined || input === null) {
    return {
      success: false,
      reasonCode: RejectionReasonCode.EMPTY_PHONE,
      message: 'Phone number is empty.',
      maskedPhone: '****',
    };
  }

  const raw = String(input).trim();
  if (raw.length === 0) {
    return {
      success: false,
      reasonCode: RejectionReasonCode.EMPTY_PHONE,
      message: 'Phone number is empty.',
      maskedPhone: '****',
    };
  }

  const masked = maskPhoneNumber(raw);

  // Convert Persian and Arabic digits to ASCII digits
  let converted = '';
  for (const ch of raw) {
    converted += PERSIAN_ARABIC_DIGIT_MAP[ch] ?? ch;
  }

  // Strip allowed formatting characters: spaces, tabs, dashes, hyphens, parens, dots, slashes
  // Hyphens: standard hyphen -, en-dash –, em-dash —
  const stripped = converted.replace(/[\s\t\u00A0\u200B\u202F\-–—\(\)\.\/\\]+/g, '');

  if (stripped.length === 0) {
    return {
      success: false,
      reasonCode: RejectionReasonCode.EMPTY_PHONE,
      message: 'Phone number contains only formatting characters.',
      maskedPhone: masked,
    };
  }

  // Check for leading '+'
  const hasPlus = stripped.startsWith('+');
  const digitsOnly = hasPlus ? stripped.slice(1) : stripped;

  // Verify that remaining characters are all numeric digits
  if (!/^\d+$/.test(digitsOnly)) {
    return {
      success: false,
      reasonCode: RejectionReasonCode.INVALID_CHARACTERS,
      message: `Phone number contains invalid non-numeric characters: ${masked}`,
      maskedPhone: masked,
    };
  }

  let canonicalDigits = '';

  if (hasPlus) {
    // Expected format: +989XXXXXXXXX
    if (!digitsOnly.startsWith('98')) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.NOT_IRANIAN_MOBILE,
        message: `Phone number does not have Iran international prefix (+98): ${masked}`,
        maskedPhone: masked,
      };
    }
    if (!digitsOnly.startsWith('989')) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.NOT_IRANIAN_MOBILE,
        message: `Phone number is not an Iranian mobile number: ${masked}`,
        maskedPhone: masked,
      };
    }
    if (digitsOnly.length !== 12) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.INVALID_LENGTH,
        message: `Phone number length is invalid (expected 12 digits after '+'): ${masked}`,
        maskedPhone: masked,
      };
    }
    canonicalDigits = digitsOnly; // '989XXXXXXXXX'
  } else if (digitsOnly.startsWith('00')) {
    // Expected format: 00989XXXXXXXXX
    if (!digitsOnly.startsWith('0098')) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.NOT_IRANIAN_MOBILE,
        message: `Phone number does not have Iran international prefix (0098): ${masked}`,
        maskedPhone: masked,
      };
    }
    if (!digitsOnly.startsWith('00989')) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.NOT_IRANIAN_MOBILE,
        message: `Phone number is not an Iranian mobile number: ${masked}`,
        maskedPhone: masked,
      };
    }
    if (digitsOnly.length !== 14) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.INVALID_LENGTH,
        message: `Phone number length is invalid (expected 14 digits starting with '00989'): ${masked}`,
        maskedPhone: masked,
      };
    }
    canonicalDigits = digitsOnly.slice(2); // '989XXXXXXXXX'
  } else if (digitsOnly.startsWith('989')) {
    // Format: 989XXXXXXXXX (12 digits)
    if (digitsOnly.length !== 12) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.INVALID_LENGTH,
        message: `Phone number length is invalid (expected 12 digits starting with '989'): ${masked}`,
        maskedPhone: masked,
      };
    }
    canonicalDigits = digitsOnly;
  } else if (digitsOnly.startsWith('98')) {
    // 98 followed by non-9 (e.g. landline)
    return {
      success: false,
      reasonCode: RejectionReasonCode.NOT_IRANIAN_MOBILE,
      message: `Phone number is not an Iranian mobile number: ${masked}`,
      maskedPhone: masked,
    };
  } else if (digitsOnly.startsWith('09')) {
    // Format: 09XXXXXXXXX (11 digits)
    if (digitsOnly.length !== 11) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.INVALID_LENGTH,
        message: `Phone number length is invalid (expected 11 digits starting with '09'): ${masked}`,
        maskedPhone: masked,
      };
    }
    canonicalDigits = '98' + digitsOnly.slice(1);
  } else if (digitsOnly.startsWith('0')) {
    // 0 followed by non-9 (e.g. landline 021...)
    return {
      success: false,
      reasonCode: RejectionReasonCode.NOT_IRANIAN_MOBILE,
      message: `Phone number is not an Iranian mobile number: ${masked}`,
      maskedPhone: masked,
    };
  } else if (digitsOnly.startsWith('9')) {
    // Format: 9XXXXXXXXX (10 digits)
    if (digitsOnly.length !== 10) {
      return {
        success: false,
        reasonCode: RejectionReasonCode.INVALID_LENGTH,
        message: `Phone number length is invalid (expected 10 digits starting with '9'): ${masked}`,
        maskedPhone: masked,
      };
    }
    canonicalDigits = '98' + digitsOnly;
  } else {
    // Starts with 1..8
    return {
      success: false,
      reasonCode: RejectionReasonCode.NOT_IRANIAN_MOBILE,
      message: `Phone number is not an Iranian mobile number: ${masked}`,
      maskedPhone: masked,
    };
  }

  // Exactly 12 digits starting with 989
  if (canonicalDigits.length !== 12 || !canonicalDigits.startsWith('989')) {
    return {
      success: false,
      reasonCode: RejectionReasonCode.NOT_IRANIAN_MOBILE,
      message: `Phone number could not be mapped to Iranian mobile format: ${masked}`,
      maskedPhone: masked,
    };
  }

  return {
    success: true,
    normalized: '+' + canonicalDigits,
  };
}
