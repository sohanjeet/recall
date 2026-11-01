// Shared helpers for the real E2E specs. Credentials come only from loadRealE2E(); the session lives in the page's
// own localStorage for the life of one test run and is never written to disk (no storageState, traces or videos).
import { expect, type Page, type TestType } from "@playwright/test";
import { loadRealE2E, type RealE2E } from "./config";

export type Ready = Extract<RealE2E, { mode: "ready" }>;

/** The ready configuration, or null when the suite is disabled (specs then skip with `skipReason`). */
export function readyConfig(): Ready | null {
  const real = loadRealE2E();
  return real.mode === "ready" ? real : null;
}

export function skipReason(): string {
  const real = loadRealE2E();
  return real.mode === "disabled" ? real.reason : "";
}

/** Call at the top of a describe block: skips every test in it, with a visible reason, unless the suite is enabled. */
export function skipUnlessReal(test: TestType<any, any>) {
  test.skip(readyConfig() === null, skipReason());
}

export async function signIn(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Meetings", level: 1 })).toBeVisible();
}

async function accessToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem("recall.auth");
    return raw ? (JSON.parse(raw) as { access_token?: string }).access_token ?? null : null;
  });
  if (!token) throw new Error("No signed-in session in the page");
  return token;
}

/** Calls the real API through the web app's proxy as the signed-in user. Throws with the server's message on failure. */
export async function api<T>(page: Page, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken(page)}`, "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Same normalisation the server uses to verify quotes: case, punctuation and whitespace are ignored. */
export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A letters-only token unique to this run, so full-text conflict search only ever sees this run's decisions. */
export function runToken(prefix = "Kestrel"): string {
  const letters = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
  return `${prefix}${letters}`;
}

export async function createMeetingViaUi(page: Page, m: { title: string; date: string; participants: string; transcript: string }) {
  await page.goto("/meetings/new");
  await page.getByLabel("Title").fill(m.title);
  await page.getByLabel("Meeting date").fill(m.date);
  await page.getByLabel("Participants").fill(m.participants);
  await page.locator("#transcript-input").fill(m.transcript);
  await page.getByRole("button", { name: "Save and analyze" }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop()!;
}
