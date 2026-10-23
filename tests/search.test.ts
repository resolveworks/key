// Web search as the model sees it: one call, Brave's index behind a stubbed fetch. What the tool
// answers is pinned from the transcript's tool results, not from the tool's own code paths.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type ConversationId, type Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entries, keySetup, MODEL, openKey } from "./harness.ts";

const context = BACKGROUND_CONTEXT;

let opened: Harness | undefined;
let reports: unknown[] = [];

afterEach(async () => {
  await opened?.close(context);
  opened = undefined;
  vi.unstubAllGlobals();
  delete process.env.BRAVE_API_KEY;
  if (reports.length > 0) throw new Error(`harness reported failures: ${reports.join("\n")}`);
  reports = [];
});

/** One test's harness: the faux model over memory storage, scheduling on. */
async function fresh(): Promise<{ readonly faux: FauxProviderHandle; readonly harness: Harness }> {
  const setup = keySetup();
  reports = setup.reports;
  const harness = await openKey(new MemoryStorage(), setup);
  opened = harness;
  harness.resume();
  return { faux: setup.faux, harness };
}

/** Brave's answer to a search: the shape the API answers every request with. */
function braveResponse(results: readonly unknown[]): Response {
  return new Response(JSON.stringify({ web: { results } }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** One turn that searches, then the answer that reads the results. */
function searchingTurn(query: string, freshness?: string) {
  return fauxAssistantMessage(
    [fauxToolCall("web_search", { query, ...(freshness === undefined ? {} : { freshness }) })],
    { stopReason: "toolUse" },
  );
}

/** The settled tool results of a conversation's transcript, in order. */
async function toolResults(
  harness: Harness,
  conversation: ConversationId,
): Promise<readonly ToolResultMessage[]> {
  const transcript = await entries(harness, conversation);
  return transcript.flatMap((entry) =>
    entry.kind === "pi.tool-result"
      ? (entry.model ?? []).filter(
          (message): message is ToolResultMessage => message.role === "toolResult",
        )
      : [],
  );
}

/** Run one search to its end and answer the single tool result it landed. */
async function searched(faux: FauxProviderHandle, harness: Harness): Promise<ToolResultMessage> {
  faux.setResponses([searchingTurn("key release", "pw"), fauxAssistantMessage("here it is")]);
  const conversation = await harness.root(context, { agent: { model: MODEL } });
  const settled = await (
    await conversation.submit({ type: "input", content: "look up the key release" }, context)
  ).wait(context);
  if (settled.status !== "done") throw new Error(`run ended ${settled.status}`);
  const [result] = await toolResults(harness, conversation.id);
  if (result === undefined) throw new Error("no tool result in the transcript");
  return result;
}

describe("web search", () => {
  it("searches Brave and answers the results as markdown", async () => {
    process.env.BRAVE_API_KEY = "the-key";
    const fetch = vi.fn(
      async (_url: URL, _init: RequestInit): Promise<Response> =>
        braveResponse([
          {
            title: "Key 1.0",
            url: "https://key.example/1",
            description: "The first release.",
            extra_snippets: ["It cascades."],
          },
        ]),
    );
    vi.stubGlobal("fetch", fetch);
    const { faux, harness } = await fresh();

    const result = await searched(faux, harness);

    const [url, init] = fetch.mock.calls[0];
    expect(`${url.hostname}${url.pathname}`).toBe("api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("key release");
    expect(url.searchParams.get("count")).toBe("10");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(init.headers).toEqual({
      "X-Subscription-Token": "the-key",
      Accept: "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(result.isError).toBe(false);
    expect(contentText(result.content)).toBe(
      "1. **[Key 1.0](https://key.example/1)**\n   The first release.\n   > It cascades.",
    );
  });

  it("without an API key, answers an error instead of searching", async () => {
    delete process.env.BRAVE_API_KEY;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { faux, harness } = await fresh();

    const result = await searched(faux, harness);

    expect(fetch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toContain("BRAVE_API_KEY is not set");
  });

  it("a failing API answers an error result", async () => {
    process.env.BRAVE_API_KEY = "the-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    const { faux, harness } = await fresh();

    const result = await searched(faux, harness);

    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toContain("429");
    expect(contentText(result.content)).toContain("rate limited");
  });

  it("an empty index answers no results, not an error", async () => {
    process.env.BRAVE_API_KEY = "the-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => braveResponse([])),
    );
    const { faux, harness } = await fresh();

    const result = await searched(faux, harness);

    expect(result.isError).toBe(false);
    expect(contentText(result.content)).toBe('No results found for "key release".');
  });
});
