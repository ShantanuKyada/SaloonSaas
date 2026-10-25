-- 0009 Two-step sign-in with an authenticator app (TOTP) and one-time recovery codes.
--
-- The TOTP secret is encrypted by the application (AES-256-GCM) before it is stored. A secret that has been generated but
-- not yet confirmed is kept separately so a half-finished setup never switches anything on. `totp_last_step` is the last
-- 30-second step accepted, so a code can never be used twice.

alter table users
  add column totp_secret_enc          text,
  add column totp_pending_secret_enc  text,
  add column totp_enabled_at          timestamptz,
  add column totp_last_step           bigint,
  add constraint users_totp_consistent check ((totp_enabled_at is null) = (totp_secret_enc is null));

create table user_recovery_codes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations (id),
  user_id         uuid not null references users (id) on delete cascade,
  code_hash       text not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index user_recovery_codes_user on user_recovery_codes (user_id) where used_at is null;
select app_enable_tenant_rls('user_recovery_codes');

-- Salons choose who must use two-step sign-in.
alter table organization_settings
  add column two_factor_requirement text not null default 'off'
  check (two_factor_requirement in ('off', 'owners', 'owners_and_managers'));
