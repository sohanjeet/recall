import type {
  ApiError,
  ApprovalsResponse,
  AuditEvent,
  AuthConfig,
  ConflictAction,
  CreateMeetingRequest,
  Decision,
  DigestPreview,
  EditDecisionRequest,
  EditTaskRequest,
  GenerateDigestsResult,
  GenerateRemindersResult,
  HealthResponse,
  MeetingDetail,
  MeetingSummary,
  ReminderInbox,
  ReminderPreview,
  SessionUser,
  StoredDigest,
  Task,
} from "@recall/shared";

/** An API failure with the HTTP status (0 when the server could not be reached). */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Supplied by the AuthProvider: the current access token, a forced refresh, and what to do when the session is lost. */
export interface AuthBridge {
  getToken: () => Promise<string | null>;
  refreshToken: () => Promise<string | null>;
  onSessionLost: (reason: "expired" | "forbidden") => void;
}

let auth: AuthBridge | null = null;
export function setAuthBridge(bridge: AuthBridge | null) {
  auth = bridge;
}

const PUBLIC_PATHS = new Set(["/health", "/auth/config"]);

// Empty in development (the Vite dev server proxies /api). In production the web app and API live on different
// domains, so VITE_API_BASE_URL is the API origin (e.g. https://recall-api.onrender.com), baked in at build time.
const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "").trim().replace(/\/+$/, "");

// Requests go to API_BASE (or the same-origin dev proxy); the browser holds only its own short-lived session token.
async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const token = PUBLIC_PATHS.has(path) ? null : retried ? await auth?.refreshToken() : await auth?.getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiRequestError("Could not reach the Recall server. Check that it is running and try again.", 0);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok && !(path === "/health" && res.status === 503)) {
    const err = body as ApiError | null;
    // The server may have rejected a token that expired in flight: refresh once and retry before giving up.
    if (res.status === 401 && !retried && token) return request<T>(path, init, true);
    if (res.status === 401) auth?.onSessionLost("expired");
    if (res.status === 403 && err?.code === "forbidden") auth?.onSessionLost("forbidden");
    const message = err?.error ?? `The server returned an unexpected error (${res.status}). Try again in a moment.`;
    throw new ApiRequestError(message, res.status, err?.code);
  }
  return body as T;
}

export const api = {
  health: () => request<HealthResponse>("/health"),
  authConfig: () => request<AuthConfig>("/auth/config"),
  me: () => request<SessionUser>("/me"),
  listMeetings: () => request<MeetingSummary[]>("/meetings"),
  getMeeting: (id: string) => request<MeetingDetail>(`/meetings/${id}`),
  createMeeting: (body: CreateMeetingRequest) =>
    request<MeetingDetail>("/meetings", { method: "POST", body: JSON.stringify(body) }),
  analyzeMeeting: (id: string) => request<MeetingDetail>(`/meetings/${id}/analyze`, { method: "POST" }),
  checkConflicts: (id: string) => request<MeetingDetail>(`/meetings/${id}/conflicts/check`, { method: "POST" }),

  getApprovals: () => request<ApprovalsResponse>("/approvals"),
  getAudit: (entityType: AuditEvent["entityType"], entityId: string) =>
    request<AuditEvent[]>(`/audit?entityType=${entityType}&entityId=${entityId}`),
  // The server records the signed-in user as the actor; the client never names one.
  editDecision: (id: string, body: EditDecisionRequest) =>
    request<Decision>(`/decisions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  approveDecision: (id: string, version: number) =>
    request<Decision>(`/decisions/${id}/approve`, { method: "POST", body: JSON.stringify({ version }) }),
  rejectDecision: (id: string, version: number) =>
    request<Decision>(`/decisions/${id}/reject`, { method: "POST", body: JSON.stringify({ version }) }),
  resolveConflict: (id: string, action: ConflictAction) =>
    request<{ id: string; resolution: string }>(`/conflicts/${id}/resolve`, { method: "POST", body: JSON.stringify({ action }) }),
  editTask: (id: string, body: EditTaskRequest) => request<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  approveTask: (id: string, version: number) =>
    request<Task>(`/tasks/${id}/approve`, { method: "POST", body: JSON.stringify({ version }) }),
  rejectTask: (id: string, version: number) =>
    request<Task>(`/tasks/${id}/reject`, { method: "POST", body: JSON.stringify({ version }) }),
  syncTask: (id: string) => request<Task>(`/tasks/${id}/sync`, { method: "POST", body: "{}" }),

  getReminders: () => request<ReminderInbox>("/reminders"),
  previewReminders: (windowHours: number) => request<ReminderPreview>(`/reminders/preview?windowHours=${windowHours}`),
  generateReminders: (windowHours: number) =>
    request<GenerateRemindersResult>("/reminders/generate", { method: "POST", body: JSON.stringify({ windowHours }) }),
  markReminderRead: (id: string) => request<ReminderInbox>(`/reminders/${id}/read`, { method: "POST" }),
  previewDigest: () => request<DigestPreview>("/digests/preview"),
  getDigests: () => request<StoredDigest[]>("/digests"),
  generateDigests: () => request<GenerateDigestsResult>("/digests/generate", { method: "POST" }),
  completeTask: (id: string) => request<Task>(`/tasks/${id}/complete`, { method: "POST", body: "{}" }),
};
