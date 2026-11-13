// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Samuel Jones

import type { Api, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { toPiModel } from "../metadata.js";
import { makeMetadataContext } from "./helpers.js";

const context: Context = {
  messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
};
const sharedKey = "test-only-shared-team-key";

function captureRequests() {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const event = request.url.endsWith("/responses")
      ? {
          type: "response.completed",
          response: {
            id: "test-response",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        }
      : {
          id: "test-completion",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
        };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  return { requests, fetchImpl };
}

function isisModel() {
  return toPiModel({ id: "qwen3.8-27b" }, makeMetadataContext());
}

describe("Pi native session affinity requests", () => {
  async function request(
    session: SessionManager,
    capture: ReturnType<typeof captureRequests>,
    options: ProviderStreamOptions = {},
    model: Model<Api> = isisModel(),
  ) {
    const result = await complete(model, context, {
      apiKey: sharedKey,
      sessionId: session.getSessionId(),
      cacheRetention: "short",
      maxTokens: 32,
      maxRetries: 0,
      fetch: capture.fetchImpl,
      ...options,
    });
    expect(result.stopReason).toBe("stop");
  }

  it("sends the conversation UUID as x-session-id without OpenAI affinity headers", async () => {
    const session = SessionManager.inMemory();
    const capture = captureRequests();
    await request(session, capture);
    expect(capture.requests).toHaveLength(1);
    const headers = capture.requests[0]?.headers;
    expect(headers?.get("x-session-id")).toBe(session.getSessionId());
    expect(headers?.has("session_id")).toBe(false);
    expect(headers?.has("x-client-request-id")).toBe(false);
    expect(headers?.has("x-session-affinity")).toBe(false);
    const body = await capture.requests[0]?.json();
    expect(body).toHaveProperty("max_tokens", 32);
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("session_id");
  });

  it("reuses one conversation ID across successive requests", async () => {
    const session = SessionManager.inMemory();
    const capture = captureRequests();
    await request(session, capture);
    await request(session, capture);
    expect(capture.requests.map((r) => r.headers.get("x-session-id"))).toEqual([
      session.getSessionId(),
      session.getSessionId(),
    ]);
  });

  it("isolates separate conversations even when both use a shared team API key", async () => {
    const first = SessionManager.inMemory();
    const second = SessionManager.inMemory();
    const capture = captureRequests();
    await request(first, capture);
    await request(second, capture);
    const ids = capture.requests.map((r) => r.headers.get("x-session-id"));
    expect(ids).toEqual([first.getSessionId(), second.getSessionId()]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids).not.toContain(sharedKey);
    expect(capture.requests[0]?.headers.get("authorization")).toBe(
      capture.requests[1]?.headers.get("authorization"),
    );
  });

  it("uses a fresh ID after Pi starts a new conversation", async () => {
    const session = SessionManager.inMemory();
    const capture = captureRequests();
    await request(session, capture);
    session.newSession();
    await request(session, capture);
    const ids = capture.requests.map((r) => r.headers.get("x-session-id"));
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]).toBe(session.getSessionId());
  });

  it("honours the per-model opt-out", async () => {
    const model = toPiModel(
      { id: "qwen3.8-27b" },
      makeMetadataContext({
        models: { "qwen3.8-27b": { compat: { sendSessionAffinityHeaders: false } } },
      }),
    );
    const capture = captureRequests();
    await request(SessionManager.inMemory(), capture, {}, model);
    expect(capture.requests[0]?.headers.has("x-session-id")).toBe(false);
  });

  it.each([{ sessionId: undefined }, { cacheRetention: "none" as const }])(
    "preserves Pi's omission of affinity headers with %j",
    async (options) => {
      const capture = captureRequests();
      await request(SessionManager.inMemory(), capture, options);
      expect(capture.requests[0]?.headers.has("x-session-id")).toBe(false);
    },
  );

  it("does not alter compatibility or headers for an unrelated provider", async () => {
    const unrelated: Model<"openai-completions"> = {
      ...isisModel(),
      provider: "unrelated-provider",
      baseUrl: "https://unrelated.example.test/v1",
      compat: { maxTokensField: "max_tokens" },
    };
    const before = structuredClone(unrelated);
    const capture = captureRequests();
    await request(SessionManager.inMemory(), capture);
    await request(SessionManager.inMemory(), capture, {}, unrelated);
    expect(capture.requests[1]?.headers.has("x-session-id")).toBe(false);
    expect(unrelated).toEqual(before);
  });

  it("verifies Responses needs only sessionAffinityFormat, without the completions switch", async () => {
    // This extension does not register Responses models. Verify Pi's distinct API contract.
    const responses: Model<"openai-responses"> = {
      ...isisModel(),
      api: "openai-responses",
      compat: { sessionAffinityFormat: "openrouter" },
    };
    const session = SessionManager.inMemory();
    const capture = captureRequests();
    await request(session, capture, {}, responses);
    expect(capture.requests[0]?.url).toBe("https://gw.example.test/v1/responses");
    expect(capture.requests[0]?.headers.get("x-session-id")).toBe(session.getSessionId());
    expect(capture.requests[0]?.headers.has("session_id")).toBe(false);
  });
});
