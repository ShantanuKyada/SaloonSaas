import { expect, test } from '@playwright/test';
import { USERS, apiAs, arrangeBooking, farDate, signInAs, uniqueMobile, uniqueName } from './helpers';

test.describe('Front desk', () => {
  test('books a brand-new customer for a service and finds the booking on the appointment list', async ({ page }) => {
    const name = uniqueName('E2E Walkup');
    await signInAs(page, USERS.rajkotReception, '/desk');
    await page.getByRole('button', { name: 'New appointment' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'New appointment' });
    await expect(drawer).toBeVisible();

    // 1. Customer: not found, so add them on the spot
    await drawer.getByRole('searchbox', { name: /Find customer/i }).fill(name);
    await drawer.getByRole('button', { name: new RegExp(`Add “${name}” as a new customer`) }).click();
    const customerDialog = page.getByRole('dialog', { name: /customer/i }).last();
    await customerDialog.getByLabel('Mobile number').fill(uniqueMobile());
    await customerDialog.getByRole('button', { name: 'Add customer' }).click();
    await expect(drawer.getByText(name).first()).toBeVisible();

    // 2. Service, 3. date and time
    await drawer.getByRole('button', { name: /Haircut \(Women\)/ }).first().click();
    const date = farDate();
    await drawer.getByLabel('Date').fill(date);
    const firstTime = drawer.getByRole('option').first();
    await expect(firstTime).toBeVisible();
    await firstTime.click();

    await expect(drawer.getByText(name).first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Confirm booking' }).click();
    await expect(page.getByText(/Booked E2E/)).toBeVisible();

    // The booking is now listed for that customer
    await page.goto(`/appointments?range=custom&from=${date}&to=${date}&q=${encodeURIComponent(name)}`);
    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByText('Haircut (Women)').first()).toBeVisible();
  });

  test('a receptionist cannot book over an existing appointment: the time simply is not offered', async ({ request }) => {
    const api = await apiAs(request, USERS.rajkotReception);
    const first = await arrangeBooking(api, { branchName: 'Glow Rajkot', serviceName: 'Haircut (Women)' });
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(first.startAt));
    const availability = await api.get<{ slots: Array<{ startAt: string; staffIds: string[] }> }>('/scheduling/availability', { branchId: first.branchId, date, serviceIds: first.serviceId });
    const stillFree = availability.slots.find((s) => s.startAt === first.startAt);
    expect(stillFree?.staffIds ?? []).not.toContain(first.staffId);

    // ...and forcing it through the API is refused by the server (double-booking protection)
    const other = await api.post<{ id: string }>('/customers', { fullName: uniqueName('E2E Clash'), mobile: uniqueMobile() });
    await expect(
      api.post('/appointments', { branchId: first.branchId, customerId: other.id, source: 'phone', status: 'scheduled', items: [{ serviceId: first.serviceId, staffId: first.staffId, startAt: first.startAt }], notifyCustomer: false, allowOutsideHours: false }),
    ).rejects.toThrow(/409|APPOINTMENT_CONFLICT|STAFF_UNAVAILABLE/);
  });

  test('moves a booking through check-in, service and completion, then offers to create the bill', async ({ page, request }) => {
    const api = await apiAs(request, USERS.rajkotReception);
    const booking = await arrangeBooking(api, { branchName: 'Glow Rajkot', serviceName: 'Haircut (Men)' });
    await signInAs(page, USERS.rajkotReception, `/appointments/${booking.appointmentId}`);

    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(booking.customerName)).toBeVisible();
    await drawer.getByRole('button', { name: 'Check in' }).click();
    await drawer.getByRole('button', { name: 'Start service' }).click();
    await drawer.getByRole('button', { name: 'Complete service' }).click();
    await expect(drawer.getByRole('button', { name: 'Create bill' })).toBeVisible();

    const after = await api.get<{ status: string }>(`/appointments/${booking.appointmentId}`);
    expect(after.status).toBe('completed');
  });

  test('cancelling asks for a reason, tells the customer and can be undone', async ({ page, request }) => {
    const api = await apiAs(request, USERS.rajkotReception);
    const booking = await arrangeBooking(api, { branchName: 'Glow Rajkot', serviceName: 'Blow Dry' });
    await signInAs(page, USERS.rajkotReception, `/appointments/${booking.appointmentId}`);

    await page.getByRole('dialog').getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel appointment' }).click();
    const confirm = page.getByRole('dialog', { name: 'Cancel this appointment?' });
    await expect(confirm.getByText(booking.customerName)).toBeVisible();
    await confirm.getByRole('radio', { name: 'Customer called to cancel' }).click();
    await confirm.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.getByText('Appointment cancelled')).toBeVisible();
    expect((await api.get<{ status: string }>(`/appointments/${booking.appointmentId}`)).status).toBe('cancelled');

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await api.get<{ status: string }>(`/appointments/${booking.appointmentId}`)).status).toBe('scheduled');
  });
});
