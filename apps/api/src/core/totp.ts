import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Time-based one-time passwords (RFC 6238, built on RFC 4226): 6 digits, 30-second steps, HMAC-SHA1. These are the
// defaults every authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…) supports.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, base32-encoded (what the QR code and the "type it in by hand" key contain). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP: the code for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (timeMs: number): number => Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);

export function totpAt(secretBase32: string, timeMs: number): string {
  return hotp(base32Decode(secretBase32), stepAt(timeMs));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks a submitted code against the steps around "now" (one step either side allows for clock drift between the
 * phone and the server). Returns the matching step so the caller can refuse to accept the same code twice, or null.
 * A code for a step at or before `lastStep` is rejected: a stolen code cannot be replayed.
 */
export function verifyTotp(secretBase32: string, submitted: string, options: { nowMs?: number; lastStep?: number | null; window?: number } = {}): number | null {
  const code = submitted.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = stepAt(options.nowMs ?? Date.now());
  const window = options.window ?? 1;
  let matched: number | null = null;
  // Check every step in the window without stopping early, so timing does not reveal which step matched.
  for (let step = now - window; step <= now + window; step += 1) {
    if (safeEqual(hotp(secret, step), code) && (options.lastStep === null || options.lastStep === undefined || step > options.lastStep)) matched = step;
  }
  return matched;
}

export function otpauthUrl(options: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`;
  const query = new URLSearchParams({ secret: options.secret, issuer: options.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${query.toString()}`;
}
