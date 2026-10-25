# Production readiness review

This is the quality-gate record: what was checked, how, what it found, and what is still open. It is meant to be read
before a go-live decision and updated whenever the answer changes.

**Verdict.** The product is functionally complete for the scope in the brief and is ready for a **staging or pilot
deployment** with a real salon. Before taking real customer money and data in production, close the items in section 7
marked *before go-live* (mostly: build and scan the container images in your CI, test the real messaging providers with your
own accounts, and require two-step sign-in for owners). Nothing in the application code is known to be broken.

## 1. Evidence

| Check | Result |
| --- | --- |
| TypeScript, strict mode, no unused code (`npm run typecheck`: shared, API, web, end-to-end tests) | Clean |
| Unit and integration tests (`npm test`) | **158 passing**: 22 shared (money, phone, status rules, two-step policy), 23 scheduling engine, 13 TOTP (RFC 6238 vectors), 100 API integration tests against a real PostgreSQL (tenant isolation, permissions, double-booking races, ledger integrity, idempotency, consent, notification failure isolation, route guards, two-step sign-in) |
| Browser end-to-end tests (`npm run test:e2e`) | **99 tests** in desktop Chrome and a phone profile: sign-in/out, two-step sign-in (set-up, code, recovery codes, policy, reset), roles, front desk, walk-ins, billing and credit, collections, team set-up, users and roles, settings, reports and CSV download, messages, online booking, keyboard shortcuts, mobile layout, accessibility |
| Automated accessibility (axe-core, WCAG 2.1 A and AA) | **0 violations** on 18 screens in light and dark themes, plus the booking drawer, customer dialog, appointment drawer, cancel confirmation, shortcuts help and the two-step set-up, code and recovery-code screens |
| Production dependencies (`npm audit --omit=dev`) | 0 known vulnerabilities |
| Production build (`npm run build`) | Succeeds; compiled API boots and answers `/health`, `/ready`, `/api/docs` |
| Backup and restore | Real dump of the development database restored into a scratch database by `restore.sh`: checksum verified, 8 migrations present, every customer balance equal to the sum of their ledger |
| Compose stack | `docker compose config` validates with all required variables; missing secrets fail fast |
| Latency, steady state, on a developer laptop | Owner dashboard ≈ 30–45 ms, branch dashboard ≈ 20–30 ms, live status ≈ 8 ms, customers list ≈ 7 ms, calendar day ≈ 10–25 ms, revenue report (10 months) ≈ 5–25 ms |
| Web bundle | Entry chunk 122 KB gzip; each screen loads on demand; charts (116 KB gzip) only on dashboards |

## 2. Defects found by this testing and fixed

The end-to-end and accessibility work earned its keep. Each item below was a real defect that the earlier unit tests did not catch.

| Area | Defect | Fix |
| --- | --- | --- |
| Security | Signing out did not send the CSRF header, so the server refused it and the refresh cookie stayed valid | Client sends the header on every request; covered by `auth.spec.ts` |
| Walk-ins | Removing an unassigned walk-in from the queue failed with a database constraint error | Migration 0007 allows cancelled bookings without a time; API regression test |
| Scheduling | A service finished early kept blocking the team member until its planned end, and clean-up time was invisible, so the screen said "Free" while the server refused the booking | Completion releases unused time (and restores it on undo if still free); live status counts just-finished services and clean-up as busy; migration 0008 repairs existing rows |
| Scheduling | Availability offered times beyond the booking window that the server then refused | Availability never returns them and says how far ahead people can book |
| Scheduling | Live status showed people as free while the salon was closed | Staff are "off" with the reason (closed, holiday, opens at …) |
| Online booking | The time picker crashed (invalid time) because the shape of the union-of-slots response was misread | Fixed and covered by a booking-to-cancellation test |
| Front desk | Searching for a new customer whose name resembled an existing one hid the "add new customer" option; names containing digits were dropped when pre-filling | Always offered ("Not them? Add …"); smarter pre-fill |
| Front desk | "Undo" in a toast could not be clicked while a drawer was open | Toasts are interactive above modals |
| Customer groups | Entering an impossible number left a stale customer count on screen | Shows "We could not count customers" |
| Authorization | Salon profile, settings and onboarding endpoints were open to every signed-in user | Require `settings.manage`; a test now fails if any salon route lacks permissions outside a reviewed allow-list |
| Activity log | Filtering by area missed related record types (for example salon settings) | Area filter matches related types |
| Hardening | Example secrets in `.env.example` would have been accepted in production; the demo seed could be run against production; static pages lacked HSTS | Startup refuses example secrets and the zero key; seed refuses to run in production; nginx sends HSTS |
| Two-step sign-in | When an owner switched the policy on, people already working got an error toast from a background refresh instead of being taken to set-up | Any `MFA_SETUP_REQUIRED` answer reloads the signed-in user (the guard then moves them to *Account security*) and is not shown as an error; covered by `two-factor.spec.ts` |
| Tests | The walk-in lifecycle test picked "Free until 12:30 PM" as if it were free all day and failed when a booking began soon after | It now picks someone who is free for good |
| Accessibility | Low-contrast secondary text and warning badges, white initials on light avatars, "Continue setup" button in dark theme, a calendar built from invalid grid roles, accessible names that did not contain the visible text, a definition list used as cards | Tokens darkened, avatar text chosen by contrast, calendar uses buttons in a labelled region, names include visible text, lists |

## 3. Requirement coverage

| Area from the brief | Where it lives | Verified by |
| --- | --- | --- |
| Multi-tenant organizations and branches | Row-level security, composite tenant keys, branch scoping | API isolation tests, `rbac.spec.ts` |
| Roles, permissions, configurable roles | Permission catalogue in `packages/shared`, `/users` screen | API tests, `admin.spec.ts` |
| Staff, skills, services per person, schedules, leave, blocked time | `modules/staff`, Team screens | API tests, `team.spec.ts` |
| Scheduling engine, double-booking prevention | Pure engine + advisory lock + exclusion constraint | 23 engine tests, concurrency test (three simultaneous requests → one booking) |
| Appointments, calendar (day/week/staff views, drag and drop, resize), walk-ins | `modules/appointments`, Calendar and Walk-ins screens | API tests, `front-desk.spec.ts`, `walk-in.spec.ts` |
| Customer CRM, customer 360, groups and segments, preferences and consent | `modules/customers`, Customers screens | API tests, `customers.spec.ts` |
| Services, categories, packages, combos, offers | `modules/catalog`, `modules/offers` | API tests; screens covered by route and accessibility sweeps |
| Billing, taxes, discounts, split payments, advance, credit, credit limit | `modules/billing`, `calculateInvoice` shared by preview and server | Finance tests, `billing.spec.ts` |
| Collections, pending payments, ledger, ageing, reminders | `modules/collections`, Billing screens | Finance tests, `billing.spec.ts` |
| Notifications (WhatsApp, email, SMS), templates, campaigns, delivery log, retries | Outbox, dispatcher, providers | Engagement tests (failure isolation, consent, retries), `messages.spec.ts` |
| Biometric attendance abstraction, corrections | `modules/attendance`, providers | Engagement tests (signed push, pull failure contained), Attendance screen sweeps |
| Dashboards (owner, branch, staff), analytics, reports with CSV | `modules/dashboards`, `analytics`, `reports` | Analytics tests, `reports.spec.ts` |
| Audit log, activity screen | `audit_logs`, Activity log | `admin.spec.ts` |
| Security controls | See [SECURITY.md](SECURITY.md) | Route-guard test, auth and RBAC end-to-end tests |
| Two-step sign-in (authenticator app, recovery codes, salon policy, reset) | `core/totp.ts`, `modules/auth/mfa.ts`, Account security screen, *Settings → Privacy* | `totp.test.ts`, `two-factor.test.ts`, `two-factor.spec.ts`, accessibility sweep |
| Online booking for customers | `modules/public-booking`, `/book/:code` | `public-booking.spec.ts`, mobile spec |
| Extreme user-friendliness (plain language, few clicks, shortcuts, empty/loading/error states, undo, role-specific homes, responsive) | Web app throughout | `shortcuts.spec.ts`, `mobile.spec.ts`, accessibility suite, [USER_GUIDE.md](USER_GUIDE.md) |
| Observability, backups, deployment, seed data, API docs, tests | `/metrics`, scripts in `deploy/`, `npm run db:seed`, OpenAPI at `/api/docs` | Manual and scripted checks in section 1 |

## 4. Data integrity checks that run continuously

* Every customer balance equals the sum of that customer's ledger entries (trigger-maintained; `GET /ledger/reconcile`;
  re-checked by `restore.sh`).
* Invoice and payment settlement is verified at commit by deferred constraint triggers.
* Document numbers (bills, receipts, bookings) come from locked sequences and cannot skip or repeat.
* The same request sent twice with one idempotency key produces one invoice or payment.

## 5. Accessibility notes beyond the automated checks

Automated tools find roughly a third of problems. What was also done by design and exercised in tests: every form field has a
visible label and an error message tied to the field; dialogs and drawers trap and restore focus (Radix); everything is
operable by keyboard; status is never colour alone (badges carry text); the booking calendar is a labelled region of buttons;
tap targets are at least 44 px on phones; the layout works at 375 px with no sideways scrolling. **Not done:** manual testing
with a screen reader (NVDA/VoiceOver) and with 200 % browser zoom. Schedule this with a user who relies on assistive technology
before launch if accessibility compliance is a contractual requirement.

## 6. Performance notes

Steady-state endpoints respond in tens of milliseconds on the seeded data (about 160 customers and 570 appointments), and the
indexes and pagination are designed for 100k customers and millions of appointments (see ARCHITECTURE.md §13), but **no load or soak test
has been run**. Before a large launch, run a load test against a production-sized copy (the seed script can generate a larger
history) and watch p95 latency, database connections and the worker's queue depth.

## 7. Open items

Marked **before go-live** where a real salon's money or customers are at stake.

| Item | Why it matters | Suggested action |
| --- | --- | --- |
| **Before go-live:** build the images in CI and scan them | The Docker daemon was not available where this was developed, so the Dockerfiles, nginx config and compose stack were validated statically (`compose config`) and the same builds were run natively, but the images themselves have not been built | CI already builds both images; add an image scan (Trivy or Grype) and run `docker compose up` once in staging |
| **Before go-live:** exercise the real messaging providers | WhatsApp Cloud, SMTP and the HTTP SMS gateway are implemented behind one interface and tested with a console provider and simulated failures, not against live accounts | In staging, connect your accounts in *Settings → Connections*, send a test message on each channel, and confirm delivery receipts arrive |
| **Before go-live:** switch two-step sign-in on | Built (authenticator app, recovery codes, salon policy) but **optional until the owner requires it** | In each salon choose *Settings → Privacy → Required for owners and managers* (at least owners); have every owner enrol and file their recovery codes; platform administrators are required automatically in production |
| **Before go-live:** attendance device vendor | Biometric support is a generic HTTP pull API and a signed push webhook, not a vendor-specific SDK | Confirm your device exposes one of the two, or add a small adapter |
| CI workflow has not run | It is validated by reading, not by GitHub | Open the first pull request and fix any environment difference |
| Status changes are not date-restricted | A receptionist can check in or complete an appointment dated months away; it is a deliberate-action mistake, not a security issue | Optionally restrict check-in, start and complete to the appointment's day (tests would then book for today) |
| Rate limits are in memory per process | Multiple API replicas multiply the limits | Use a shared store (Redis) when scaling out |
| Outbound URL check resolves DNS once | Theoretical DNS rebinding for user-supplied gateway URLs | Egress firewall rule that blocks private ranges from the API host |
| Right to erasure workflow | Customers can be archived and exports are audited, but there is no anonymise-on-request flow | Add a reviewed anonymisation procedure if your jurisdiction requires it (GDPR, India DPDP) and have counsel review consent wording |
| Online payments | A gateway interface exists; payments are recorded at the counter | Integrate a gateway if customers should pay online |
| Languages and currencies | English UI; currency and time zone are per salon, formatting follows the salon's locale | Add translations if needed (strings are centralised in components and error maps) |
| Partitioning and archiving | Not needed at pilot scale | Partition `appointments`, `ledger_entries`, `audit_logs` and `notifications` by month before they exceed tens of millions of rows |

## 8. Go-live checklist

- [ ] Staging deployed from the same images and `deploy/.env` shape as production; `docker compose ps` healthy.
- [ ] The first platform administrator created; the first salon onboarded through *Platform*; the *Setup guide* completed.
- [ ] A real message received on WhatsApp, email and SMS (whichever the salon uses); a failed message shows a clear reason.
- [ ] Online booking tested from a phone, including cancel from the private link.
- [ ] Backup ran, copied off-site, **and a practice restore succeeded** (BACKUP_RECOVERY.md §3).
- [ ] Alerts configured and one deliberately triggered (DEPLOYMENT.md §7).
- [ ] Staff trained with the user guide; each role signs in and sees the right home screen.
- [ ] Owner knows how to reset a team member's password and how to switch someone off.
- [ ] Two-step sign-in required for owners (and managers) in *Settings → Privacy*; every owner enrolled and their recovery codes filed; the lost-phone steps rehearsed once (USER_GUIDE.md).
- [ ] Decision recorded on data-protection obligations.
