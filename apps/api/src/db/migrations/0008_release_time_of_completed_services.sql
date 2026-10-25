-- 0008 Services that were finished before their planned end used to keep blocking the team member until the planned
-- end. From now on completing a service releases the unused time (see changeStatus); this brings existing rows in line.

update appointment_items ai
set blocked_until = case when a.completed_at < ai.end_at
                         then greatest(a.completed_at, ai.start_at + interval '1 minute') + ai.buffer_minutes * interval '1 minute'
                         else greatest(a.completed_at, ai.end_at) end,
    end_at = case when a.completed_at < ai.end_at then greatest(a.completed_at, ai.start_at + interval '1 minute') else ai.end_at end
from appointments a
where a.id = ai.appointment_id
  and a.status = 'completed'
  and a.completed_at is not null
  and ai.blocks_schedule
  and ai.start_at <= a.completed_at
  and ai.blocked_until > a.completed_at;

-- Visits completed before some of their later services started: those services never happened, so stop blocking time.
update appointment_items ai
set blocks_schedule = false
from appointments a
where a.id = ai.appointment_id
  and a.status = 'completed'
  and a.completed_at is not null
  and ai.blocks_schedule
  and ai.status <> 'cancelled'
  and ai.start_at > a.completed_at;
