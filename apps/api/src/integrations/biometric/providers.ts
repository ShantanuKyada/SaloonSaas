import { assertPublicUrl, fetchWithTimeout } from '../../core/net.js';

// Vendor-neutral attendance integration. A "pull" provider asks a device cloud for punches; a "push" provider
// (signed webhook, see attendance routes) needs no code here. Any vendor can be added by implementing
// BiometricProvider and registering it in buildBiometricProvider().

export interface RawPunch {
  /** Stable id from the device/vendor so re-sending the same punch never creates a duplicate. */
  externalId: string;
  /** The ID enrolled on the device; mapped to a staff member through staff.biometric_punch_id. */
  punchId: string;
  punchedAt: Date;
  direction: 'in' | 'out' | 'unknown';
  raw?: unknown;
}

export interface BiometricProvider {
  readonly name: string;
  fetchPunches(range: { from: Date; to: Date }): Promise<RawPunch[]>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

export class BiometricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiometricError';
  }
}

type FieldMap = { idField: string; userField: string; timeField: string; directionField: string; listField: string };

/**
 * Generic JSON-over-HTTPS provider: GET {apiUrl}?from=<iso>&to=<iso> returning either an array or { punches: [...] }.
 * Field names are configurable, so most vendor cloud APIs work without code changes.
 */
export class GenericHttpBiometricProvider implements BiometricProvider {
  readonly name = 'generic_http';
  private readonly map: FieldMap;
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string | undefined,
    config: Record<string, string | number | boolean> = {},
  ) {
    this.map = {
      idField: String(config.idField ?? 'id'),
      userField: String(config.userField ?? 'userId'),
      timeField: String(config.timeField ?? 'timestamp'),
      directionField: String(config.directionField ?? 'direction'),
      listField: String(config.listField ?? 'punches'),
    };
  }

  private async request(query: URLSearchParams): Promise<unknown> {
    const url = await assertPublicUrl(this.apiUrl, 'apiUrl');
    url.search = query.toString();
    let response: Response;
    try {
      response = await fetchWithTimeout(url, { headers: { Accept: 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) } }, 15_000);
    } catch (error) {
      throw new BiometricError(`The attendance device service could not be reached: ${(error as Error).message}`);
    }
    if (!response.ok) throw new BiometricError(`The attendance device service answered ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new BiometricError('The attendance device service returned something we could not read.');
    }
  }

  async fetchPunches(range: { from: Date; to: Date }): Promise<RawPunch[]> {
    const json = await this.request(new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() }));
    const list = Array.isArray(json) ? json : ((json as Record<string, unknown>)?.[this.map.listField] as unknown[] | undefined);
    if (!Array.isArray(list)) throw new BiometricError('The attendance device service did not return a list of punches.');
    const out: RawPunch[] = [];
    for (const item of list.slice(0, 20_000)) {
      const rec = item as Record<string, unknown>;
      const userId = rec[this.map.userField];
      const when = new Date(String(rec[this.map.timeField]));
      if (userId === undefined || userId === null || Number.isNaN(when.getTime())) continue;
      const dirRaw = String(rec[this.map.directionField] ?? '').toLowerCase();
      const direction = ['in', 'checkin', 'check_in', '0'].includes(dirRaw) ? 'in' : ['out', 'checkout', 'check_out', '1'].includes(dirRaw) ? 'out' : 'unknown';
      out.push({ externalId: String(rec[this.map.idField] ?? `${userId}@${when.toISOString()}`), punchId: String(userId), punchedAt: when, direction, raw: item });
    }
    return out;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const now = new Date();
      await this.request(new URLSearchParams({ from: new Date(now.getTime() - 60_000).toISOString(), to: now.toISOString() }));
      return { ok: true, detail: 'Connected' };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

export const BIOMETRIC_PROVIDERS = ['generic_http', 'push_webhook'] as const;

/** Returns a pull provider, or null for push-only providers (the device calls us). */
export function buildBiometricProvider(provider: string, config: Record<string, string | number | boolean>, secrets: Record<string, string>): BiometricProvider | null {
  if (provider === 'generic_http' && config.apiUrl) return new GenericHttpBiometricProvider(String(config.apiUrl), secrets.apiKey, config);
  return null;
}
