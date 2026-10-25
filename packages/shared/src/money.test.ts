import { describe, expect, it } from 'vitest';
import { allocateProportionally, calculateInvoice, divRound, formatMoney } from './money.js';
import { normalizePhone } from './phone.js';
import { canTransition, walkInStage } from './appointment-status.js';

describe('divRound', () => {
  it('rounds half up', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(4, 3)).toBe(1);
    expect(divRound(0, 7)).toBe(0);
  });
});

describe('allocateProportionally', () => {
  it('always sums to the total', () => {
    const parts = allocateProportionally(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });
  it('ignores zero weights', () => {
    expect(allocateProportionally(50, [0, 100, 0])).toEqual([0, 50, 0]);
  });
  it('returns zeros when nothing to allocate', () => {
    expect(allocateProportionally(0, [10, 20])).toEqual([0, 0]);
    expect(allocateProportionally(10, [0, 0])).toEqual([0, 0]);
  });
});

describe('calculateInvoice', () => {
  const lines = [
    { key: 'a', quantity: 1, unitPrice: 120000, taxRateBp: 1800, offerEligible: true, discountable: true },
    { key: 'b', quantity: 2, unitPrice: 50000, taxRateBp: 1800, offerEligible: false, discountable: true },
  ];

  it('computes tax-exclusive totals with rounding to the rupee', () => {
    const r = calculateInvoice({ lines, pricesIncludeTax: false, roundOffTo: 100 });
    expect(r.subtotal).toBe(220000);
    expect(r.taxTotal).toBe(39600);
    expect(r.grandTotal).toBe(259600);
    expect(r.roundOff).toBe(0);
  });

  it('applies an offer only to eligible lines and caps it', () => {
    const r = calculateInvoice({
      lines,
      pricesIncludeTax: false,
      roundOffTo: 1,
      offer: { type: 'percentage', value: 2000, maxAmount: 20000 },
    });
    expect(r.offerDiscount).toBe(20000);
    expect(r.lines[0]!.offerDiscount).toBe(20000);
    expect(r.lines[1]!.offerDiscount).toBe(0);
    expect(r.discountTotal).toBe(20000);
  });

  it('extracts tax from tax-inclusive prices without changing the total', () => {
    const r = calculateInvoice({
      lines: [{ key: 'a', quantity: 1, unitPrice: 118000, taxRateBp: 1800, offerEligible: false, discountable: true }],
      pricesIncludeTax: true,
      roundOffTo: 1,
    });
    expect(r.lines[0]!.taxable).toBe(100000);
    expect(r.lines[0]!.tax).toBe(18000);
    expect(r.grandTotal).toBe(118000);
  });

  it('never discounts below zero and keeps line sums consistent', () => {
    const r = calculateInvoice({
      lines,
      pricesIncludeTax: false,
      roundOffTo: 100,
      manualDiscount: { type: 'flat', value: 10_000_000 },
    });
    expect(r.manualDiscount).toBe(220000);
    expect(r.grandTotal).toBe(0);
    for (const line of r.lines) expect(line.total).toBeGreaterThanOrEqual(0);
  });

  it('rounds the grand total and records the round-off', () => {
    const r = calculateInvoice({
      lines: [{ key: 'a', quantity: 1, unitPrice: 33333, taxRateBp: 500, offerEligible: false, discountable: true }],
      pricesIncludeTax: false,
      roundOffTo: 100,
    });
    expect(r.preRoundTotal).toBe(35000);
    expect(r.grandTotal % 100).toBe(0);
    expect(r.grandTotal - r.preRoundTotal).toBe(r.roundOff);
  });
});

describe('formatMoney', () => {
  it('formats INR without trailing decimals for whole rupees', () => {
    expect(formatMoney(650000, 'INR')).toBe('₹6,500');
    expect(formatMoney(120050, 'INR')).toBe('₹1,200.50');
  });
});

describe('normalizePhone', () => {
  it('accepts common Indian formats', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('09876543210')).toBe('+919876543210');
    expect(normalizePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalizePhone('919876543210')).toBe('+919876543210');
  });
  it('rejects junk', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
  it('handles other countries', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('050 123 4567', '971')).toBe('+971501234567');
  });
});

describe('appointment status machine', () => {
  it('allows the normal flow', () => {
    expect(canTransition('scheduled', 'checked_in')).toBe(true);
    expect(canTransition('checked_in', 'in_service')).toBe(true);
    expect(canTransition('in_service', 'completed')).toBe(true);
  });
  it('blocks nonsense transitions', () => {
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'completed')).toBe(false);
  });
  it('maps walk-in stages', () => {
    expect(walkInStage('waiting', false)).toBe('waiting');
    expect(walkInStage('checked_in', false)).toBe('assigned');
    expect(walkInStage('completed', true)).toBe('billed');
  });
});
