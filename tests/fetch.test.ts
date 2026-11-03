// Web fetch as the model sees it: one call, the stealth Chrome server behind a stubbed playwright.
// What the tool answers is pinned from the transcript's tool results, not from the tool's own code paths.

import { readFile, rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entries, keySetup, MODEL, openKey } from "./harness.ts";

const context = BACKGROUND_CONTEXT;
const PAGE_URL = "https://example.com/key";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { connect } }));

let opened: Harness | undefined;

afterEach(async () => {
  await opened?.close(context);
  opened = undefined;
  delete process.env.KEY_BROWSER_ENDPOINT;
});

/** One test's harness: the faux model over memory storage, scheduling on. */
async function fresh(): Promise<{ readonly faux: FauxProviderHandle; readonly harness: Harness }> {
  const setup = keySetup();
  const harness = await openKey(new MemoryStorage(), setup);
  opened = harness;
  harness.resume();
  return { faux: setup.faux, harness };
}

/** The fake browser server: its page renders whatever the URL it was navigated to serves. */
function browser(pages: Readonly<Record<string, string>>) {
  let at: string | undefined;
  const page = {
    goto: vi.fn(async (url: string) => {
      at = url;
    }),
    content: vi.fn(async () => {
      const html = at === undefined ? undefined : pages[at];
      if (html === undefined) throw new Error(`the fake server serves nothing at ${at}`);
      return html;
    }),
    close: vi.fn(async () => {}),
  };
  return {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
    page,
  };
}

/** Run one fetch to its end and answer the single tool result it landed, with its diagnostics. */
async function fetched(faux: FauxProviderHandle, harness: Harness) {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("web_fetch", { url: PAGE_URL })], { stopReason: "toolUse" }),
    fauxAssistantMessage("here it is"),
  ]);
  const conversation = await harness.root(context, { agent: { model: MODEL } });
  const settled = await (
    await conversation.submit({ type: "input", content: "read the key page" }, context)
  ).wait(context);
  if (settled.status !== "done") throw new Error(`run ended ${settled.status}`);
  const entry = (await entries(harness, conversation.id)).find(ToolResultEntry.is);
  const result = (entry?.model ?? []).find(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );
  if (entry === undefined || result === undefined)
    throw new Error("no tool result in the transcript");
  return { diagnostics: entry.data.diagnostics, result };
}

describe("web fetch", () => {
  it("renders a page and answers its main content as markdown", async () => {
    const server = browser({
      [PAGE_URL]: `
      <!doctype html>
      <html>
        <head><title>Key</title></head>
        <body>
          <nav><a href="/">all releases</a></nav>
          <article>
            <h1>Key 1.0</h1>
            <p>Cascades of coding agents.</p>
          </article>
        </body>
      </html>
    `,
    });
    connect.mockResolvedValue(server);
    const { faux, harness } = await fresh();

    const { result } = await fetched(faux, harness);

    expect(server.page.goto).toHaveBeenCalledWith(PAGE_URL, {
      waitUntil: "load",
      timeout: 60_000,
      signal: expect.any(AbortSignal),
    });
    expect(server.page.close).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();

    expect(result.isError).toBe(false);
    const text = contentText(result.content);
    expect(text).toContain("Key 1.0");
    expect(text).toContain("Cascades of coding agents.");
    expect(text).not.toContain("all releases");
    expect(text).not.toContain("<harness>");
  });

  it("KEY_BROWSER_ENDPOINT points the fetch at another server", async () => {
    process.env.KEY_BROWSER_ENDPOINT = "ws://127.0.0.1:9333";
    connect.mockResolvedValue(
      browser({ [PAGE_URL]: "<html><body><article><p>Hello.</p></article></body></html>" }),
    );
    const { faux, harness } = await fresh();

    await fetched(faux, harness);

    expect(connect).toHaveBeenCalledWith("ws://127.0.0.1:9333", expect.anything());
  });

  it("an unreachable browser answers an error naming the server and how to start it", async () => {
    connect.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9222"));
    const { faux, harness } = await fresh();

    const { result } = await fetched(faux, harness);

    expect(result.isError).toBe(true);
    const text = contentText(result.content);
    expect(text).toContain("ws://127.0.0.1:9222");
    expect(text).toContain("mine-browser.service");
  });

  it("a page over the output limits spills its whole content to a file read can page through", async () => {
    const paragraphs = Array.from({ length: 1200 }, (_, i) => `<p>Line ${i} of the article.</p>`);
    const server = browser({
      [PAGE_URL]: `<!doctype html><html><body><article><h1>Long</h1>${paragraphs.join("")}</article></body></html>`,
    });
    connect.mockResolvedValue(server);
    const { faux, harness } = await fresh();

    const { diagnostics, result } = await fetched(faux, harness);

    expect(result.isError).toBe(false);
    expect(contentText(result.content)).not.toContain("Line 1199 of the article.");
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["full_output", "truncated"]);
    const path = diagnostics[0].message.replace("Full output: ", "");
    const spilled = await readFile(path, "utf8");
    expect(spilled).toContain("Line 0 of the article.");
    expect(spilled).toContain("Line 1199 of the article.");
    await rm(path, { force: true });
  });
});
