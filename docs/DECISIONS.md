# Decisions & assumptions

Where the requirements were ambiguous, the most robust option consistent with the rest of the brief was chosen. Each
entry says what was decided and why, so it can be revisited deliberately.

## Platform & data

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Express 5 + Kysely + hand-written SQL migrations (not an ORM schema DSL). | The data model relies on PostgreSQL features that ORMs model poorly: exclusion constraints, composite tenant FKs, RLS policies, partial unique indexes, immutability triggers. Kysely gives type-safe queries generated from the real schema. |
| D2 | Money is `bigint` minor units (paise). Percentages are basis points (`1800` = 18%). | Exact arithmetic in both SQL and JavaScript without a decimal library. Rounding happens once per invoice line (half-up). |
| D3 | Status columns are `text` + `CHECK`, not PostgreSQL enums. | Adding a status is a one-line constraint change; enums need careful migration. |
| D4 | UUID primary keys (`gen_random_uuid()`); human-facing numbers (`INV-RJT-2026-000123`, `C000042`, `BK-…`) come from gapless per-branch/per-org sequences. | IDs are never shown to users (requirement 86.1); numbers are readable and concurrency-safe. |
| D5 | Shared-schema multi-tenancy with RLS + composite foreign keys. | Cheapest to operate for thousands of small tenants, while still giving database-enforced isolation. A very large tenant can later be moved to a dedicated database without code changes (connection routing by organization). |
| D6 | PostgreSQL doubles as the job queue (outbox + `SKIP LOCKED`). | One less piece of infrastructure; notifications are written atomically with the business change. |

## Business model

| # | Decision | Reason |
| --- | --- | --- |
| B1 | **Customers belong to the organization, not a branch.** One customer record per organization, usable at every branch. Transactions (appointments, invoices, payments) are branch-scoped. | A chain's customer visits several branches; duplicated customer records would break history and the credit ledger. Branch users see the customer profile, but transactional history and ledger lines only for branches they can access; the org-wide outstanding total is shown as a single figure so receptionists know to collect. |
| B2 | A **walk-in is an appointment with `source = walk_in`** that starts in status `waiting` (no staff/time yet). Assigning staff turns it into a timed booking. | One scheduling source of truth: a walk-in being served blocks the stylist's calendar exactly like a booking, and the same exclusion constraint prevents conflicts. The walk-in board labels states Waiting → Assigned → In Service → Completed → Billed. |
| B3 | **Rescheduling keeps the same appointment and booking number.** The move is recorded in `appointment_events` and shown as a "Rescheduled" badge with a reschedule count; reports count reschedules from events. | Customers and staff keep one reference; history is still complete. A terminal "Rescheduled" status would split one visit into several records and confuse reporting. |
| B4 | **Billing creates issued invoices directly** (no editable drafts). The bill is composed in the UI and committed atomically. Corrections are voids or adjustments. | Avoids half-finished financial documents and "silent changes" (requirement 85). |
| B5 | "Credit" is not a payment method in storage: an invoice issued with an unpaid balance *is* credit. The UI offers "Pay later (credit)". | Keeps the ledger meaningful: debit = invoice, credit = payment. |
| B6 | Over-payments become customer **advance balance** (negative outstanding) and can be applied to later invoices. | Real salons take advances for bridal packages. |
| B7 | Credit limit: `NULL` = no limit, `0` = credit not allowed. Exceeding it returns a warning; users with `billing.override_credit_limit` can continue, others must ask a manager. | Requirement 26 says "warn", but uncontrolled override defeats the limit. |
| B8 | Package revenue is recognised at sale; redemption lines are zero-priced and consume the package balance. Voiding the sale invoice is blocked once any redemption exists. | Matches how salons account for packages; deferred-revenue accounting is a future accounting-integration concern. |
| B9 | One promotional offer per invoice plus an optional manual discount (permission-gated, with reason). | Stacking rules quickly become unpredictable for receptionists; one offer is explainable on the receipt. |
| B10 | Staff have one primary branch. | Covers the common case; multi-branch staff can be added with a `staff_branches` table without changing scheduling (bookings are already per branch). |
| B11 | Staff eligibility for a service is the explicit **staff ↔ service mapping**. A service's required expertise is used to validate and auto-suggest mappings. | Gives the owner precise control ("Priya does bridal makeup but not party makeup") while expertise remains configurable master data. |
| B12 | Tax is a per-service rate with an organisation default and a prices-include-tax switch. The receipt shows one tax total (label configurable, e.g. "GST"). | Works across countries; CGST/SGST splits can be rendered from the same data later. |
| B13 | Staff performance metrics are visible to staff only when the owner enables `staff_can_view_own_performance`. Customer phone numbers are masked for staff unless `staff_can_view_customer_phone` is enabled. | Requirements 35, 36, 73 (data minimisation). |
| B14 | Customer self-booking is implemented as a public page per organization, disabled by default. Customers manage their booking through a signed link; no customer passwords. | Requirement 43 asks for the design to allow it; a signed link avoids storing customer credentials. |
| B15 | Notification templates are per organization with sensible defaults seeded at onboarding. For WhatsApp, the provider template name is stored alongside the text because Meta requires pre-approved templates for business-initiated messages. | Requirement 44/45 and WhatsApp policy. |
| B16 | Marketing messages require explicit marketing consent; transactional messages (confirmation, reminder, receipt, outstanding) are sent unless the customer opted out of that category/channel. Reminders respect quiet hours. | Requirements 30, 33, 72, 73. |
| B17 | Reports export CSV (opens in Excel). PDF is produced from print-optimised views via the browser's "Save as PDF". | Keeps the server free of heavy PDF rendering; native `.xlsx` export can be added behind the same export endpoint. |
| B18 | Week starts on Monday; weekdays are ISO numbers 1 (Mon) … 7 (Sun). | Unambiguous across locales. |

## Security

| # | Decision | Reason |
| --- | --- | --- |
| S1 | Two-step sign-in is **TOTP (authenticator app) with one-time recovery codes**, optional by default, with a per-salon policy: optional / required for owners / required for owners and managers. Only an owner can change the policy. | The broadest-compatible second factor that needs no SMS or paid service and no vendor lock-in. A salon-level switch lets a small salon start gently and a chain insist. Letting a non-owner relax the policy would defeat it. |
| S2 | "Manager" is **defined by permissions, not role names** (`MANAGER_PERMISSIONS`: money corrections, exports, audit, staff, user, role, settings and integration administration). Receptionists are not managers even though they can see the branch dashboard. | Roles are editable and custom roles are common; a name check would miss a "Supervisor" role with refund rights. Front-desk staff handle payments all day, and forcing a second step on them has a real speed cost with little extra protection. |
| S3 | The requirement is **enforced on the server in the router**, not per route: a required person who has not set it up gets `403 MFA_SETUP_REQUIRED` everywhere except the account and security routes. | A new route cannot forget the check, and hiding links in the browser would not be a control. The web app additionally sends them straight to the set-up screen. |
| S4 | A wrong code counts toward the **same lock-out** as a wrong password, and a correct password does **not** reset the count until the code step succeeds. A code is accepted once (last accepted step stored, compare-and-set). | Otherwise a stolen password would buy unlimited tries at a 6-digit code, and a shoulder-surfed code could be replayed. |
| S5 | Switching two-step sign-in off, or making new recovery codes, needs **password and a code**, and is refused when the salon requires it for that person. | A stolen session (15-minute access token) must not be enough to weaken the account. People cannot opt out of a rule the owner has set. |
| S6 | Recovery is layered: recovery codes → an owner resets it in the app (also signs the person out everywhere) → an operator command for a sole owner who is locked out. All are audited. There is no email- or SMS-based reset. | Self-service resets are the usual way two-step sign-in is bypassed by attackers. The decision keeps the "ask a trusted administrator" model already used for passwords (see SECURITY.md §14). |
| S7 | **Platform administrators are required** to use it in production (never in development or tests). | They can onboard and suspend every salon; their accounts are the highest-value target. Skipping it locally keeps demos and end-to-end tests simple. |
| S8 | The TOTP algorithm is implemented in ~100 lines on `node:crypto` and verified against the RFC 6238 test vectors rather than adding a dependency. | Fewer supply-chain dependencies for a security-critical path; the code is short, standard and fully covered by tests. (The browser draws the set-up QR code with the `qrcode` package, which handles no secrets that are not already on screen.) |
