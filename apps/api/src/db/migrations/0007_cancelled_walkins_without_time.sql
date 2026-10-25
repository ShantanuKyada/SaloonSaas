-- 0007 A walk-in that is removed from the queue before it was given a time has no start or end, so the schedule check
-- must allow that for cancelled appointments too (restoring such a booking returns it to the waiting list).

alter table appointments drop constraint appointments_check;

alter table appointments
  add constraint appointments_check
  check (
    (start_at is null and end_at is null and status in ('waiting', 'cancelled'))
    or (start_at is not null and end_at is not null and end_at > start_at)
  );
