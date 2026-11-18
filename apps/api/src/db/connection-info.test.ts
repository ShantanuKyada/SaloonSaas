import { describe, expect, it } from 'vitest';
import { parseConnectionUrl } from './connection-info.js';

describe('parseConnectionUrl', () => {
  it('reads role, password and database from a plain URL', () => {
    expect(parseConnectionUrl('postgres://salon_app:secret@localhost:5432/salon_dev')).toEqual({
      role: 'salon_app',
      password: 'secret',
      database: 'salon_dev',
      poolerTenant: null,
    });
  });

  it('strips the Supabase pooler tenant from the user name', () => {
    const info = parseConnectionUrl('postgres://salon_owner.abcdefghij0123456789:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full');
    expect(info).toEqual({ role: 'salon_owner', password: 'pw', database: 'postgres', poolerTenant: 'abcdefghij0123456789' });
  });

  it('decodes percent-encoded passwords', () => {
    expect(parseConnectionUrl('postgres://salon_app:p%40ss%2Fw%3Ard@db:5432/postgres').password).toBe('p@ss/w:rd');
  });

  it('leaves user names alone when the part after the dot is not a project ref', () => {
    expect(parseConnectionUrl('postgres://salon.app:pw@db/postgres').role).toBe('salon.app');
    expect(parseConnectionUrl('postgres://salon_app.SHORT:pw@db/postgres').role).toBe('salon_app.SHORT');
  });
});
