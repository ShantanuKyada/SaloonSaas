import { describe, expect, it } from 'vitest';
import { routeSpecs } from '../src/core/router.js';
import '../src/modules/index.js';

// A route that forgets to declare permissions is open to every signed-in user of a salon. That is only acceptable for
// the handful of routes below (the branch picker and holiday list every screen needs). Adding a route to this list is a
// deliberate decision that shows up in code review.
const OPEN_TO_ANY_SIGNED_IN_USER = ['GET /branches', 'GET /branches/:id', 'GET /holidays'];

describe('route guards', () => {
  it('declares permissions on every salon route except an explicit allow-list', () => {
    const open = routeSpecs.filter((r) => r.auth === 'org' && r.permissions.length === 0).map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
    expect(open).toEqual([...OPEN_TO_ANY_SIGNED_IN_USER].sort());
  });

  it('keeps public routes to online booking, sign-in and provider webhooks only', () => {
    const publicRoutes = routeSpecs.filter((r) => r.auth === 'public').map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
    const allowed = /^(POST \/auth\/(login|refresh|logout)|GET \/public\/|POST \/public\/|GET \/webhooks\/|POST \/webhooks\/)/;
    expect(publicRoutes.filter((p) => !allowed.test(p))).toEqual([]);
  });

  it('keeps platform administration separate from salon routes', () => {
    const platform = routeSpecs.filter((r) => r.auth === 'platform');
    expect(platform.length).toBeGreaterThan(0);
    expect(platform.every((r) => r.path.startsWith('/platform'))).toBe(true);
  });
});
