# SalonOS

Appointments, walk-ins, customers, billing with a credit cycle, collections, offers and packages, messaging, attendance
and analytics for salons and salon groups, in one multi-tenant product. One owner can run many branches; each branch sees
only its own data; every role gets a screen built for what they do all day.

**For the people who use it:** plain language everywhere, the common jobs in two or three taps (book, walk-in, bill,
collect), keyboard shortcuts at the desk, a phone-first "My day" for stylists, undo where it is safe, and an online booking
page customers can use without an account. See [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

**For the people who run it:** a PostgreSQL-enforced tenant boundary, double-booking that is impossible rather than unlikely,
an append-only ledger whose balances can always be re-derived, an audit trail, optional or required two-step sign-in
(authenticator app) for owners and managers, tested backups and restores. See
[docs/SECURITY.md](docs/SECURITY.md) and [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).

## Stack

| Layer | Technology |
| --- | --- |
| Web | React 19, TypeScript (strict), Vite 7, Tailwind v4, Radix UI, TanStack Query, React Router 7, React Hook Form + Zod, Recharts |
| API | Node 24, Express 5, TypeScript, Kysely, Zod, Pino, Helmet, Argon2id, JOSE (JWT) |
| Data | PostgreSQL 17: row-level security, exclusion constraints, trigger-maintained balances, SQL migrations |
| Shared | `packages/shared`: Zod schemas, permission catalogue, status machine, money maths, DTO types (used by browser and API) |
| Tests | Vitest + Supertest (API), Playwright + axe-core (browser, accessibility, mobile) |
| Ops | Docker images, nginx, compose stack, backup/restore scripts, GitHub Actions |

## Quick start (development)

Prerequisites: Node 24+, PostgreSQL 17 with a superuser you can use locally.

```bash
npm install
cp .env.example .env            # then edit: set the database passwords and generate the three secrets (see comments)
npm run db:setup                # creates the owner and app roles and the databases (needs DATABASE_SUPERUSER_URL)
npm run db:migrate              # applies the SQL migrations
npm run db:seed                 # demo salon "Glow Salon Group": two branches, a team, 6 months of realistic history
npm run dev                     # API :4000, worker, web http://localhost:5173
```

Sign in at <http://localhost:5173> with any of these (password `Welcome@2026`):

| Role | Sign-in | Lands on |
| --- | --- | --- |
| Owner | `owner@glow.test` | Business dashboard (all branches) |
| Branch manager | `manager.rajkot@glow.test`, `manager.ahmedabad@glow.test` | Today at the salon |
| Receptionist | `reception.rajkot@glow.test`, `reception.ahmedabad@glow.test` | Front desk |
| Stylist | `rahul@glow.test`, `priya@glow.test` | My day (phone view) |
| Platform admin | `admin@salonos.test` | Platform (all salons) |

Two-step sign-in is off for the demo accounts; try it under *Account security* (the account button, top right). If a demo
account is ever locked out of it, `USER_EMAIL=owner@glow.test npm run user:reset-2fa -w @salon/api` switches it off.

Customers can book at <http://localhost:5173/book/glow>. API documentation (OpenAPI) is at
<http://localhost:4000/api/docs>. Messages are written to the server log in development (`NOTIFICATIONS_MODE=console`).

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + worker + web with reload |
| `npm run typecheck` | TypeScript for every package and the end-to-end tests |
| `npm test` | Unit and API integration tests (needs the local PostgreSQL; builds an isolated `salon_test` database) |
| `npm run test:e2e` | Browser tests against the running stack (see below) |
| `npm run build` | Production build of shared, API and web |
| `npm run db:reset` | Development only: wipe and re-migrate the dev database |
| `npm run db:erd -w @salon/api` | Regenerate `docs/ERD.md` from the live schema |

### End-to-end tests

```bash
npm run db:reset && npm run db:seed          # the tests expect the demo data
RATE_LIMIT_MULTIPLIER=50                     # add to .env: the tests sign in many times from one address
npm run test:e2e                             # Playwright starts the API and web servers if they are not running
# use the Chrome you already have instead of downloading Playwright's browser:
E2E_BROWSER_CHANNEL=chrome npm run test:e2e
```

The suite creates its own customers and bookings with unique names, restores anything it changes (settings, templates,
working hours) and retires the staff it adds, so it can be run repeatedly. Run it against a throwaway database, not production.
Walk-in tests skip themselves when nobody is free (for example, when the salon is closed at the time you run them).

## Repository layout

```
apps/api         Express API, worker, SQL migrations, seed (TypeScript)
apps/web         React single-page app
packages/shared  Schemas, permissions, status machine, money helpers shared by both
e2e              Playwright tests (flows, roles, mobile, accessibility)
deploy           Dockerfiles, compose stack, nginx, backup and restore scripts
docs             Architecture, decisions, ERD, security, deployment, backup, readiness, user guide
```

## Documentation

| Document | For |
| --- | --- |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Owners, managers, receptionists and stylists: how to do the daily jobs |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the system is built and why |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Assumptions and trade-offs not obvious from the code |
| [docs/ERD.md](docs/ERD.md) | Generated entity-relationship diagrams and where each integrity rule is enforced |
| [docs/SECURITY.md](docs/SECURITY.md) | Controls, threat model, operating checklist and known limitations |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Configuration, first deployment, TLS, upgrades, monitoring |
| [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) | RPO/RTO, nightly backups, restore drills, disaster checklist |
| [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) | What was verified, with evidence, and what is still open |

## Deploying

```bash
cp deploy/.env.example deploy/.env       # fill in every value
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Full instructions (TLS, managed PostgreSQL, upgrades, backups) are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
