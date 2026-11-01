-- Phase 5: in-app reminders and weekly digests.
-- Nothing here sends anything outside Recall. `sent_at` is reserved for a real delivery provider and the
-- database refuses it unless a human approved sending.

-- ---------- tasks: completion ----------
alter table tasks add column completed_at timestamptz;
update tasks set completed_at = coalesce(approved_at, created_at) where status = 'done' and completed_at is null;
alter table tasks add constraint tasks_done_has_timestamp
  check (status <> 'done' or completed_at is not null);

-- ---------- reminders ----------
alter table reminders
  add column due_date          date,
  add column window_hours      integer not null default 24 check (window_hours between 1 and 720),
  -- In-app inbox state: when a person acknowledged it. Unrelated to external delivery.
  add column read_at           timestamptz,
  add column send_approved_at  timestamptz,
  add column send_approved_by  text;
update reminders r set due_date = (select due_date from tasks t where t.id = r.task_id) where due_date is null;
delete from reminders where due_date is null;
alter table reminders alter column due_date set not null;

-- One reminder per task per due date: re-running generation is idempotent, while moving the deadline allows a new one.
alter table reminders add constraint reminders_task_due_unique unique (task_id, due_date);
-- External delivery is a human-gated action.
alter table reminders add constraint reminders_send_requires_approval
  check (sent_at is null or send_approved_at is not null);

-- Reminders may only be created for approved (or synced) tasks that have a due date.
create function reminders_require_open_task() returns trigger language plpgsql as $$
declare t_status text; t_due date;
begin
  select status, due_date into t_status, t_due from tasks where id = new.task_id;
  if t_status is null or t_status not in ('approved', 'synced') then
    raise exception 'reminders can only be created for approved tasks (task % is %)', new.task_id, coalesce(t_status, 'missing')
      using errcode = 'check_violation';
  end if;
  if t_due is distinct from new.due_date then
    raise exception 'reminder due date does not match the task due date' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger reminders_require_open_task before insert on reminders
  for each row execute function reminders_require_open_task();

create index reminders_inbox_idx on reminders (read_at, due_date);

-- ---------- digests ----------
alter table digests
  add column updated_at        timestamptz not null default now(),
  add column send_approved_at  timestamptz,
  add column send_approved_by  text;
alter table digests add constraint digests_send_requires_approval
  check (sent_at is null or send_approved_at is not null);
