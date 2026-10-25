import { describe, expect, it } from 'vitest';
import { MANAGER_PERMISSIONS, ROLE_TEMPLATES, twoFactorApplies, type Permission } from './permissions.js';

const template = (key: string) => ROLE_TEMPLATES.find((r) => r.key === key)!;
const applies = (requirement: Parameters<typeof twoFactorApplies>[0], key: string) => twoFactorApplies(requirement, key, template(key).permissions);

describe('two-step sign-in policy', () => {
  it('applies to nobody when it is off', () => {
    for (const role of ROLE_TEMPLATES) expect(applies('off', role.key)).toBe(false);
  });

  it('applies to owners only under "owners"', () => {
    expect(applies('owners', 'owner')).toBe(true);
    expect(applies('owners', 'branch_manager')).toBe(false);
    expect(applies('owners', 'receptionist')).toBe(false);
    expect(applies('owners', 'staff')).toBe(false);
  });

  it('adds anyone who can correct money or administer the salon under "owners_and_managers"', () => {
    expect(applies('owners_and_managers', 'owner')).toBe(true);
    expect(applies('owners_and_managers', 'branch_manager')).toBe(true);
    // The front desk takes payments and creates bills but cannot void, refund, export or administer.
    expect(applies('owners_and_managers', 'receptionist')).toBe(false);
    expect(applies('owners_and_managers', 'staff')).toBe(false);
  });

  it('follows permissions, so a custom role with one manager power is covered', () => {
    const custom: Permission[] = ['appointments.view', 'payments.refund'];
    expect(twoFactorApplies('owners_and_managers', 'accountant_ab12', custom)).toBe(true);
    expect(twoFactorApplies('owners', 'accountant_ab12', custom)).toBe(false);
    expect(twoFactorApplies('owners_and_managers', 'front_desk_cd34', ['appointments.view'])).toBe(false);
    expect(twoFactorApplies('owners_and_managers', null, new Set<Permission>())).toBe(false);
  });

  it('accepts a set as well as an array of permissions', () => {
    expect(twoFactorApplies('owners_and_managers', 'x', new Set<Permission>(['users.manage']))).toBe(true);
  });

  it('only lists real permissions as manager powers', () => {
    const all = new Set<Permission>(template('owner').permissions);
    for (const permission of MANAGER_PERMISSIONS) expect(all.has(permission)).toBe(true);
  });
});
