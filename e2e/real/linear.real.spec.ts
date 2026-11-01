// REAL, DOUBLE OPT-IN: Linear synchronisation with duplicate prevention. This CREATES REAL LINEAR ISSUES in the team
// named by LINEAR_TEAM_ID in the isolated env file. It runs only when ALL of these hold (see config.ts):
//   RECALL_REAL_E2E=1, RECALL_E2E_LINEAR=1, RECALL_E2E_LINEAR_CONFIRM=create-real-linear-issues,
//   a LINEAR_API_KEY / LINEAR_TEAM_ID in the env file that is NOT the real workspace's team.
// Issues it creates are archived again at the end (best effort); the final report lists any that remain.
import { expect, test, type Page } from "@playwright/test";
import type { MeetingDetail, Task } from "@recall/shared";
import { api, createMeetingViaUi, readyConfig, runToken, signIn, skipUnlessReal } from "./helpers";

const T = runToken("Heron");
const MARKER = (taskId: string) => `recall-task:${taskId}`;

test.describe.configure({ mode: "serial" });

test.describe("Real: Linear sync and duplicate prevention", () => {
  skipUnlessReal(test);
  const real = readyConfig();
  test.skip(real !== null && !real.linear.enabled, real && !real.linear.enabled ? real.linear.reason : "");

  let page: Page;
  let task: Task;
  const createdIssueIds = new Set<string>();

  const linearGql = async <R>(query: string, variables: Record<string, unknown>): Promise<R> => {
    if (!real?.linear.enabled) throw new Error("Linear is not enabled");
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: real.linear.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: R; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) throw new Error(`Linear: ${res.status} ${body.errors?.[0]?.message ?? ""}`);
    return body.data as R;
  };
  const issuesWithMarker = async (taskId: string) => {
    if (!real?.linear.enabled) return [];
    const data = await linearGql<{ issues: { nodes: { id: string; identifier: string; url: string }[] } }>(
      `query($teamId: ID!, $marker: String!) { issues(first: 10, filter: { team: { id: { eq: $teamId } }, description: { contains: $marker } }) { nodes { id identifier url } } }`,
      { teamId: real.linear.teamId, marker: MARKER(taskId) },
    );
    return data.issues.nodes;
  };

  test.beforeAll(async ({ browser }) => {
    if (!real?.linear.enabled) return;
    page = await (await browser.newContext()).newPage();
    await signIn(page, real.account);
  });
  test.afterAll(async () => {
    if (real?.linear.enabled) {
      for (const id of createdIssueIds) {
        await linearGql(`mutation($id: String!) { issueArchive(id: $id) { success } }`, { id }).catch(() => undefined);
      }
    }
    await page?.context().close();
  });

  test("health reports Linear as configured on the test server", async () => {
    const health = await api<{ services: { taskTracker: string } }>(page, "GET", "/health");
    expect(health.services.taskTracker).toBe("ok");
  });

  test("approving a task sends exactly one issue to Linear and records its id and URL", async () => {
    const id = await createMeetingViaUi(page, {
      title: `E2E ${T} linear`,
      date: "2027-03-01",
      participants: "Sam",
      transcript: `Sam: I will prepare the ${T} release notes by March 10, 2027.`,
    });
    await expect(page.getByRole("heading", { name: /^Tasks/ })).toBeVisible({ timeout: 120_000 });
    const meeting = await api<MeetingDetail>(page, "GET", `/meetings/${id}`);
    expect(meeting.tasks.length).toBeGreaterThan(0);
    task = meeting.tasks[0]!;

    await page.goto("/approvals");
    await page.locator("li.item", { hasText: task.title }).first().getByRole("button", { name: "Approve & send to Linear" }).click();
    await expect(page.locator("li.item", { hasText: task.title }).getByText("In Linear", { exact: true })).toBeVisible({ timeout: 60_000 });

    task = (await api<MeetingDetail>(page, "GET", `/meetings/${id}`)).tasks.find((t) => t.id === task.id)!;
    expect(task.status).toBe("synced");
    expect(task.externalProvider).toBe("linear");
    expect(task.externalId).toBeTruthy();
    expect(task.externalUrl).toMatch(/^https:\/\/linear\.app\//);

    const issues = await issuesWithMarker(task.id);
    issues.forEach((i) => createdIssueIds.add(i.id));
    expect(issues, "exactly one Linear issue carries this task's marker").toHaveLength(1);
  });

  test("syncing again, and syncing concurrently, never creates a second issue", async () => {
    const before = task.externalId;
    // A task that is already synced is returned as-is.
    const again = await api<Task>(page, "POST", `/tasks/${task.id}/sync`, {});
    expect(again.externalId).toBe(before);

    // Parallel retries (double-click, two tabs) race on the server-side claim.
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => api<Task>(page, "POST", `/tasks/${task.id}/sync`, {})));
    for (const r of results) if (r.status === "fulfilled") expect(r.value.externalId).toBe(before);

    const issues = await issuesWithMarker(task.id);
    issues.forEach((i) => createdIssueIds.add(i.id));
    expect(issues).toHaveLength(1);

    await page.goto("/approvals");
    const item = page.locator("li.item", { hasText: task.title }).first();
    await expect(item.getByRole("link", { name: "Open in Linear" })).toHaveAttribute("href", task.externalUrl!);
    await expect(item.getByRole("button", { name: /Send to Linear|Retry sync/ })).toHaveCount(0);
  });
});
