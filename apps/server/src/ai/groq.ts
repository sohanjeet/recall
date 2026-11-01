import { z } from "zod";

export type GroqErrorCode =
  | "rate_limited"
  | "timeout"
  | "api_error"
  | "network_error"
  | "malformed_response"
  | "validation_failed";

export class GroqError extends Error {
  constructor(
    readonly code: GroqErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GroqError";
  }
}

export interface GroqConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429/5xx/timeout/network failures. */
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface JsonCompletionRequest<S extends z.ZodType> {
  /** Used as the json_schema name; letters, digits, underscores. */
  name: string;
  schema: S;
  system: string;
  user: string;
  temperature?: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 15_000;

const ChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

export class GroqClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: GroqConfig) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.fetchFn = config.fetch ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Runs a chat completion constrained to `schema` (strict JSON-schema structured output)
   * and returns the Zod-validated result. Malformed or non-conforming output is retried once.
   */
  async completeJson<S extends z.ZodType>(req: JsonCompletionRequest<S>): Promise<z.output<S>> {
    const jsonSchema = z.toJSONSchema(req.schema, { target: "draft-7" });
    delete (jsonSchema as { $schema?: string }).$schema;

    const body = JSON.stringify({
      model: this.config.model,
      temperature: req.temperature ?? 0,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.name, strict: true, schema: jsonSchema },
      },
    });

    let lastError: GroqError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await this.requestContent(body);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(content);
      } catch {
        lastError = new GroqError("malformed_response", "Model returned invalid JSON");
        continue;
      }
      const result = req.schema.safeParse(parsedJson);
      if (result.success) return result.data;
      lastError = new GroqError(
        "validation_failed",
        `Model output failed validation: ${result.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    throw lastError!;
  }

  private async requestContent(body: string): Promise<string> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let lastError: GroqError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (res.ok) return await this.extractContent(res);

        const detail = await res.text().catch(() => "");
        const code = res.status === 429 ? "rate_limited" : "api_error";
        lastError = new GroqError(code, `Groq API ${res.status}: ${summarize(detail)}`, res.status);
        if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      } catch (err) {
        if (err instanceof GroqError) {
          if (err.code === "malformed_response" || !RETRYABLE_STATUS.has(err.status ?? 0)) throw err;
        } else if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          lastError = new GroqError("timeout", `Groq request timed out after ${this.timeoutMs}ms`);
        } else {
          lastError = new GroqError("network_error", "Could not reach the Groq API");
        }
      }

      if (attempt < this.maxRetries) {
        const backoff = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
        await this.sleep(Math.min(retryAfterMs ?? backoff, MAX_BACKOFF_MS));
      }
    }
    throw lastError!;
  }

  private async extractContent(res: Response): Promise<string> {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new GroqError("malformed_response", "Groq returned a non-JSON response");
    }
    const parsed = ChatCompletionSchema.safeParse(json);
    const choice = parsed.success ? parsed.data.choices[0] : undefined;
    if (!choice?.message.content) {
      throw new GroqError("malformed_response", "Groq response contained no message content");
    }
    if (choice.finish_reason === "length") {
      throw new GroqError("malformed_response", "Model output was truncated (finish_reason=length)");
    }
    return choice.message.content;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Keeps upstream error text short; never includes request headers or credentials. */
function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
