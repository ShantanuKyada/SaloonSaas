-- 0004 Offers, packages, invoices, payments, refunds, adjustments and the append-only customer ledger.

-- ───────────────────────────── Offers ─────────────────────────────
create table offers (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organizations (id),
  name                     text not null check (length(btrim(name)) between 2 and 120),
  description              text,
  code                     citext check (code ~ '^[A-Za-z0-9-]{3,30}$'),
  discount_type            text not null check (discount_type in ('percentage', 'flat')),
  discount_value           bigint not null check (discount_value > 0),
  max_discount_amount      bigint check (max_discount_amount > 0),
  min_bill_amount          bigint check (min_bill_amount >= 0),
  applies_to               text not null default 'all_services'
                           check (applies_to in ('all_services', 'services', 'categories', 'combo')),
  eligibility              text not null default 'all'
                           check (eligibility in ('all', 'first_visit', 'birthday', 'loyalty', 'specific_customers')),
  loyalty_min_visits       int check (loyalty_min_visits > 0),
  loyalty_min_spend        bigint check (loyalty_min_spend > 0),
  birthday_window_days     int not null default 7 check (birthday_window_days between 0 and 31),
  valid_from               date not null,
  valid_to                 date not null,
  valid_weekdays           smallint[],
  all_branches             boolean not null default true,
  auto_apply               boolean not null default false,
  usage_limit_total        int check (usage_limit_total > 0),
  usage_limit_per_customer int check (usage_limit_per_customer > 0),
  usage_count              int not null default 0 check (usage_count >= 0),
  status                   text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  created_by               uuid references users (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (valid_to >= valid_from),
  check (discount_type <> 'percentage' or discount_value <= 10000),
  check (usage_limit_total is null or usage_count <= usage_limit_total),
  unique (organization_id, id)
);
create unique index offers_code_unique on offers (organization_id, code) where code is not null and status <> 'archived';
create index offers_validity on offers (organization_id, status, valid_from, valid_to);

create table offer_services (
  organization_id uuid not null,
  offer_id        uuid not null,
  service_id      uuid not null,
  primary key (offer_id, service_id),
  foreign key (organization_id, offer_id) references offers (organization_id, id) on delete cascade,
  foreign key (organization_id, service_id) references services (organization_id, id)
);
create table offer_categories (
  organization_id uuid not null,
  offer_id        uuid not null,
  category_id     uuid not null,
  primary key (offer_id, category_id),
  foreign key (organization_id, offer_id) references offers (organization_id, id) on delete cascade,
  foreign key (organization_id, category_id) references service_categories (organization_id, id)
);
create table offer_branches (
  organization_id uuid not null,
  offer_id        uuid not null,
  branch_id       uuid not null,
  primary key (offer_id, branch_id),
  foreign key (organization_id, offer_id) references offers (organization_id, id) on delete cascade,
  foreign key (organization_id, branch_id) references branches (organization_id, id)
);
create table offer_customers (
  organization_id uuid not null,
  offer_id        uuid not null,
  customer_id     uuid not null,
  primary key (offer_id, customer_id),
  foreign key (organization_id, offer_id) references offers (organization_id, id) on delete cascade,
  foreign key (organization_id, customer_id) references customers (organization_id, id)
);

-- ───────────────────────────── Packages ─────────────────────────────
create table packages (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations (id),
  code              citext not null check (code ~ '^[A-Za-z0-9-]{2,20}$'),
  name              text not null check (length(btrim(name)) between 2 and 120),
  description       text,
  price             bigint not null check (price >= 0),
  tax_rate_bp       int check (tax_rate_bp between 0 and 10000),
  validity_days     int not null check (validity_days between 1 and 1095),
  all_branches      boolean not null default true,
  customer_segment  text not null default 'all' check (customer_segment in ('all', 'new_customers', 'existing_customers')),
  max_per_customer  int check (max_per_customer > 0),
  sale_limit_total  int check (sale_limit_total > 0),
  sold_count        int not null default 0 check (sold_count >= 0),
  sale_starts_on    date,
  sale_ends_on      date,
  status            text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  created_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (sale_ends_on is null or sale_starts_on is null or sale_ends_on >= sale_starts_on),
  check (sale_limit_total is null or sold_count <= sale_limit_total),
  unique (organization_id, code),
  unique (organization_id, id)
);

create table package_items (
  organization_id uuid not null,
  package_id      uuid not null,
  service_id      uuid not null,
  quantity        int not null check (quantity between 1 and 100),
  primary key (package_id, service_id),
  foreign key (organization_id, package_id) references packages (organization_id, id) on delete cascade,
  foreign key (organization_id, service_id) references services (organization_id, id)
);

create table package_branches (
  organization_id uuid not null,
  package_id      uuid not null,
  branch_id       uuid not null,
  primary key (package_id, branch_id),
  foreign key (organization_id, package_id) references packages (organization_id, id) on delete cascade,
  foreign key (organization_id, branch_id) references branches (organization_id, id)
);

-- ───────────────────────────── Invoices ─────────────────────────────
create table invoices (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null,
  branch_id              uuid not null,
  customer_id            uuid not null,
  invoice_number         text not null,
  appointment_id         uuid,
  invoice_date           date not null,
  issued_at              timestamptz not null default now(),
  due_date               date,
  status                 text not null default 'issued' check (status in ('issued', 'void')),
  prices_include_tax     boolean not null,
  subtotal               bigint not null check (subtotal >= 0),
  discount_total         bigint not null default 0 check (discount_total >= 0),
  tax_total              bigint not null default 0 check (tax_total >= 0),
  round_off              bigint not null default 0,
  grand_total            bigint not null check (grand_total >= 0),
  amount_paid            bigint not null default 0 check (amount_paid >= 0),
  amount_adjusted        bigint not null default 0 check (amount_adjusted >= 0),
  balance_due            bigint not null check (balance_due >= 0),
  payment_status         text not null check (payment_status in ('unpaid', 'partial', 'paid', 'void')),
  offer_id               uuid,
  offer_discount         bigint not null default 0 check (offer_discount >= 0),
  manual_discount        bigint not null default 0 check (manual_discount >= 0),
  manual_discount_reason text,
  notes                  text,
  created_by             uuid not null references users (id),
  voided_at              timestamptz,
  voided_by              uuid references users (id),
  void_reason            text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, appointment_id) references appointments (organization_id, id),
  foreign key (organization_id, offer_id) references offers (organization_id, id),
  check (discount_total <= subtotal),
  check ((status = 'void') = (voided_at is not null)),
  check (status <> 'void' or (amount_paid = 0 and amount_adjusted = 0 and balance_due = 0 and payment_status = 'void')),
  check (status <> 'issued' or balance_due = grand_total - amount_paid - amount_adjusted),
  check (status <> 'issued' or payment_status = case
           when balance_due = 0 then 'paid'
           when amount_paid + amount_adjusted = 0 then 'unpaid'
           else 'partial' end),
  unique (organization_id, invoice_number),
  unique (organization_id, id)
);
create index invoices_branch_date on invoices (organization_id, branch_id, invoice_date);
create index invoices_customer on invoices (organization_id, customer_id, invoice_date desc);
create index invoices_open on invoices (organization_id, branch_id, invoice_date) where status = 'issued' and balance_due > 0;
create unique index invoices_one_per_appointment on invoices (appointment_id) where appointment_id is not null and status = 'issued';

-- Issued invoices are immutable except for settlement and void fields.
create or replace function invoices_guard_immutable() returns trigger
language plpgsql as $$
begin
  if old.status = 'void' then
    raise exception 'Invoice % is void and cannot be changed', old.invoice_number using errcode = 'P0001';
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.branch_id is distinct from old.branch_id
     or new.customer_id is distinct from old.customer_id
     or new.invoice_number is distinct from old.invoice_number
     or new.invoice_date is distinct from old.invoice_date
     or new.issued_at is distinct from old.issued_at
     or new.subtotal is distinct from old.subtotal
     or new.discount_total is distinct from old.discount_total
     or new.tax_total is distinct from old.tax_total
     or new.round_off is distinct from old.round_off
     or new.grand_total is distinct from old.grand_total
     or new.offer_id is distinct from old.offer_id
     or new.offer_discount is distinct from old.offer_discount
     or new.manual_discount is distinct from old.manual_discount
     or new.appointment_id is distinct from old.appointment_id
     or new.created_by is distinct from old.created_by then
    raise exception 'Issued invoice % cannot be edited; void it or post an adjustment', old.invoice_number
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger invoices_immutable before update on invoices for each row execute function invoices_guard_immutable();
create trigger invoices_no_delete before delete on invoices for each row execute function prevent_modification();

create table invoice_items (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  invoice_id               uuid not null,
  line_no                  int not null check (line_no > 0),
  item_type                text not null check (item_type in ('service', 'package_sale', 'package_redemption', 'custom')),
  service_id               uuid,
  package_id               uuid,
  customer_package_item_id uuid,
  appointment_item_id      uuid,
  staff_id                 uuid,
  description              text not null,
  quantity                 int not null check (quantity between 1 and 999),
  unit_price               bigint not null check (unit_price >= 0),
  gross_amount             bigint not null check (gross_amount >= 0),
  discount_amount          bigint not null default 0 check (discount_amount >= 0),
  tax_rate_bp              int not null default 0 check (tax_rate_bp between 0 and 10000),
  taxable_amount           bigint not null check (taxable_amount >= 0),
  tax_amount               bigint not null check (tax_amount >= 0),
  line_total               bigint not null check (line_total >= 0),
  created_at               timestamptz not null default now(),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id),
  foreign key (organization_id, service_id) references services (organization_id, id),
  foreign key (organization_id, package_id) references packages (organization_id, id),
  foreign key (organization_id, appointment_item_id) references appointment_items (organization_id, id),
  foreign key (organization_id, staff_id) references staff (organization_id, id),
  check (gross_amount = quantity * unit_price),
  check (discount_amount <= gross_amount),
  check (item_type <> 'service' or service_id is not null),
  check (item_type <> 'package_sale' or package_id is not null),
  check (item_type <> 'package_redemption' or (customer_package_item_id is not null and service_id is not null and unit_price = 0)),
  unique (invoice_id, line_no),
  unique (organization_id, id)
);
create index invoice_items_service on invoice_items (organization_id, service_id);
create index invoice_items_staff on invoice_items (organization_id, staff_id);
create trigger invoice_items_append_only before update or delete on invoice_items
  for each row execute function prevent_modification();

-- ───────────────────────────── Customer packages ─────────────────────────────
create table customer_packages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id     uuid not null,
  package_id      uuid not null,
  branch_id       uuid not null,
  invoice_id      uuid not null,
  invoice_item_id uuid not null,
  price_paid      bigint not null check (price_paid >= 0),
  purchased_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  status          text not null default 'active' check (status in ('active', 'expired', 'exhausted', 'cancelled')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, package_id) references packages (organization_id, id),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id),
  foreign key (organization_id, invoice_item_id) references invoice_items (organization_id, id),
  check (expires_at > purchased_at),
  unique (organization_id, id)
);
create index customer_packages_customer on customer_packages (organization_id, customer_id, status);

create table customer_package_items (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  customer_package_id uuid not null,
  service_id          uuid not null,
  quantity_total      int not null check (quantity_total > 0),
  quantity_used       int not null default 0 check (quantity_used >= 0),
  foreign key (organization_id, customer_package_id) references customer_packages (organization_id, id),
  foreign key (organization_id, service_id) references services (organization_id, id),
  check (quantity_used <= quantity_total),
  unique (customer_package_id, service_id),
  unique (organization_id, id)
);

alter table invoice_items add constraint invoice_items_cpi_fk
  foreign key (organization_id, customer_package_item_id) references customer_package_items (organization_id, id);
alter table appointment_items add constraint appointment_items_cpi_fk
  foreign key (organization_id, customer_package_item_id) references customer_package_items (organization_id, id);
alter table appointments add constraint appointments_invoice_fk
  foreign key (organization_id, invoice_id) references invoices (organization_id, id);

create table package_redemptions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  customer_package_item_id uuid not null,
  invoice_id               uuid not null,
  invoice_item_id          uuid not null,
  branch_id                uuid not null,
  quantity                 int not null check (quantity > 0),
  redeemed_at              timestamptz not null default now(),
  redeemed_by              uuid references users (id),
  reversed_at              timestamptz,
  reversed_by              uuid references users (id),
  foreign key (organization_id, customer_package_item_id) references customer_package_items (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id),
  foreign key (organization_id, invoice_item_id) references invoice_items (organization_id, id),
  foreign key (organization_id, branch_id) references branches (organization_id, id)
);
create index package_redemptions_item on package_redemptions (customer_package_item_id) where reversed_at is null;

create table offer_redemptions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  offer_id        uuid not null,
  invoice_id      uuid not null,
  customer_id     uuid not null,
  discount_amount bigint not null check (discount_amount > 0),
  redeemed_at     timestamptz not null default now(),
  reversed_at     timestamptz,
  foreign key (organization_id, offer_id) references offers (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  unique (invoice_id)
);
create index offer_redemptions_customer on offer_redemptions (organization_id, offer_id, customer_id) where reversed_at is null;

-- ───────────────────────────── Payments ─────────────────────────────
create table payments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  branch_id        uuid not null,
  customer_id      uuid not null,
  receipt_number   text not null,
  amount           bigint not null check (amount > 0),
  method           text not null check (method in ('cash', 'upi', 'card', 'bank_transfer', 'online', 'other')),
  reference        text,
  received_at      timestamptz not null default now(),
  received_by      uuid not null references users (id),
  allocated_amount bigint not null default 0 check (allocated_amount >= 0),
  refunded_amount  bigint not null default 0 check (refunded_amount >= 0),
  status           text not null default 'completed' check (status in ('completed', 'void')),
  notes            text,
  voided_at        timestamptz,
  voided_by        uuid references users (id),
  void_reason      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  check (allocated_amount + refunded_amount <= amount),
  check ((status = 'void') = (voided_at is not null)),
  check (status <> 'void' or (allocated_amount = 0 and refunded_amount = 0)),
  unique (organization_id, receipt_number),
  unique (organization_id, id)
);
create index payments_branch_time on payments (organization_id, branch_id, received_at);
create index payments_customer on payments (organization_id, customer_id, received_at desc);
create index payments_unallocated on payments (organization_id, customer_id)
  where status = 'completed' and allocated_amount + refunded_amount < amount;

create or replace function payments_guard_immutable() returns trigger
language plpgsql as $$
begin
  if old.status = 'void' then
    raise exception 'Payment % is void and cannot be changed', old.receipt_number using errcode = 'P0001';
  end if;
  if new.amount is distinct from old.amount or new.customer_id is distinct from old.customer_id
     or new.branch_id is distinct from old.branch_id or new.method is distinct from old.method
     or new.received_at is distinct from old.received_at or new.receipt_number is distinct from old.receipt_number then
    raise exception 'Payment % cannot be edited; void it instead', old.receipt_number using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger payments_immutable before update on payments for each row execute function payments_guard_immutable();
create trigger payments_no_delete before delete on payments for each row execute function prevent_modification();

create table payment_allocations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payment_id      uuid not null,
  invoice_id      uuid not null,
  amount          bigint not null check (amount > 0),
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  reversed_at     timestamptz,
  reversed_by     uuid references users (id),
  reversal_reason text,
  foreign key (organization_id, payment_id) references payments (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id)
);
create index payment_allocations_payment on payment_allocations (payment_id) where reversed_at is null;
create index payment_allocations_invoice on payment_allocations (invoice_id) where reversed_at is null;
create trigger payment_allocations_no_delete before delete on payment_allocations
  for each row execute function prevent_modification();

create table refunds (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  customer_id     uuid not null,
  refund_number   text not null,
  payment_id      uuid not null,
  amount          bigint not null check (amount > 0),
  method          text not null check (method in ('cash', 'upi', 'card', 'bank_transfer', 'online', 'other')),
  reference       text,
  reason          text not null,
  refunded_at     timestamptz not null default now(),
  created_by      uuid not null references users (id),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, payment_id) references payments (organization_id, id),
  unique (organization_id, refund_number)
);
create index refunds_branch_time on refunds (organization_id, branch_id, refunded_at);
create trigger refunds_append_only before update or delete on refunds for each row execute function prevent_modification();

create table ledger_adjustments (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  branch_id         uuid not null,
  customer_id       uuid not null,
  adjustment_number text not null,
  adjustment_type   text not null check (adjustment_type in ('credit', 'write_off', 'discount')),
  invoice_id        uuid not null,
  amount            bigint not null check (amount > 0),
  reason            text not null check (length(btrim(reason)) >= 3),
  created_by        uuid not null references users (id),
  created_at        timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id),
  unique (organization_id, adjustment_number)
);
create trigger ledger_adjustments_append_only before update or delete on ledger_adjustments
  for each row execute function prevent_modification();

-- ───────────────────────────── Ledger ─────────────────────────────
create table ledger_entries (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  branch_id       uuid not null,
  customer_id     uuid not null,
  entry_type      text not null check (entry_type in ('invoice', 'payment', 'refund', 'credit_adjustment', 'write_off',
                                                      'discount', 'invoice_void', 'payment_void')),
  source_type     text not null check (source_type in ('invoice', 'payment', 'refund', 'adjustment')),
  source_id       uuid not null,
  reference       text not null,
  description     text not null,
  debit           bigint not null default 0 check (debit >= 0),
  credit          bigint not null default 0 check (credit >= 0),
  occurred_at     timestamptz not null default now(),
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  check ((debit > 0) <> (credit > 0))
);
create index ledger_entries_customer on ledger_entries (organization_id, customer_id, occurred_at, id);
create index ledger_entries_branch_time on ledger_entries (organization_id, branch_id, occurred_at);
create index ledger_entries_source on ledger_entries (source_type, source_id);
create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function prevent_modification();

create or replace function ledger_entries_apply_balance() returns trigger
language plpgsql as $$
begin
  insert into customer_accounts as ca (customer_id, organization_id, balance, total_debits, total_credits, last_entry_at)
  values (new.customer_id, new.organization_id, new.debit - new.credit, new.debit, new.credit, new.occurred_at)
  on conflict (customer_id) do update
    set balance       = ca.balance + excluded.balance,
        total_debits  = ca.total_debits + excluded.total_debits,
        total_credits = ca.total_credits + excluded.total_credits,
        last_entry_at = greatest(ca.last_entry_at, excluded.last_entry_at);
  return null;
end $$;
create trigger ledger_entries_balance after insert on ledger_entries
  for each row execute function ledger_entries_apply_balance();

-- Deferred integrity checks: settlement columns must always equal the sum of their allocations.
create or replace function verify_invoice_settlement() returns trigger
language plpgsql as $$
declare
  v_invoice_id uuid;
  v_paid bigint;
  v_adjusted bigint;
  v_invoice record;
begin
  -- Field access is resolved at execution time, so each branch only touches columns its table has.
  if tg_table_name = 'invoices' then
    v_invoice_id := new.id;
  else
    v_invoice_id := new.invoice_id;
  end if;
  select * into v_invoice from invoices where id = v_invoice_id;
  if not found then return null; end if;
  select coalesce(sum(amount), 0) into v_paid from payment_allocations where invoice_id = v_invoice_id and reversed_at is null;
  select coalesce(sum(amount), 0) into v_adjusted from ledger_adjustments where invoice_id = v_invoice_id;
  if v_invoice.status = 'issued' and (v_paid <> v_invoice.amount_paid or v_adjusted <> v_invoice.amount_adjusted) then
    raise exception 'Invoice % settlement mismatch (paid %, allocations %, adjusted %, adjustments %)',
      v_invoice.invoice_number, v_invoice.amount_paid, v_paid, v_invoice.amount_adjusted, v_adjusted
      using errcode = 'P0002';
  end if;
  if v_invoice.status = 'void' and v_paid <> 0 then
    raise exception 'Void invoice % still has payment allocations', v_invoice.invoice_number using errcode = 'P0002';
  end if;
  return null;
end $$;

create or replace function verify_payment_allocation() returns trigger
language plpgsql as $$
declare
  v_payment_id uuid;
  v_allocated bigint;
  v_refunded bigint;
  v_payment record;
begin
  if tg_table_name = 'payments' then
    v_payment_id := new.id;
  else
    v_payment_id := new.payment_id;
  end if;
  select * into v_payment from payments where id = v_payment_id;
  if not found then return null; end if;
  select coalesce(sum(amount), 0) into v_allocated from payment_allocations where payment_id = v_payment_id and reversed_at is null;
  select coalesce(sum(amount), 0) into v_refunded from refunds where payment_id = v_payment_id;
  if v_allocated <> v_payment.allocated_amount or v_refunded <> v_payment.refunded_amount then
    raise exception 'Payment % allocation mismatch (allocated %, allocations %, refunded %, refunds %)',
      v_payment.receipt_number, v_payment.allocated_amount, v_allocated, v_payment.refunded_amount, v_refunded
      using errcode = 'P0002';
  end if;
  return null;
end $$;

create constraint trigger payment_allocations_verify_invoice after insert or update on payment_allocations
  deferrable initially deferred for each row execute function verify_invoice_settlement();
create constraint trigger payment_allocations_verify_payment after insert or update on payment_allocations
  deferrable initially deferred for each row execute function verify_payment_allocation();
create constraint trigger invoices_verify_settlement after insert or update on invoices
  deferrable initially deferred for each row execute function verify_invoice_settlement();
create constraint trigger payments_verify_allocation after insert or update on payments
  deferrable initially deferred for each row execute function verify_payment_allocation();
create constraint trigger ledger_adjustments_verify_invoice after insert on ledger_adjustments
  deferrable initially deferred for each row execute function verify_invoice_settlement();
create constraint trigger refunds_verify_payment after insert on refunds
  deferrable initially deferred for each row execute function verify_payment_allocation();
