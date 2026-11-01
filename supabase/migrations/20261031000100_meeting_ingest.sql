-- Phase 2: meeting ingestion and AI extraction drafts.

alter table meetings add column participants text[] not null default '{}';

-- Extracted decisions start as drafts ('proposed') until a person approves them.
alter table decisions drop constraint decisions_status_check;
alter table decisions add constraint decisions_status_check
  check (status in ('proposed', 'active', 'superseded', 'reversed'));

-- Owner exactly as stated in the meeting; owner_person_id is set only when it matches a known person.
alter table tasks add column owner_name text;
alter table tasks add column due_phrase text;

-- Things the model could not resolve (unclear owner, vague deadline, conflicting statements).
create table ambiguities (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references meetings(id) on delete cascade,
  description  text not null,
  quote        text,
  created_at   timestamptz not null default now()
);
create index ambiguities_meeting_idx on ambiguities (meeting_id);
alter table ambiguities enable row level security;
