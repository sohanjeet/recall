// Domain types shared by the API and the web client.
// Enum value lists mirror the CHECK constraints in supabase/migrations.

export const MEETING_SOURCES = ["paste", "dictation", "upload"] as const;
export type MeetingSource = (typeof MEETING_SOURCES)[number];

export const MEETING_STATUSES = ["ingested", "extracting", "extracted", "failed"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** Extracted decisions start as `proposed`; approval makes them `active`, rejection `rejected`. */
export const DECISION_STATUSES = ["proposed", "active", "superseded", "reversed", "rejected"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** proposed → (approved | rejected); approved → synced once pushed to the tracker. */
export const TASK_STATUSES = ["proposed", "approved", "rejected", "synced", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CONFLICT_RESOLUTIONS = ["open", "kept_new", "kept_old", "dismissed"] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

export const CONFLICT_KINDS = ["deadline", "ownership", "scope", "budget", "cancellation", "other"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/** `changes`: the new decision explicitly revises the earlier one. `contradicts`: both cannot hold. */
export const CONFLICT_RELATIONS = ["contradicts", "changes"] as const;
export type ConflictRelation = (typeof CONFLICT_RELATIONS)[number];

/** `uncertain`: hedged or possibly unrelated; a person must confirm it is a real conflict. */
export const CONFLICT_CERTAINTIES = ["clear", "uncertain"] as const;
export type ConflictCertainty = (typeof CONFLICT_CERTAINTIES)[number];

export const CONFLICT_CHECK_STATUSES = ["done", "failed"] as const;
export type ConflictCheckStatus = (typeof CONFLICT_CHECK_STATUSES)[number];

/** Sync state of an approved task that has no external issue yet. A synced task has status `synced`. */
export const TASK_SYNC_STATUSES = ["syncing", "failed"] as const;
export type TaskSyncStatus = (typeof TASK_SYNC_STATUSES)[number];

/** keep_old: the earlier decision stays, the new draft is rejected. accept_new: the new draft supersedes the earlier one. */
export const CONFLICT_ACTIONS = ["keep_old", "accept_new", "dismiss"] as const;
export type ConflictAction = (typeof CONFLICT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = ["decision", "task", "conflict"] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const TASK_PROVIDERS = ["linear"] as const;
export type TaskProvider = (typeof TASK_PROVIDERS)[number];

export type Uuid = string;
/** ISO 8601 timestamp. */
export type IsoDateTime = string;
/** YYYY-MM-DD. */
export type IsoDate = string;

export interface Person {
  id: Uuid;
  name: string;
  email: string | null;
  createdAt: IsoDateTime;
}

export interface Meeting {
  id: Uuid;
  title: string;
  occurredAt: IsoDateTime;
  source: MeetingSource;
  rawTranscript: string;
  status: MeetingStatus;
  participants: string[];
  error: string | null;
  createdAt: IsoDateTime;
}

export interface TranscriptSegment {
  id: Uuid;
  meetingId: Uuid;
  seq: number;
  speakerLabel: string;
  personId: Uuid | null;
  text: string;
}

export interface Evidence {
  id: Uuid;
  segmentId: Uuid | null;
  quote: string;
}

export interface Decision {
  id: Uuid;
  meetingId: Uuid;
  summary: string;
  rationale: string | null;
  status: DecisionStatus;
  supersededBy: Uuid | null;
  approvedAt: IsoDateTime | null;
  rejectedAt: IsoDateTime | null;
  /** Bumped on every change; edits must quote the version they were made against. */
  version: number;
  evidence: Evidence[];
  createdAt: IsoDateTime;
}

export interface Task {
  id: Uuid;
  meetingId: Uuid;
  title: string;
  description: string | null;
  ownerPersonId: Uuid | null;
  /** Owner as stated in the meeting; may not match any known person. */
  ownerName: string | null;
  dueDate: IsoDate | null;
  /** The deadline wording from the meeting, e.g. "by next Friday". */
  duePhrase: string | null;
  status: TaskStatus;
  approvedAt: IsoDateTime | null;
  rejectedAt: IsoDateTime | null;
  version: number;
  /** Set while a Linear sync is running or after one failed; null otherwise. */
  syncStatus: TaskSyncStatus | null;
  syncError: string | null;
  syncAttempts: number;
  externalProvider: TaskProvider | null;
  externalId: string | null;
  externalUrl: string | null;
  evidence: Evidence[];
  createdAt: IsoDateTime;
}

export interface DecisionConflict {
  id: Uuid;
  /** The newly extracted decision. */
  decisionId: Uuid;
  /** The earlier approved decision it conflicts with; never modified by conflict detection. */
  conflictingDecisionId: Uuid;
  meetingId: Uuid;
  kind: ConflictKind;
  relation: ConflictRelation;
  certainty: ConflictCertainty;
  explanation: string;
  /** e.g. "Nov 15" → "Nov 22", when the model could name the changed value. */
  previousValue: string | null;
  newValue: string | null;
  /** Verified quote from this meeting's transcript supporting the conflict. */
  evidenceQuote: string | null;
  resolution: ConflictResolution;
  resolvedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

/** A conflict with both sides included, for old-vs-new display. */
export interface MeetingConflict extends DecisionConflict {
  decision: { id: Uuid; summary: string; evidence: Evidence[] };
  previousDecision: {
    id: Uuid;
    summary: string;
    rationale: string | null;
    status: DecisionStatus;
    meetingId: Uuid;
    meetingTitle: string;
    meetingOccurredAt: IsoDateTime;
    evidence: Evidence[];
  };
}

export interface AuditEvent {
  id: string;
  entityType: AuditEntityType;
  entityId: Uuid;
  meetingId: Uuid | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  details: Record<string, unknown>;
  createdAt: IsoDateTime;
}

export interface ApprovalDecision extends Decision {
  meetingTitle: string;
  /** Open conflicts that still block approval (certain ones) or need a look (uncertain ones). */
  openConflicts: { id: Uuid; certainty: ConflictCertainty }[];
}

export interface ApprovalTask extends Task {
  meetingTitle: string;
}

export interface ApprovalsResponse {
  linearConfigured: boolean;
  /** Proposed decisions awaiting a human. */
  decisions: ApprovalDecision[];
  /** Proposed tasks awaiting a human. */
  tasks: ApprovalTask[];
  /** Open conflicts between a proposed decision and an earlier approved one. */
  conflicts: MeetingConflict[];
  /** Approved tasks not yet in Linear (pending, syncing or failed) plus the most recently synced. */
  sync: ApprovalTask[];
}

export interface EditDecisionRequest {
  summary?: string;
  rationale?: string | null;
  version: number;
}

export interface EditTaskRequest {
  title?: string;
  description?: string | null;
  ownerName?: string | null;
  dueDate?: IsoDate | null;
  version: number;
}

export interface ActionRequest {
  /**
   * @deprecated Ignored. The audit history always records the signed-in user from the verified session.
   * Still accepted so older clients do not get a 400.
   */
  actor?: string;
  /** If given, the action is refused when the record has changed since this version. */
  version?: number;
}

export interface ConflictCheck {
  /** null until the check has run for this meeting. */
  status: ConflictCheckStatus | null;
  error: string | null;
  checkedAt: IsoDateTime | null;
}

export interface MeetingConflictsResponse {
  conflictCheck: ConflictCheck;
  conflicts: MeetingConflict[];
}

/** Something the model could not resolve: unclear owner, vague deadline, contradictory statements. */
export interface Ambiguity {
  id: Uuid;
  meetingId: Uuid;
  description: string;
  quote: string | null;
}

export interface MeetingSummary {
  id: Uuid;
  title: string;
  occurredAt: IsoDateTime;
  source: MeetingSource;
  status: MeetingStatus;
  participants: string[];
  decisionCount: number;
  taskCount: number;
  createdAt: IsoDateTime;
}

export interface MeetingDetail extends Meeting {
  segments: TranscriptSegment[];
  decisions: Decision[];
  tasks: Task[];
  ambiguities: Ambiguity[];
  conflicts: MeetingConflict[];
  conflictCheck: ConflictCheck;
}

export interface CreateMeetingRequest {
  title: string;
  /** YYYY-MM-DD; relative dates in the transcript resolve against this. */
  occurredAt: IsoDate;
  participants: string[];
  transcript: string;
  source?: MeetingSource;
  /** Corrections: detected speaker label → real name. */
  speakerMap?: Record<string, string>;
}

export type ServiceState = "ok" | "down" | "unconfigured";

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
  services: {
    database: ServiceState;
    groq: ServiceState;
    taskTracker: ServiceState;
    email: ServiceState;
  };
}

export interface ApiError {
  error: string;
  /** Machine-readable reason for auth and rate-limit failures, e.g. "session_expired". */
  code?: string;
  details?: unknown;
}

// ---- Auth ----

/** The signed-in user, from a verified Supabase access token. */
export interface SessionUser {
  id: Uuid;
  email: string;
}

/** Public sign-in configuration for the browser. The anon key is public by design; no secrets are included. */
export type AuthConfig =
  | { enabled: true; supabaseUrl: string; supabaseAnonKey: string }
  | { enabled: false };

// ---- Transcript parsing (shared so the form preview matches what the server stores) ----

export const UNLABELLED_SPEAKER = "Unlabelled";

export interface ParsedSegment {
  speakerLabel: string;
  text: string;
}

// "Sam: text", "[10:32] Sam K.: text", "(00:01:05) Sam: text". The colon must be followed by a space so "10:30" is not a label.
const SPEAKER_LINE = /^\s*(?:[[(]?\d{1,2}:\d{2}(?::\d{2})?[\])]?\s*)?(\p{L}[^:\n,;?!]{0,39}?)\s*:\s+(\S.*)$/u;

/** Splits a transcript into speaker segments. Unlabelled text (e.g. Wispr Flow dictation) becomes one segment. */
export function parseTranscript(raw: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = SPEAKER_LINE.exec(trimmed);
    const label = match?.[1]?.trim();
    if (match && label && label.split(/\s+/).length <= 4) {
      segments.push({ speakerLabel: label, text: match[2]!.trim() });
    } else if (segments.length > 0) {
      const last = segments[segments.length - 1]!;
      last.text = `${last.text} ${trimmed}`;
    } else {
      segments.push({ speakerLabel: UNLABELLED_SPEAKER, text: trimmed });
    }
  }
  return segments;
}

// ---- Phase 5: reminders and weekly digests (in-app only; nothing is emailed) ----

export const DEFAULT_REMINDER_WINDOW_HOURS = 24;
export const MAX_REMINDER_WINDOW_HOURS = 720;

/** Where generated reminders and digests are visible. `in-app`: the Recall inbox only. */
export interface DeliveryInfo {
  mode: "in-app";
  /** No email/chat provider sends reminders, so `delivered` is always false for every item. */
  externalDelivery: "not_available";
  note: string;
}

export interface TaskRef {
  taskId: Uuid;
  title: string;
  /** YYYY-MM-DD */
  dueDate: IsoDate | null;
  status: TaskStatus;
  ownerName: string | null;
  meeting: { id: Uuid; title: string; occurredAt: IsoDateTime };
  /** Linear issue link, when the task has been sent to Linear. */
  linearUrl: string | null;
}

export interface ReminderPreviewItem extends TaskRef {
  /** When the reminder becomes due: due date (00:00 UTC) minus the window. */
  remindAt: IsoDateTime;
  hoursUntilDue: number;
  /** A reminder for this task and due date already exists, so generating would not create another. */
  alreadyGenerated: boolean;
}

export interface ReminderPreview {
  windowHours: number;
  asOf: IsoDateTime;
  delivery: DeliveryInfo;
  items: ReminderPreviewItem[];
  counts: { new: number; alreadyGenerated: number };
}

export interface Reminder extends TaskRef {
  id: Uuid;
  remindAt: IsoDateTime;
  windowHours: number;
  /** When Recall generated it. */
  generatedAt: IsoDateTime;
  /** Acknowledged in the in-app inbox. */
  readAt: IsoDateTime | null;
  /** Always null unless a delivery provider sent it; generation is not delivery. */
  deliveredAt: IsoDateTime | null;
  /** The task is still open (approved/synced). False once it was completed. */
  taskOpen: boolean;
}

export interface ReminderInbox {
  delivery: DeliveryInfo;
  reminders: Reminder[];
  unread: number;
}

export interface GenerateRemindersResult {
  created: number;
  alreadyExisted: number;
  windowHours: number;
  delivery: DeliveryInfo;
}

export interface DigestTask extends TaskRef {
  /** Positive when overdue, negative when upcoming, 0 when due today. null for completed tasks. */
  daysOverdue: number | null;
  completedAt: IsoDateTime | null;
}

export interface OwnerDigest {
  /** null when the owner is unassigned or not a known person; such digests are previewed but not stored. */
  personId: Uuid | null;
  ownerName: string;
  overdue: DigestTask[];
  upcoming: DigestTask[];
  completed: DigestTask[];
}

export interface DigestPreview {
  /** Monday of the week (UTC). */
  weekStart: IsoDate;
  weekEnd: IsoDate;
  today: IsoDate;
  delivery: DeliveryInfo;
  owners: OwnerDigest[];
  totals: { overdue: number; upcoming: number; completed: number };
}

export interface StoredDigest {
  id: Uuid;
  personId: Uuid;
  ownerName: string;
  weekStart: IsoDate;
  content: Omit<OwnerDigest, "personId" | "ownerName">;
  generatedAt: IsoDateTime;
  deliveredAt: IsoDateTime | null;
}

export interface GenerateDigestsResult {
  stored: number;
  /** Owners shown in the preview that could not be stored because they are not a known person. */
  notStored: number;
  weekStart: IsoDate;
  digests: StoredDigest[];
  delivery: DeliveryInfo;
}
