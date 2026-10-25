// Phone numbers are stored in E.164 (+919876543210). Receptionists can type them any way they like.

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Normalises user input to E.164. `defaultCallingCode` is the organisation's country calling code without "+",
 * used when the number is typed without one (e.g. "98765 43210" → "+919876543210").
 * Returns null when the input cannot be a phone number.
 */
export function normalizePhone(input: string | null | undefined, defaultCallingCode = '91'): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    return E164.test(`+${digits}`) ? `+${digits}` : null;
  }
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    return E164.test(`+${digits}`) ? `+${digits}` : null;
  }
  if (defaultCallingCode === '91') {
    if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return normalizePhone(digits.slice(1), defaultCallingCode);
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    return null;
  }
  if (digits.startsWith(defaultCallingCode) && digits.length > defaultCallingCode.length + 6) {
    return E164.test(`+${digits}`) ? `+${digits}` : null;
  }
  const local = digits.replace(/^0+/, '');
  const candidate = `+${defaultCallingCode}${local}`;
  return E164.test(candidate) ? candidate : null;
}

export function isE164(value: string): boolean {
  return E164.test(value);
}

/** "+919876543210" → "+91 98765 43210". */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  if (e164.startsWith('+91') && e164.length === 13) {
    return `+91 ${e164.slice(3, 8)} ${e164.slice(8)}`;
  }
  return e164;
}

/** Data minimisation for roles without contact permission: "+91 ••••• •3210". */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const last = e164.slice(-4);
  return `${e164.slice(0, 3)} ••••• •${last}`;
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!user || !domain) return '•••';
  return `${user.slice(0, 1)}•••@${domain}`;
}

/** Digits-only form used for "starts with / contains" search on partial numbers. */
export function phoneSearchDigits(input: string): string {
  return input.replace(/\D/g, '');
}
