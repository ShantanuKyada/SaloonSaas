// Money is always an integer number of minor units (e.g. paise). See DECISIONS D2.

const minorDigitsCache = new Map<string, number>();

export function currencyMinorDigits(currency: string): number {
  let digits = minorDigitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    minorDigitsCache.set(currency, digits);
  }
  return digits;
}

/** Converts a major-unit amount typed by a user (e.g. 1200.5) into integer minor units. */
export function toMinor(major: number, currency = 'INR'): number {
  const factor = 10 ** currencyMinorDigits(currency);
  return Math.round(major * factor);
}

export function fromMinor(minor: number, currency = 'INR'): number {
  return minor / 10 ** currencyMinorDigits(currency);
}

export function formatMoney(minor: number, currency = 'INR', locale = 'en-IN'): string {
  const digits = currencyMinorDigits(currency);
  const major = minor / 10 ** digits;
  const hasFraction = minor % 10 ** digits !== 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: hasFraction ? digits : 0,
    maximumFractionDigits: digits,
  }).format(major);
}

/** Integer division rounded half-up, for non-negative operands. */
export function divRound(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError('denominator must be positive');
  if (numerator < 0) return -divRound(-numerator, denominator);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  return Number((n * 2n + d) / (2n * d));
}

/** Applies a basis-point rate (1800 = 18%) to an amount, rounded half-up. */
export function applyBasisPoints(amount: number, bp: number): number {
  return divRound(amount * bp, 10000);
}

/**
 * Splits `total` across `weights` proportionally using the largest-remainder method, so the parts are integers and
 * always sum exactly to `total`.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const bigTotal = BigInt(total);
  const bigSum = BigInt(sum);
  const parts = weights.map((w, index) => {
    const product = bigTotal * BigInt(Math.max(0, w));
    return { index, base: Number(product / bigSum), remainder: product % bigSum };
  });
  let leftover = total - parts.reduce((a, p) => a + p.base, 0);
  const byRemainder = [...parts].sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index));
  for (const part of byRemainder) {
    if (leftover <= 0) break;
    if (weights[part.index]! <= 0) continue;
    part.base += 1;
    leftover -= 1;
  }
  return parts.sort((a, b) => a.index - b.index).map((p) => p.base);
}

export type DiscountType = 'percentage' | 'flat';

export interface DiscountRule {
  type: DiscountType;
  /** Basis points for percentage, minor units for flat. */
  value: number;
  maxAmount?: number | null;
}

export interface PriceLineInput {
  key: string;
  quantity: number;
  unitPrice: number;
  taxRateBp: number;
  /** Whether the promotional offer applies to this line. */
  offerEligible: boolean;
  /** Whether a manual discount may be spread onto this line (false for package redemptions). */
  discountable: boolean;
}

export interface InvoiceCalcInput {
  lines: PriceLineInput[];
  pricesIncludeTax: boolean;
  offer?: DiscountRule | null;
  manualDiscount?: DiscountRule | null;
  /** Round the grand total to the nearest multiple of this many minor units (1 = no rounding). */
  roundOffTo: number;
}

export interface LineCalc {
  key: string;
  gross: number;
  offerDiscount: number;
  manualDiscount: number;
  discount: number;
  taxable: number;
  tax: number;
  total: number;
}

export interface InvoiceCalc {
  lines: LineCalc[];
  subtotal: number;
  offerDiscount: number;
  manualDiscount: number;
  discountTotal: number;
  taxTotal: number;
  preRoundTotal: number;
  roundOff: number;
  grandTotal: number;
}

function discountAmount(rule: DiscountRule, base: number): number {
  if (base <= 0) return 0;
  let amount = rule.type === 'percentage' ? applyBasisPoints(base, Math.min(rule.value, 10000)) : rule.value;
  if (rule.maxAmount != null) amount = Math.min(amount, rule.maxAmount);
  return Math.max(0, Math.min(amount, base));
}

/**
 * The single invoice calculation used both for the live preview in the browser and for the authoritative
 * server-side computation, so what the receptionist sees is exactly what gets billed.
 */
export function calculateInvoice(input: InvoiceCalcInput): InvoiceCalc {
  const lines = input.lines.map((line) => ({ ...line, gross: line.quantity * line.unitPrice }));

  const offerWeights = lines.map((l) => (l.offerEligible ? l.gross : 0));
  const offerTotal = input.offer ? discountAmount(input.offer, offerWeights.reduce((a, b) => a + b, 0)) : 0;
  const offerParts = allocateProportionally(offerTotal, offerWeights);

  const manualWeights = lines.map((l, i) => (l.discountable ? l.gross - offerParts[i]! : 0));
  const manualTotal = input.manualDiscount
    ? discountAmount(input.manualDiscount, manualWeights.reduce((a, b) => a + b, 0))
    : 0;
  const manualParts = allocateProportionally(manualTotal, manualWeights);

  const computed: LineCalc[] = lines.map((line, i) => {
    const offerDiscount = offerParts[i]!;
    const manualDiscount = manualParts[i]!;
    const discount = offerDiscount + manualDiscount;
    const net = line.gross - discount;
    let taxable: number;
    let tax: number;
    let total: number;
    if (input.pricesIncludeTax) {
      taxable = divRound(net * 10000, 10000 + line.taxRateBp);
      tax = net - taxable;
      total = net;
    } else {
      taxable = net;
      tax = applyBasisPoints(net, line.taxRateBp);
      total = net + tax;
    }
    return { key: line.key, gross: line.gross, offerDiscount, manualDiscount, discount, taxable, tax, total };
  });

  const subtotal = computed.reduce((a, l) => a + l.gross, 0);
  const discountTotal = computed.reduce((a, l) => a + l.discount, 0);
  const taxTotal = computed.reduce((a, l) => a + l.tax, 0);
  const preRoundTotal = computed.reduce((a, l) => a + l.total, 0);
  const step = Math.max(1, input.roundOffTo);
  const grandTotal = divRound(preRoundTotal, step) * step;

  return {
    lines: computed,
    subtotal,
    offerDiscount: offerTotal,
    manualDiscount: manualTotal,
    discountTotal,
    taxTotal,
    preRoundTotal,
    roundOff: grandTotal - preRoundTotal,
    grandTotal,
  };
}

export function formatPercentBp(bp: number): string {
  const value = bp / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(2)}%`;
}
