-- 0014 Features the platform switches off for a salon (FEATURES in packages/shared/src/features.ts).
-- A switched-off feature's permissions are taken away from every role in that salon when sessions load, so its
-- screens and API close for everyone; the list is validated by the API, empty means everything is on.

alter table organizations add column disabled_features text[] not null default '{}';
