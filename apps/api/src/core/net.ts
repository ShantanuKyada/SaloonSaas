import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isProduction, isTest } from '../config/env.js';
import { AppError } from './errors.js';

// Salon owners can configure webhook/API endpoints (biometric devices, SMS gateways). The server fetches them, so
// they must never be allowed to point at the internal network (SSRF).

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return mapped ? isPrivateIPv4(mapped[1]!) : false;
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

export async function assertPublicUrl(raw: string, field = 'url'): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid web address.', { issues: [{ path: field, message: 'Invalid URL' }] });
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && isProduction && !local)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The address must start with https://.', { issues: [{ path: field, message: 'Use https' }] });
  }
  if (url.username || url.password) throw new AppError(400, 'VALIDATION_ERROR', 'Do not put a username or password in the address.', { issues: [{ path: field, message: 'Credentials in URL' }] });
  // In development and tests a local simulator is fine; production must resolve to public addresses only.
  if (!isProduction || isTest) return url;
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length) throw new AppError(400, 'VALIDATION_ERROR', 'We could not find that address on the internet.', { issues: [{ path: field, message: 'Unresolvable host' }] });
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new AppError(400, 'VALIDATION_ERROR', 'That address points to a private network, which is not allowed.', { issues: [{ path: field, message: 'Private address' }] });
  }
  return url;
}

/** fetch with a hard timeout; the caller decides what a failure means. */
export async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
}
