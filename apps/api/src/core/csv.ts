// CSV for reports/exports. Excel opens it directly (UTF-8 BOM included for ₹ and non-Latin names).

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  // Neutralise spreadsheet formula injection from user-entered text (e.g. a customer named "=HYPERLINK(...)").
  // Numbers are written as-is so negatives stay numeric.
  if (typeof value === 'string' && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(cell).join(','), ...rows.map((row) => row.map(cell).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}
