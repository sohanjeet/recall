import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { GroqClient, GroqError } from "./groq.js";

const schema = z.object({ answer: z.string() });
const req = { name: "t", schema, system: "s", user: "u" };

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });

function client(responses: (Response | Error)[], calls: { body?: any; auth?: string }[] = []) {
  const queue = [...responses];
  const sleeps: number[] = [];
  const c = new GroqClient({
    apiKey: "gsk_test",
    model: "m",
    baseUrl: "https://example.test/v1/",
    maxRetries: 2,
    sleep: async (ms) => void sleeps.push(ms),
    fetch: (async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(init.body as string), auth: (init.headers as any).authorization });
      const next = queue.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
  });
  return { c, sleeps, calls };
}

test("sends strict json_schema and returns validated output", async () => {
  const calls: any[] = [];
  const { c } = client([ok('{"answer":"hi"}')], calls);
  assert.deepEqual(await c.completeJson(req), { answer: "hi" });
  assert.equal(calls[0].body.response_format.type, "json_schema");
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.equal(calls[0].body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(calls[0].auth, "Bearer gsk_test");
});

test("retries 429 honouring retry-after", async () => {
  const { c, sleeps } = client([
    new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
    ok('{"answer":"x"}'),
  ]);
  assert.deepEqual(await c.completeJson(req), { answer: "x" });
  assert.deepEqual(sleeps, [2000]);
});

test("gives up with rate_limited after retries", async () => {
  const { c } = client([429, 429, 429].map(() => new Response("no", { status: 429 })));
  await assert.rejects(c.completeJson(req), (e: GroqError) => e.code === "rate_limited");
});

test("does not retry 401", async () => {
  const { c, calls } = client([new Response("bad key", { status: 401 })]);
  await assert.rejects(c.completeJson(req), (e: GroqError) => e.code === "api_error" && e.status === 401);
  assert.equal(calls.length, 1);
});

test("maps timeouts", async () => {
  const t = Object.assign(new Error("t"), { name: "TimeoutError" });
  const { c } = client([t, t, t]);
  await assert.rejects(c.completeJson(req), (e: GroqError) => e.code === "timeout");
});

test("retries malformed JSON once, then fails", async () => {
  const { c, calls } = client([ok("not json"), ok("still not")]);
  await assert.rejects(c.completeJson(req), (e: GroqError) => e.code === "malformed_response");
  assert.equal(calls.length, 2);
});

test("recovers when second attempt validates", async () => {
  const { c } = client([ok('{"wrong":1}'), ok('{"answer":"ok"}')]);
  assert.deepEqual(await c.completeJson(req), { answer: "ok" });
});

test("reports validation_failed", async () => {
  const { c } = client([ok('{"wrong":1}'), ok('{"wrong":2}')]);
  await assert.rejects(c.completeJson(req), (e: GroqError) => e.code === "validation_failed");
});

test("error messages never contain the api key", async () => {
  const { c } = client([new Response("nope", { status: 400 })]);
  await assert.rejects(c.completeJson(req), (e: GroqError) => !e.message.includes("gsk_test"));
});
