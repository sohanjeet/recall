-- Recall initial schema.
-- Compatible with `supabase db push` and with `pnpm db:migrate` (which tracks applied files in schema_migrations).

create extension if not exists pgcrypto;

create table people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text unique,
  created_at  timestamptz not null default now()
);
create unique index people_name_lower_idx on people (lower(name));

-- Maps transcript speaker labels ("Speaker 2", "sam", "Sam K.") to a person across meetings.
create table speaker_aliases (
  alias       text primary key,
  person_id   uuid not null references people(id) on delete cascade
);

create table meetings (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  occurred_at     timestamptz not null default now(),
  source          text not null check (source in ('paste', 'dictation', 'upload')),
  raw_transcript  text not null,
  status          text not null default 'ingested'
                    check (status in ('ingested', 'extracting', 'extracted', 'failed')),
  error           text,
  created_at      timestamptz not null default now()
);
create index meetings_occurred_at_idx on meetings (occurred_at desc);

create table transcript_segments (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references meetings(id) on delete cascade,
  seq            integer not null,
  speaker_label  text not null,
  person_id      uuid references people(id) on delete set null,
  text           text not null,
  unique (meeting_id, seq)
);

create table decisions (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references meetings(id) on delete cascade,
  summary        text not null,
  rationale      text,
  status         text not null default 'active'
                   check (status in ('active', 'superseded', 'reversed')),
  superseded_by  uuid references decisions(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index decisions_status_idx on decisions (status, created_at desc);

create table tasks (
  id                 uuid primary key default gen_random_uuid(),
  meeting_id         uuid not null references meetings(id) on delete cascade,
  title              text not null,
  description        text,
  owner_person_id    uuid references people(id) on delete set null,
  due_date           date,
  status             text not null default 'proposed'
                       check (status in ('proposed', 'approved', 'rejected', 'synced', 'done')),
  approved_at        timestamptz,
  approved_by        text,
  external_provider  text check (external_provider in ('linear')),
  external_id        text,
  external_url       text,
  created_at         timestamptz not null default now(),
  -- Approval gate enforced in the database: nothing reaches a tracker unapproved.
  constraint tasks_external_requires_approval
    check (external_id is null or approved_at is not null),
  constraint tasks_approved_status_has_timestamp
    check (status not in ('approved', 'synced') or approved_at is not null),
  unique (external_provider, external_id)
);
create index tasks_owner_idx on tasks (owner_person_id, status);
create index tasks_due_idx on tasks (due_date) where status in ('approved', 'synced');

-- Transcript quotes backing an extracted decision or task.
create table evidence (
  id           uuid primary key default gen_random_uuid(),
  segment_id   uuid references transcript_segments(id) on delete set null,
  decision_id  uuid references decisions(id) on delete cascade,
  task_id      uuid references tasks(id) on delete cascade,
  quote        text not null,
  constraint evidence_single_target
    check ((decision_id is null) <> (task_id is null))
);
create index evidence_decision_idx on evidence (decision_id);
create index evidence_task_idx on evidence (task_id);

create table decision_conflicts (
  id                       uuid primary key default gen_random_uuid(),
  decision_id              uuid not null references decisions(id) on delete cascade,
  conflicting_decision_id  uuid not null references decisions(id) on delete cascade,
  explanation              text not null,
  resolution               text not null default 'open'
                             check (resolution in ('open', 'kept_new', 'kept_old', 'dismissed')),
  resolved_at              timestamptz,
  created_at               timestamptz not null default now(),
  check (decision_id <> conflicting_decision_id),
  unique (decision_id, conflicting_decision_id)
);

create table reminders (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  remind_at  timestamptz not null,
  sent_at    timestamptz,
  error      text,
  created_at timestamptz not null default now()
);
create index reminders_due_idx on reminders (remind_at) where sent_at is null;

create table digests (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references people(id) on delete cascade,
  week_start  date not null,
  content     jsonb not null,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (person_id, week_start)
);

-- The API connects with a server-side Postgres role; keep these tables off the public Data API.
alter table people              enable row level security;
alter table speaker_aliases     enable row level security;
alter table meetings            enable row level security;
alter table transcript_segments enable row level security;
alter table decisions           enable row level security;
alter table tasks               enable row level security;
alter table evidence            enable row level security;
alter table decision_conflicts  enable row level security;
alter table reminders           enable row level security;
alter table digests             enable row level security;
