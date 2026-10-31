// Web fetch: one page through the stealth Chrome server, its main content as clean markdown.

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolDiagnostic } from "@earendil-works/pi-durable";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { type Browser, chromium } from "playwright-core";

/** The stealth Chrome server's WebSocket endpoint: `KEY_BROWSER_ENDPOINT`, else mine-browser's default. */
const browserEndpoint = (): string => process.env.KEY_BROWSER_ENDPOINT ?? "ws://127.0.0.1:9222";

/** Playwright's connect() has no timeout by default. */
const CONNECT_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 60_000;

/** The harness's own bounds on a tool result; over either, the whole markdown spills to a file. */
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

/** Lines counted as the harness's bounds count them. */
function overLimits(text: string): boolean {
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return new TextEncoder().encode(text).length > MAX_BYTES || lines > MAX_LINES;
}

/** The whole markdown in a temp file, for the diagnostic to name. */
async function spill(markdown: string): Promise<string> {
  const path = join(tmpdir(), `key-web-${randomBytes(8).toString("hex")}.md`);
  await writeFile(path, markdown, "utf8");
  return path;
}

async function connect(): Promise<Browser> {
  const endpoint = browserEndpoint();
  try {
    return await chromium.connect(endpoint, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach the browser server at ${endpoint} (${message}); ` +
        "start it with `systemctl --user start mine-browser.service`",
    );
  }
}

export const Fetch = defineExtension({
  name: "fetch",
  tools: [
    defineTool({
      name: "web_fetch",
      description:
        `Fetch a webpage and return its main readable content as clean markdown. Renders pages with a ` +
        `stealth-patched Chrome server to handle JavaScript-rendered pages. Output is truncated to ` +
        `${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first); when truncated, the full content ` +
        "is saved to a temp file, which read can page through.",
      parameters: Type.Object({
        url: Type.String({ description: "URL of the webpage to fetch" }),
      }),
      // A read-only render: a rerun after a crash only fetches again.
      replay: "safe",
      execute: async ({ url }, _call, context) => {
        const browser = await connect();
        // Patchright recommends the host display's native viewport for stealth.
        const page = await browser.newPage({ viewport: null });
        // Closing the page is what interrupts phases of the fetch a goto signal does not cover.
        const onAbort = () => {
          void page.close().catch(() => {});
        };
        context.abortSignal?.addEventListener("abort", onAbort);
        try {
          await page.goto(url, {
            waitUntil: "load",
            timeout: NAVIGATION_TIMEOUT_MS,
            signal: context.abortSignal,
          });
          const { document } = parseHTML(await page.content());
          const markdown = (await Defuddle(document, url, { markdown: true })).content;
          const diagnostics: ToolDiagnostic[] = overLimits(markdown)
            ? [
                {
                  severity: "info",
                  code: "full_output",
                  message: `Full output: ${await spill(markdown)}`,
                },
              ]
            : [];
          return { output: [{ type: "text", text: markdown }], diagnostics };
        } finally {
          context.abortSignal?.removeEventListener("abort", onAbort);
          await page.close().catch(() => {});
          // The connection only; the server keeps serving.
          await browser.close().catch(() => {});
        }
      },
    }),
  ],
});
