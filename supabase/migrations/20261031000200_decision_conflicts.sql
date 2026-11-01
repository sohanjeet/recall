-- Phase 3: cross-meeting decision memory and conflict detection.

-- Full-text index used to retrieve a bounded set of related earlier decisions instead of scanning history.
alter table decisions add column search tsvector
  generated always as (to_tsvector('english', summary || ' ' || coalesce(rationale, ''))) stored;
create index decisions_search_idx on decisions using gin (search) where status = 'active';

-- decision_id is the newly extracted decision; conflicting_decision_id is the earlier approved one.
-- Neither decision is modified when a conflict is recorded: resolution is a human step.
alter table decision_conflicts
  add column meeting_id uuid references meetings(id) on delete cascade,
  add column kind text not null default 'other'
    check (kind in ('deadline', 'ownership', 'scope', 'budget', 'cancellation', 'other')),
  add column relation text not null default 'contradicts'
    check (relation in ('contradicts', 'changes')),
  -- 'uncertain': hedged or possibly unrelated statements that a person must confirm before anything is treated as changed.
  add column certainty text not null default 'clear'
    check (certainty in ('clear', 'uncertain')),
  add column previous_value text,
  add column new_value text,
  add column evidence_quote text,
  add column evidence_segment_id uuid references transcript_segments(id) on delete set null;
create index decision_conflicts_meeting_idx on decision_conflicts (meeting_id);
create index decision_conflicts_conflicting_idx on decision_conflicts (conflicting_decision_id);

-- Conflict checking runs after extraction is saved, so a failed check never loses the extraction.
alter table meetings
  add column conflict_check_status text check (conflict_check_status in ('done', 'failed')),
  add column conflict_check_error text,
  add column conflict_checked_at timestamptz;
