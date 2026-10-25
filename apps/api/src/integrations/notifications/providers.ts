import type { NotificationChannel } from '@salon/shared';
import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { fetchWithTimeout, assertPublicUrl } from '../../core/net.js';
import { logger } from '../../core/logger.js';

// One tiny interface per channel keeps vendors replaceable: appointment and billing code only ever queue
// notifications; the worker picks a provider here. Adding Twilio, MSG91, SES etc. means adding a class below.

export interface OutboundMessage {
  notificationId: string;
  organizationId: string;
  channel: NotificationChannel;
  to: string;
  subject: string | null;
  body: string;
  /** Pre-approved template name for providers that require it (WhatsApp business-initiated messages). */
  providerTemplateName: string | null;
  /** Placeholder values in the order they appear in the template body. */
  orderedVariables: string[];
}

export interface SendResult {
  providerMessageId: string | null;
}

/** `retryable` tells the worker whether trying again could ever help (5xx/timeouts yes, bad number no). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface NotificationProvider {
  readonly name: string;
  readonly channel: NotificationChannel;
  send(message: OutboundMessage): Promise<SendResult>;
}

export type ProviderConfig = Record<string, string | number | boolean>;
export type ProviderSecrets = Record<string, string>;

function httpError(provider: string, status: number, body: string): ProviderError {
  const retryable = status >= 500 || status === 429 || status === 408;
  return new ProviderError(`${provider} responded ${status}: ${body.slice(0, 300)}`, retryable);
}

function networkError(provider: string, error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`${provider} could not be reached: ${message}`, true);
}

/** Development provider: prints the message instead of sending it. */
export class ConsoleProvider implements NotificationProvider {
  readonly name = 'console';
  constructor(readonly channel: NotificationChannel) {}
  async send(message: OutboundMessage): Promise<SendResult> {
    logger.info({ channel: this.channel, to: '[redacted]', subject: message.subject, body: message.body }, 'notification (console provider)');
    return { providerMessageId: `console-${message.notificationId}` };
  }
}

/** WhatsApp Business Cloud API (Meta). Business-initiated messages must use an approved template. */
export class WhatsAppCloudProvider implements NotificationProvider {
  readonly name = 'meta_cloud';
  readonly channel = 'whatsapp' as const;
  constructor(
    private readonly config: { phoneNumberId: string; apiVersion: string; languageCode?: string },
    private readonly accessToken: string,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const to = message.to.replace(/^\+/, '');
    const payload = message.providerTemplateName
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: message.providerTemplateName,
            language: { code: this.config.languageCode ?? 'en' },
            components: message.orderedVariables.length ? [{ type: 'body', parameters: message.orderedVariables.map((text) => ({ type: 'text', text })) }] : [],
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: message.body, preview_url: false } };
    let response: Response;
    try {
      response = await fetchWithTimeout(`https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw networkError('WhatsApp', error);
    }
    const text = await response.text();
    if (!response.ok) throw httpError('WhatsApp', response.status, text);
    const json = JSON.parse(text) as { messages?: Array<{ id: string }> };
    return { providerMessageId: json.messages?.[0]?.id ?? null };
  }
}

export class SmtpEmailProvider implements NotificationProvider {
  readonly name = 'smtp';
  readonly channel = 'email' as const;
  private readonly transport: Transporter;
  constructor(
    config: { host: string; port: number; secure: boolean; user?: string; from: string },
    password: string | undefined,
    private readonly from: string = config.from,
  ) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: password } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: (message.subject ?? 'Message from your salon').replace(/[\r\n]+/g, ' '),
        text: message.body,
        html: `<div style="font-family:system-ui,sans-serif;white-space:pre-line">${escapeHtml(message.body)}</div>`,
      });
      return { providerMessageId: info.messageId ?? null };
    } catch (error) {
      const code = (error as { responseCode?: number }).responseCode;
      // Mailbox-level rejections (invalid address, policy) will never succeed on retry; everything else might.
      const permanent = code !== undefined && [550, 551, 552, 553, 554].includes(code);
      throw new ProviderError(`Email failed: ${(error as Error).message}`, !permanent);
    }
  }
}

/** Generic JSON-over-HTTPS SMS gateway: POST { to, message, sender } with a bearer token. */
export class HttpSmsProvider implements NotificationProvider {
  readonly name = 'http';
  readonly channel = 'sms' as const;
  constructor(
    private readonly config: { apiUrl: string; senderId?: string },
    private readonly apiKey: string,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    await assertPublicUrl(this.config.apiUrl, 'apiUrl');
    let response: Response;
    try {
      response = await fetchWithTimeout(this.config.apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: message.to, message: message.body, sender: this.config.senderId }),
      });
    } catch (error) {
      throw networkError('SMS gateway', error);
    }
    const text = await response.text();
    if (!response.ok) throw httpError('SMS gateway', response.status, text);
    let id: string | null = null;
    try {
      const json = JSON.parse(text) as { id?: string; messageId?: string };
      id = json.id ?? json.messageId ?? null;
    } catch {
      // Some gateways answer with plain text; the message was still accepted.
    }
    return { providerMessageId: id };
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Platform-level fallback providers built from environment variables. */
export function platformProvider(channel: NotificationChannel): NotificationProvider | null {
  if (env.NOTIFICATIONS_MODE === 'console') return new ConsoleProvider(channel);
  if (env.NOTIFICATIONS_MODE === 'disabled') return null;
  if (channel === 'whatsapp' && env.WHATSAPP_PROVIDER === 'meta_cloud' && env.WHATSAPP_API_KEY && env.WHATSAPP_PHONE_NUMBER_ID) {
    return new WhatsAppCloudProvider({ phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, apiVersion: env.WHATSAPP_API_VERSION }, env.WHATSAPP_API_KEY);
  }
  if (channel === 'email' && env.EMAIL_PROVIDER === 'smtp' && env.SMTP_HOST && env.EMAIL_FROM) {
    return new SmtpEmailProvider({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER, from: env.EMAIL_FROM }, env.EMAIL_API_KEY);
  }
  if (channel === 'sms' && env.SMS_PROVIDER === 'http' && env.SMS_API_URL && env.SMS_API_KEY) {
    return new HttpSmsProvider({ apiUrl: env.SMS_API_URL, senderId: env.SMS_SENDER_ID }, env.SMS_API_KEY);
  }
  return null;
}

/** Per-organization provider built from a saved connection (secrets already decrypted). */
export function organizationProvider(channel: NotificationChannel, provider: string, config: ProviderConfig, secrets: ProviderSecrets): NotificationProvider | null {
  if (channel === 'whatsapp' && provider === 'meta_cloud' && config.phoneNumberId && secrets.accessToken) {
    return new WhatsAppCloudProvider({ phoneNumberId: String(config.phoneNumberId), apiVersion: String(config.apiVersion ?? env.WHATSAPP_API_VERSION), languageCode: config.languageCode ? String(config.languageCode) : undefined }, secrets.accessToken);
  }
  if (channel === 'email' && provider === 'smtp' && config.host && config.from) {
    return new SmtpEmailProvider({ host: String(config.host), port: Number(config.port ?? 587), secure: config.secure === true || config.secure === 'true', user: config.user ? String(config.user) : undefined, from: String(config.from) }, secrets.password);
  }
  if (channel === 'sms' && provider === 'http' && config.apiUrl && secrets.apiKey) {
    return new HttpSmsProvider({ apiUrl: String(config.apiUrl), senderId: config.senderId ? String(config.senderId) : undefined }, secrets.apiKey);
  }
  return null;
}
