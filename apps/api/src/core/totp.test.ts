import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUrl, stepAt, totpAt, verifyTotp } from './totp.js';

// RFC 6238 appendix B test vectors (HMAC-SHA1, secret "12345678901234567890"); the RFC lists 8 digits, the app uses the last 6.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const VECTORS: Array<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP', () => {
  it.each(VECTORS)('matches the RFC 6238 vector at t=%i', (seconds, expected) => {
    expect(hotp(RFC_SECRET, stepAt(seconds * 1000))).toBe(expected);
  });

  it('round-trips base32 and rejects invalid characters', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it('generates 160-bit secrets that are different every time', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
  });

  it('accepts the current code and one step of clock drift either way, but not more', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now), { nowMs: now })).toBe(stepAt(now));
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), { nowMs: now })).toBe(stepAt(now) - 1);
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), { nowMs: now })).toBe(stepAt(now) + 1);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, now + 90_000), { nowMs: now })).toBeNull();
  });

  it('refuses to accept a code twice (replay protection)', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = verifyTotp(secret, totpAt(secret, now), { nowMs: now })!;
    expect(verifyTotp(secret, totpAt(secret, now), { nowMs: now, lastStep: step })).toBeNull();
    // A newer step is still fine
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), { nowMs: now + 30_000, lastStep: step })).toBe(step + 1);
  });

  it('rejects anything that is not six digits', () => {
    const secret = generateTotpSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x']) expect(verifyTotp(secret, bad)).toBeNull();
  });

  it('ignores spaces typed into the code, as authenticator apps display "123 456"', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now })).toBe(stepAt(now));
  });

  it('builds the address authenticator apps scan', () => {
    const url = otpauthUrl({ secret: 'ABCDEFGHIJKLMNOP', account: 'owner@glow.test', issuer: 'Glow Salon' });
    expect(url).toBe('otpauth://totp/Glow%20Salon:owner%40glow.test?secret=ABCDEFGHIJKLMNOP&issuer=Glow+Salon&algorithm=SHA1&digits=6&period=30');
  });
});
