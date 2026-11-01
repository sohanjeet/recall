// Linear GraphQL client. Runs server-side only; the API key is never sent to the browser or written to errors/logs.

const ENDPOINT = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

export interface LinearIssue {
  id: string;
  identifier: string | null;
  url: string;
}

export interface NewIssue {
  title: string;
  description: string;
  /** YYYY-MM-DD */
  dueDate: string | null;
}

export interface LinearClient {
  /** Finds an issue in the configured team whose description contains `marker`, e.g. from an interrupted earlier attempt. */
  findIssueByMarker(marker: string): Promise<LinearIssue | null>;
  createIssue(input: NewIssue): Promise<LinearIssue>;
}

export class LinearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearError";
  }
}

const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message?: string }[];
}

export function createLinearClient(opts: {
  apiKey: string;
  teamId: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}): LinearClient {
  const { apiKey, teamId, fetchImpl = fetch, endpoint = ENDPOINT } = opts;

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        // Personal API keys are sent as-is (no "Bearer " prefix).
        headers: { "Content-Type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new LinearError(timedOut ? "Linear did not respond in time" : "Could not reach Linear");
    }

    const body = (await res.json().catch(() => null)) as GraphQLResponse<T> | null;
    if (!res.ok) {
      const detail = body?.errors?.[0]?.message;
      throw new LinearError(clip(`Linear API ${res.status}${detail ? `: ${detail}` : ""}`));
    }
    if (body?.errors?.length) throw new LinearError(clip(`Linear: ${body.errors[0]?.message ?? "request failed"}`));
    if (!body?.data) throw new LinearError("Linear returned an empty response");
    return body.data;
  }

  const toIssue = (n: { id?: string; identifier?: string | null; url?: string } | null | undefined): LinearIssue => {
    if (!n?.id || !n.url) throw new LinearError("Linear did not return an issue id and URL");
    return { id: n.id, identifier: n.identifier ?? null, url: n.url };
  };

  return {
    async findIssueByMarker(marker) {
      const data = await gql<{ issues: { nodes: { id?: string; identifier?: string; url?: string }[] } }>(
        `query RecallFindIssue($teamId: ID!, $marker: String!) {
           issues(first: 1, filter: { team: { id: { eq: $teamId } }, description: { contains: $marker } }) {
             nodes { id identifier url }
           }
         }`,
        { teamId, marker },
      );
      const node = data.issues?.nodes?.[0];
      return node ? toIssue(node) : null;
    },

    async createIssue({ title, description, dueDate }) {
      const data = await gql<{ issueCreate: { success: boolean; issue: { id?: string; identifier?: string; url?: string } | null } }>(
        `mutation RecallCreateIssue($input: IssueCreateInput!) {
           issueCreate(input: $input) { success issue { id identifier url } }
         }`,
        { input: { teamId, title, description, ...(dueDate ? { dueDate } : {}) } },
      );
      if (!data.issueCreate?.success) throw new LinearError("Linear reported that the issue was not created");
      return toIssue(data.issueCreate.issue);
    },
  };
}
