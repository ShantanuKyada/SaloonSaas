import { expect, test, type Page } from '@playwright/test';
import { USERS, apiAs, arrangeBooking, signInAs, type Api, type Arranged } from './helpers';

/** Takes a booked appointment through to "completed" through the API so billing tests start where billing starts. */
async function completed(api: Api, booking: Arranged): Promise<void> {
  for (const status of ['checked_in', 'in_service', 'completed']) await api.post(`/appointments/${booking.appointmentId}/status`, { status, notifyCustomer: false });
}

const billIdFrom = (page: Page) => /\/billing\/bills\/([0-9a-f-]{36})/.exec(page.url())![1]!;

test.describe('Billing, credit and collections', () => {
  test('bills a completed appointment on credit, then collects the pending amount', async ({ page, request }) => {
    const api = await apiAs(request, USERS.rajkotReception);
    const booking = await arrangeBooking(api, { branchName: 'Glow Rajkot', serviceName: 'Haircut (Women)' });
    await completed(api, booking);

    // The bill starts pre-filled from the appointment; the receptionist only chooses how it is paid
    await signInAs(page, USERS.rajkotReception, `/billing/new?appointmentId=${booking.appointmentId}`);
    await expect(page.getByText(booking.customerName).first()).toBeVisible();
    await expect(page.getByText('Haircut (Women)').first()).toBeVisible();
    await page.getByRole('switch', { name: /Pay later \(credit\)/ }).click();
    await page.getByRole('button', { name: 'Create bill on credit' }).click();

    await expect(page).toHaveURL(/\/billing\/bills\/[0-9a-f-]{36}/);
    const invoiceId = billIdFrom(page);
    const invoice = await api.get<{ invoiceNumber: string; grandTotal: number; balanceDue: number; paymentStatus: string }>(`/billing/invoices/${invoiceId}`);
    expect(invoice.paymentStatus).toBe('unpaid');
    expect(invoice.balanceDue).toBe(invoice.grandTotal);
    await expect(page.getByText(invoice.invoiceNumber).first()).toBeVisible();

    let customer = await api.get<{ account: { outstanding: number } }>(`/customers/${booking.customerId}/360`);
    expect(customer.account.outstanding).toBe(invoice.grandTotal);

    // Collect the whole amount in cash
    await page.goto(`/billing/collect?customerId=${booking.customerId}&invoiceId=${invoiceId}`);
    await expect(page.getByRole('heading', { name: 'Collect payment' })).toBeVisible();
    await page.getByRole('button', { name: /^Collect/ }).click();
    await expect(page).toHaveURL(/\/billing\/payments\/[0-9a-f-]{36}/);

    customer = await api.get(`/customers/${booking.customerId}/360`);
    expect(customer.account.outstanding).toBe(0);
    const paid = await api.get<{ paymentStatus: string; balanceDue: number }>(`/billing/invoices/${invoiceId}`);
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.balanceDue).toBe(0);

    // The ledger tells the whole story with a running balance that ends at zero
    await page.goto(`/billing/ledger?customerId=${booking.customerId}`);
    await expect(page.getByRole('table').getByText(invoice.invoiceNumber)).toBeVisible();
    await expect(page.getByText('Pending').first()).toBeVisible();
    const statement = await api.get<{ closingBalance: number; rows: Array<{ debit: number; credit: number }> }>('/ledger', { customerId: booking.customerId });
    expect(statement.closingBalance).toBe(0);
    expect(statement.rows.reduce((a, r) => a + r.debit - r.credit, 0)).toBe(0);
  });

  test('takes a part payment at the counter and leaves the rest pending', async ({ page, request }) => {
    const api = await apiAs(request, USERS.rajkotReception);
    const booking = await arrangeBooking(api, { branchName: 'Glow Rajkot', serviceName: 'Hair Spa' });
    await completed(api, booking);

    await signInAs(page, USERS.rajkotReception, `/billing/new?appointmentId=${booking.appointmentId}`);
    await expect(page.getByText('Hair Spa').first()).toBeVisible();
    const method = page.getByRole('radiogroup', { name: 'Payment method' });
    await expect(method).toBeVisible();
    await method.getByRole('radio', { name: 'UPI' }).click();
    // Type a smaller amount than the bill total
    const amount = method.locator('xpath=..').getByRole('textbox').first();
    await amount.fill('500');
    await expect(page.getByText('Pending after this bill')).toBeVisible();
    await page.getByRole('button', { name: 'Create bill (part paid)' }).click();

    await expect(page).toHaveURL(/\/billing\/bills\/[0-9a-f-]{36}/);
    const invoice = await api.get<{ grandTotal: number; balanceDue: number; amountPaid: number; paymentStatus: string }>(`/billing/invoices/${billIdFrom(page)}`);
    expect(invoice.paymentStatus).toBe('partial');
    expect(invoice.amountPaid).toBe(50000);
    expect(invoice.balanceDue).toBe(invoice.grandTotal - 50000);

    // The customer now shows up in pending payments, oldest bill first
    await page.goto('/billing/pending');
    await expect(page.getByText(booking.customerName).first()).toBeVisible();
  });
});
