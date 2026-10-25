import type { NotificationChannel, NotificationEventType } from './constants.js';

// Message templates use {{placeholders}}. Rendering is deliberately logic-less: unknown placeholders render empty,
// so a typo in a template can never leak internal data.

export const TEMPLATE_VARIABLES: Record<NotificationEventType, string[]> = {
  appointment_confirmation: ['customerName', 'salonName', 'branchName', 'services', 'date', 'time', 'staff', 'bookingNumber', 'branchPhone', 'manageLink'],
  appointment_reminder: ['customerName', 'salonName', 'branchName', 'services', 'date', 'time', 'staff', 'bookingNumber', 'branchPhone'],
  appointment_cancellation: ['customerName', 'salonName', 'branchName', 'services', 'date', 'time', 'bookingNumber', 'branchPhone'],
  appointment_rescheduled: ['customerName', 'salonName', 'branchName', 'services', 'date', 'time', 'staff', 'bookingNumber', 'branchPhone'],
  payment_receipt: ['customerName', 'salonName', 'branchName', 'amount', 'receiptNumber', 'method', 'date', 'balance'],
  outstanding_reminder: ['customerName', 'salonName', 'branchName', 'amount', 'branchPhone'],
  offer: ['customerName', 'salonName', 'message'],
  birthday: ['customerName', 'salonName', 'message'],
  re_engagement: ['customerName', 'salonName', 'message', 'daysSinceLastVisit'],
};

export function renderTemplate(template: string, variables: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
    const value = variables[name];
    return value === null || value === undefined ? '' : String(value);
  });
}

export interface DefaultTemplate {
  eventType: NotificationEventType;
  channel: NotificationChannel;
  name: string;
  subject: string | null;
  body: string;
}

const whatsappAndSms: Array<[NotificationEventType, string, string]> = [
  [
    'appointment_confirmation',
    'Booking confirmation',
    'Hi {{customerName}}, your appointment at {{salonName}} ({{branchName}}) is confirmed.\nService: {{services}}\nDate: {{date}}\nTime: {{time}}\nWith: {{staff}}\nBooking no: {{bookingNumber}}',
  ],
  [
    'appointment_reminder',
    'Appointment reminder',
    'Reminder: {{customerName}}, we look forward to seeing you at {{salonName}} ({{branchName}}) on {{date}} at {{time}} for {{services}}. Need to change it? Call {{branchPhone}}.',
  ],
  [
    'appointment_cancellation',
    'Booking cancelled',
    'Hi {{customerName}}, your appointment at {{salonName}} on {{date}} at {{time}} ({{bookingNumber}}) has been cancelled. Call {{branchPhone}} to book again.',
  ],
  [
    'appointment_rescheduled',
    'Booking moved',
    'Hi {{customerName}}, your appointment at {{salonName}} ({{branchName}}) has moved to {{date}} at {{time}} with {{staff}}. Booking no: {{bookingNumber}}',
  ],
  [
    'payment_receipt',
    'Payment receipt',
    'Thank you {{customerName}}! We received {{amount}} by {{method}} on {{date}}. Receipt: {{receiptNumber}}. Balance pending: {{balance}}. — {{salonName}}',
  ],
  [
    'outstanding_reminder',
    'Pending payment reminder',
    'Hi {{customerName}}, your outstanding balance of {{amount}} at {{salonName}} is pending. Please contact or visit the salon ({{branchPhone}}) to settle your balance.',
  ],
  ['offer', 'Offer', 'Hi {{customerName}}, {{message}} — {{salonName}}'],
  ['birthday', 'Birthday wishes', 'Happy birthday {{customerName}}! {{message}} — {{salonName}}'],
  ['re_engagement', 'We miss you', 'Hi {{customerName}}, we miss you at {{salonName}}! {{message}}'],
];

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  ...whatsappAndSms.map(([eventType, name, body]) => ({ eventType, channel: 'whatsapp' as const, name, subject: null, body })),
  ...whatsappAndSms.map(([eventType, name, body]) => ({ eventType, channel: 'sms' as const, name, subject: null, body })),
  ...whatsappAndSms.map(([eventType, name, body]) => ({
    eventType,
    channel: 'email' as const,
    name,
    subject: `${name} — {{salonName}}`,
    body,
  })),
];
