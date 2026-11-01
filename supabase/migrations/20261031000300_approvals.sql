-- Phase 4: human approvals, conflict resolution, Linear sync state and immutable audit history.

-- ---------- decisions ----------
alter table decisions drop constraint decisions_status_check;
alter table decisions add constraint decisions_status_check
  check (status in ('proposed', 'active', 'superseded', 'reversed', 'rejected'));

alter table decisions
  add column approved_at  timestamptz,
  add column approved_by  text,
  add column rejected_at  timestamptz,
  add column rejected_by  text,
  -- Bumped on every change so an edit made against stale content is refused.
  add column version      integer not null default 1;

-- Decisions approved before approval tracking existed have no recorded approval time.
update decisions set approved_at = created_at, approved_by = 'unknown (before approval tracking)'
  where status in ('active', 'superseded', 'reversed') and approved_at is null;

alter table decisions add constraint decisions_approved_has_timestamp
  check (status not in ('active', 'superseded', 'reversed') or approved_at is not null);
alter table decisions add constraint decisions_rejected_has_timestamp
  check (status <> 'rejected' or rejected_at is not null);

-- Once a decision leaves 'proposed' its wording is history and can no longer be edited.
create function decisions_freeze_content() returns trigger language plpgsql as $$
begin
  if old.status <> 'proposed' and (new.summary is distinct from old.summary or new.rationale is distinct from old.rationale) then
    raise exception 'decision % is % and its content is immutable', old.id, old.status using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger decisions_freeze_content before update on decisions
  for each row execute function decisions_freeze_content();

-- ---------- tasks ----------
alter table tasks
  add column rejected_at        timestamptz,
  add column rejected_by        text,
  add column version            integer not null default 1,
  -- null: no sync in flight or failed. A synced task has status 'synced' and its external id.
  add column sync_status        text check (sync_status in ('syncing', 'failed')),
  add column sync_error         text,
  add column sync_attempts      integer not null default 0,
  add column sync_attempted_at  timestamptz;

alter table tasks add constraint tasks_rejected_has_timestamp
  check (status <> 'rejected' or rejected_at is not null);
alter table tasks add constraint tasks_synced_has_external_id
  check (status <> 'synced' or (external_id is not null and external_url is not null));

-- ---------- conflicts ----------
alter table decision_conflicts add column resolved_by text;
alter table decision_conflicts add constraint decision_conflicts_resolved_consistent
  check ((resolution = 'open') = (resolved_at is null));

-- ---------- audit history ----------
create table audit_events (
  id           bigint generated always as identity primary key,
  entity_type  text not null check (entity_type in ('decision', 'task', 'conflict')),
  entity_id    uuid not null,
  meeting_id   uuid,
  action       text not null,
  from_status  text,
  to_status    text,
  actor        text not null,
  details      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index audit_events_entity_idx on audit_events (entity_type, entity_id, id);
create index audit_events_meeting_idx on audit_events (meeting_id, id);

-- Append-only: history is never rewritten, not even by the API role.
create function audit_events_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only' using errcode = 'insufficient_privilege';
end $$;
create trigger audit_events_no_update before update or delete on audit_events
  for each row execute function audit_events_immutable();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function audit_events_immutable();

alter table audit_events enable row level security;
