# Security

This document describes the security controls that exist in the code today, how to operate the system safely, and the
residual risks we know about. It is written against the implementation, not an aspiration: each statement names where
it is enforced or tested so it can be checked.

Report a vulnerability privately to the address in your deployment's `SECURITY_CONTACT` runbook entry. Do not open a
public issue for a suspected vulnerability.

## 1. Threat model in one page

| Asset | Who might want it | Main attack paths | Primary defences |
| --- | --- | --- | --- |
| One salon's customer data and finances | Another salon (tenant), curious staff, outsiders | Guessing ids, tampering with request bodies, SQL injection, a bug in a query that forgets the tenant filter | Row-level security in PostgreSQL, composite tenant foreign keys, server-side permission checks, validation on every route |
| Staff and owner accounts | Credential stuffers, phishers, former employees | Password guessing, stolen tokens, XSS, CSRF | Argon2id, lockout, two-step sign-in with an authenticator app (required by policy for owners and managers if the salon chooses), rotating refresh tokens with reuse detection, HttpOnly cookie, CSRF header, CSP, immediate session revocation on disable |
| The money trail (bills, payments, ledger) | A dishonest user, a bug | Editing history, double-submitting, negative amounts | Append-only ledger enforced by database grants, idempotency keys, transactions, immutable invoices, audit log |
| Customer contact details and consent | Marketers, leaks | Over-broad exports, messaging without consent | Contact masking by permission, consent checked again at send time, audited exports |
| Integration secrets (WhatsApp token, SMTP password) | Anyone with database or backup access | Reading secrets from the database or a dump | AES-256-GCM at rest, write-only through the API, never logged |
| Availability | Anyone | Request floods, slow queries, provider outages | Rate limits, statement timeout, outbox with retries, provider failures never roll back business transactions |

## 2. Authentication and sessions

* **Passwords** are hashed with Argon2id (`@node-rs/argon2`, 19 MiB memory, 2 iterations). The policy is at least 10
  characters with a letter and a number (`passwordSchema`, shared by the browser and the API). Temporary passwords
  set by an administrator force a change at the next sign-in; resetting a password signs the user out everywhere.
* **Lockout.** After 5 failed attempts (`LOGIN_MAX_ATTEMPTS`) the account is locked for 15 minutes
  (`LOGIN_LOCK_MINUTES`). Messages do not reveal whether the email or the password was wrong.
* **Two-step sign-in (TOTP).** Anyone can switch on a 6-digit code from an authenticator app (RFC 6238: HMAC-SHA1,
  30-second steps, one step of clock drift allowed either way). The implementation is in `core/totp.ts` (checked
  against the RFC's test vectors in `totp.test.ts`) and `modules/auth/mfa.ts`; it has no extra runtime dependency.
  * *After the password, before any session.* A correct password for an account with two-step sign-in returns only a
    5-minute challenge token (`typ: mfa+jwt`, signed with the access-token key but a different type, so it can never
    be used as a bearer token and a bearer token can never stand in for it). No refresh cookie is set until the code
    is accepted at `POST /auth/login/mfa`. A wrong password gives the same answer whether or not two-step sign-in is on.
  * *A code works once.* The last accepted 30-second step is stored (`users.totp_last_step`) and advanced with a
    compare-and-set, so a code that was seen or stolen cannot be replayed, even in two simultaneous requests.
  * *Guessing is bounded.* Wrong codes count toward the same lock-out as wrong passwords (5 attempts, then 15
    minutes), and a correct *password* does not reset that count. The account row is locked while checking, so
    parallel guesses cannot all read the same counter. The sign-in endpoints are also rate limited per address.
  * *Secrets at rest.* The TOTP secret is encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`), like integration
    credentials, and never returned after set-up. A secret that was generated but not confirmed with a first code is
    kept separately and never switches anything on.
  * *Recovery codes.* Switching on produces 10 one-time codes (50 bits each, no look-alike characters), shown once and
    stored only as Argon2id hashes. Each works once; making new ones replaces the whole set.
  * *Changing it needs proof again.* Switching it off or making new recovery codes needs the password **and** a
    current code (or a recovery code), rate limited and counted toward the lock-out. If the salon requires two-step
    sign-in for a role, people in that role cannot switch it off (`MFA_REQUIRED_BY_POLICY`).
  * *Salon policy.* Under *Settings → Privacy* an **owner** (only an owner) chooses *Optional for everyone*,
    *Required for owners* or *Required for owners and managers*. "Manager" is defined by what a role can do, not by its
    name: anyone holding a money-correction, export, audit, staff, user, role, settings or integration permission
    (`MANAGER_PERMISSIONS` in `packages/shared/src/permissions.ts`), so custom roles are covered and the front desk is
    not. A required person without it set up gets `403 MFA_SETUP_REQUIRED` from **every** route except the account and
    security routes (enforced once in the router, not per route), and the app takes them straight to *Account security*.
    Platform administrators are always required to use it in production.
  * *Lost phone.* With a recovery code they sign in and make new codes. Without one, an owner (or any user with
    *manage users*, for non-owners) resets it from *Users and roles*, which also signs that person out everywhere.
    If the only owner is locked out, an operator runs `USER_EMAIL=… npm run user:reset-2fa -w @salon/api` on the server.
    Every one of these is audited (`auth.mfa_enabled`, `auth.mfa_disabled`, `auth.mfa_failed`,
    `auth.recovery_codes_regenerated`, `user.two_factor_reset`).
  * Tests: `totp.test.ts`, `two-factor-policy.test.ts` (shared), `two-factor.test.ts` (API: set-up, challenge,
    replay, lock-out, recovery codes, policy, reset, tenant isolation) and `two-factor.spec.ts` (browser).
* **Access tokens** are 15-minute JWTs (HS256, `jose`, algorithm pinned on verify) held only in browser memory, never
  in `localStorage`.
* **Refresh tokens** are 256-bit random values stored hashed. They live in an `HttpOnly`, `SameSite=Strict` cookie
  scoped to `/api/v1/auth` (`Secure` in production). Each refresh **rotates** the token. Presenting an already-used
  token revokes the whole token family and writes an `auth.refresh_reuse` audit entry (theft detection).
* **CSRF.** The cookie-authenticated endpoints (`/auth/refresh`, `/auth/logout`) require the header
  `X-Requested-With: salonos`, which a cross-site form or image cannot send. All other endpoints use the bearer
  token, which browsers never attach automatically.
* **Disabling a user** revokes every refresh token immediately and invalidates the cached principal, so the next
  request from an already-issued access token is refused. Role or permission changes take effect on the next request.
* End-to-end test `auth.spec.ts` covers sign-in, redirect-after-login, session survival across reload and sign-out
  (this test found and fixed a bug where sign-out did not send the CSRF header and left the cookie valid).

## 3. Authorization

* **Permissions are checked on the server for every route.** Each route declares the permissions it needs, and a test
  (`route-guards.test.ts`) fails if any salon route is left open to every signed-in user other than a short, reviewed
  allow-list (the branch picker and holiday list), or if a public route appears outside sign-in, online booking and webhooks. The browser hides links the
  user cannot use, but hiding is cosmetic: `rbac.spec.ts` types forbidden addresses and calls the API directly.
* **Roles** are editable per salon. The Owner role is locked and always complete. Nobody can grant a permission they
  do not hold, assign a role with more access than their own, edit their own role, or remove the last owner.
* **Branch scoping.** Users see only the branches assigned to them. List endpoints filter with `branchFilter`; endpoints
  that take a branch id call `assertBranchAccess` and answer 403 `BRANCH_ACCESS_DENIED`. Staff roles that only have
  "own appointments" are restricted to appointments they perform.
* **Platform administrators** have no salon and cannot read tenant data through tenant routes; they manage
  organizations through `/platform` only.

## 4. Tenant isolation

Isolation does not rely on every query remembering a `WHERE organization_id = …`:

1. The runtime database role (`salon_app`) is **not the table owner**, so PostgreSQL row-level security always applies
   to it. Migrations run as a different owner role.
2. Every request runs inside `withTenant`, which sets `app.org_id` for the transaction; policies compare
   `organization_id` to it. System jobs use `withSystem`, which is explicit and greppable.
3. Foreign keys between tenant-owned tables are composite `(organization_id, id)`, so a row cannot reference another
   tenant's row even if application code is wrong.
4. Integration tests create two salons and assert that each gets 404 for the other's records and empty lists.

## 5. Input handling

* Every route validates `body`, `query` and `params` with Zod schemas from `packages/shared`; the same schemas run in the
  browser. Unknown and malformed input is rejected with field-level messages that do not echo internals.
* SQL is built with Kysely parameter binding; the few raw fragments use `sql` template parameters, never string
  concatenation. User-typed search text is always a bound parameter.
* JSON bodies are limited to 1 MB. The raw body is kept only for webhook signature verification.
* Output is rendered by React (escaped by default); the app contains no `dangerouslySetInnerHTML`.
* CSV exports neutralize formula injection (cells starting with `= + - @` are prefixed).
* Errors returned to clients carry an `errorCode`, a plain-language message and a request id, never stack traces or SQL.
  Database constraint violations are translated to friendly messages.

## 6. Transport, headers and browser hardening

* TLS is terminated in front of the app (see DEPLOYMENT.md). The API sets HSTS through Helmet in production and cookies
  are `Secure`.
* **Content Security Policy:** `default-src 'self'; script-src 'self'` (no inline or eval scripts). `style-src` allows
  `'unsafe-inline'` because Radix, Recharts and Sonner set inline `style` attributes; no user-controlled markup is
  rendered, so this does not open a script-injection path.
* `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, a strict `Referrer-Policy`,
  and a `Permissions-Policy` that disables camera, microphone, geolocation and payment.
* **CORS** is an allow-list (`CORS_ORIGINS`); production refuses `*`. The app is served same-origin, so no CORS is needed
  for the browser at all.

## 7. Rate limiting and abuse controls

| Endpoint group | Limit |
| --- | --- |
| Sign-in, including the code step | 20 per 15 minutes per address (plus per-account lockout) |
| Switching off two-step sign-in, new recovery codes | 10 per 15 minutes per address (plus the same lockout) |
| Refresh | 60 per minute per address |
| Authenticated API | 600 per minute per address |
| Public booking pages | 40 per 15 minutes; creating a booking 8 per hour per address |
| Pending-payment reminders | At most one per customer per interval and a monthly cap (configurable) |

Public booking also has a honeypot field, strictly validated input, availability re-checked on the server, and
unguessable manage links (the token is 256-bit random and only its SHA-256 hash is stored). Manage links cannot cancel or
move a booking within two hours of the appointment.

`RATE_LIMIT_MULTIPLIER` exists for end-to-end and load tests and **must be 1 in production** (startup fails otherwise).

## 8. Secrets and sensitive data

* Required secrets are validated at start-up. In production the process refuses to start with the example secrets
  from `.env.example`, the all-zero encryption key, wildcard CORS, console notification mode, a missing
  `METRICS_TOKEN`, or a rate-limit multiplier.
* **Integration credentials** (WhatsApp access token, SMTP password, SMS key, device keys) are stored per salon,
  encrypted with AES-256-GCM using `DATA_ENCRYPTION_KEY`. The API never returns them: it returns only the names of the
  secrets that are set. Editing a connection and leaving a secret blank keeps the saved value.
* **Outbound URLs** supplied by users (SMS gateway, attendance system) must be https in production and must resolve to
  public addresses (private ranges are refused), with a 10-second timeout.
* **Webhooks** are authenticated: WhatsApp receipts by `X-Hub-Signature-256` HMAC with the app secret; attendance
  devices by an HMAC signature using a per-connection secret that is shown once and can be rotated.
* Logs are structured JSON with redaction of authorization headers, cookies, passwords, tokens and secrets at the
  logger, so individual call sites cannot leak them. Query strings are stripped from logged URLs.
* **Personal data.** Phone numbers and emails are masked for roles without the "see contact details" permission (and
  by the salon-level privacy setting). Exporting customers or reports is audited. Marketing messages require recorded
  consent, which is checked again at send time, and transactional messages (confirmations, receipts) are separate.

## 9. Financial integrity

* Money is stored as integer minor units; rates as basis points; no floating point arithmetic on amounts.
* All financial writes run in one transaction. The ledger is append-only: the runtime role has no `UPDATE` or `DELETE`
  on `ledger_entries`, `audit_logs`, `appointment_events`, `invoice_items`, `refunds`, `ledger_adjustments`, and no `DELETE`
  on invoices or payments. Corrections are new entries (void, refund, adjustment) with a required reason.
* Customer balances are maintained by a trigger from the ledger; deferred constraint triggers verify that invoice and
  payment settlement add up at commit. `GET /ledger/reconcile` and `deploy/scripts/restore.sh` re-check the identity.
* Money endpoints accept an `Idempotency-Key`; retries and double-clicks return the first result instead of charging twice.
* Credit limits are enforced on the server; overriding one needs a separate permission and is audited.

## 10. Audit trail

Security-relevant and business-critical actions write to `audit_logs` in the same transaction as the change: sign-in
anomalies, user and role changes, price and setting changes, bill and payment operations, attendance corrections,
exports and integration changes. Entries record who, what, before/after values, request id and IP, and cannot be
edited or deleted by the application. They are searchable in the app under *Activity log*.

## 11. Dependencies and supply chain

* Versions are pinned exactly in `package.json`; `package-lock.json` is committed and CI uses `npm ci`.
* CI runs `npm audit --omit=dev --audit-level=high`; Dependabot opens weekly update PRs for npm, Docker and Actions.
* Container images run as a non-root user and contain only production dependencies.
* At the time of writing the only advisory reported by `npm audit` is in a development-only code generator
  (`kysely-codegen` → `braces`); it is not part of any runtime image.

## 12. Testing that backs these claims

* 100+ API integration tests (tenant isolation, permissions, double-booking races, ledger integrity, idempotency,
  consent, notification failure isolation).
* End-to-end tests in a real browser for sign-in/out, role-based access, billing, public booking, user and role
  administration, and mobile layouts.
* Defects found by these tests and fixed during development include: sign-out not clearing the refresh cookie; an
  unassigned walk-in that could not be cancelled because of a database constraint; availability offering times the
  server would refuse; and a clean-up period that let staff appear free while still blocked.

## 13. Operating it safely (checklist)

- [ ] Generate every secret with a CSPRNG; keep them in a secret manager, not in the repository or the image.
- [ ] Put TLS in front of the web container; confirm `Secure` cookies and HSTS are present.
- [ ] Set `TRUST_PROXY` to the real number of proxy hops so rate limiting sees client addresses, not the proxy.
- [ ] Use separate database passwords for the superuser, the owner (migrations) and the runtime role.
- [ ] Restrict network access to PostgreSQL to the API, worker and backup host only.
- [ ] Schedule `deploy/scripts/backup.sh`, encrypt backups, copy them off-site, and rehearse `restore.sh` quarterly.
- [ ] Scrape `/metrics` with the bearer token; alert on 5xx rate, slow requests, failed notifications and worker lag.
- [ ] Review the Activity log and the *Delivery* page for unusual spikes weekly.
- [ ] Rotate `JWT_ACCESS_SECRET` (signs everyone out) and `DATA_ENCRYPTION_KEY` (re-enter integration secrets) on a schedule or after any suspected exposure.

## 14. Known limitations and residual risks

These are deliberate scope decisions or open items, listed so they are not mistaken for protections:

1. **Two-step sign-in is optional until the owner requires it, and is an authenticator app only.** Out of the box
   nobody is required to use it (the owner chooses in *Settings → Privacy*; production platform administrators are
   always required). There is no SMS code, push approval or hardware security key (WebAuthn): phishing-resistant keys
   would be the next step up. A phishing page that relays both the password and the current code in real time can still
   win, as with any TOTP system. Anyone holding the unlocked phone *and* the password can sign in.
2. **No self-service password reset.** By design, a manager or owner sets a temporary password (the sign-in screen says
   so). This avoids email-based account takeover but depends on trusted administrators.
3. **Rate limits are in memory per process.** With several API replicas the effective limit is multiplied by the number
   of replicas. Use a shared store (for example Redis) or sticky routing at the proxy if you scale horizontally.
4. **Outbound URL checks resolve DNS at validation time.** A hostile DNS server could change its answer between the
   check and the request (DNS rebinding). Mitigate with an egress firewall that blocks private ranges from the API host.
5. **`style-src 'unsafe-inline'`** is required by the UI libraries (see section 6).
6. **JWT access tokens cannot be revoked individually** before they expire (15 minutes); disabling a user and
   permission changes are enforced on the next request through the principal cache, and refresh is cut off immediately.
7. **Backups contain personal data and the encrypted integration secrets.** Encrypt them (the script supports GPG)
   and protect the encryption key separately from the backups.
