import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Agents } from "./agents.ts";
import type { api } from "./api.ts";
import type { Stats } from "./footer.ts";
import { git } from "./git.ts";
import { Host, type Summary } from "./host.ts";
import { keySystem } from "./system.ts";

/** One transcript frame: the conversation's view, and what its footer needs beyond it. */
type Transcript = { readonly view: ConversationView; readonly stats: Stats };

/** A host's SSE stream, read frame by frame with data lines joined the way the client joins them. */
class Frames {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  #buffer = "";

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  /** Resolve with the first frame a predicate accepts, waiting for chunks while it matches none. */
  async until<T>(accept: (frame: T) => boolean, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end !== -1) {
        const frame = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("");
        const parsed = JSON.parse(data) as T;
        if (accept(parsed)) return parsed;
        continue;
      }
      if (Date.now() > deadline) throw new Error("no frame matched before the timeout");
      const { value, done } = await this.#reader.read();
      if (done) throw new Error("the stream ended before a frame matched");
      this.#buffer += this.#decoder.decode(value, { stream: true });
    }
  }

  close(): Promise<void> {
    return this.#reader.cancel();
  }
}

describe("host", () => {
  let host: Host;
  let faux: ReturnType<typeof fauxProvider>;
  let app: ReturnType<typeof api>;

  beforeEach(async () => {
    // The host configures deepseek/deepseek-flash, so the faux provider serves that pair.
    faux = fauxProvider({ provider: "deepseek", models: [{ id: "deepseek-flash" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    host = new Host({
      models: () => models,
      storage: () => new MemoryStorage(),
      extensions: [CodingTools, keySystem(git), Agents],
      port: 0,
    });
    await host.open();
    host.resume();
    // In-process: `app.request()` answers without a port, exactly as `hono request` drives it.
    app = host.app;
  });

  afterEach(async () => {
    await host.close();
  });

  test("the root lists the routes", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("an unknown path is not found", async () => {
    const response = await app.request("/nothing/here");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  test("an unknown transcript is not found", async () => {
    const response = await app.request("/api/conversations/999999");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("no such conversation");
  });

  test("an empty prompt is rejected", async () => {
    const run = await app.request("/api/run", {
      method: "POST",
      body: JSON.stringify({ prompt: "  \n\t", cwd: "/key/repo" }),
    });
    expect(run.status).toBe(400);
    expect(await run.text()).toBe("empty prompt or cwd");

    const message = await app.request("/api/conversations/1/messages", {
      method: "POST",
      body: "  \n\t",
    });
    expect(message.status).toBe(400);
    expect(await message.text()).toBe("empty prompt");
  });

  test("a run without a cwd is rejected", async () => {
    const response = await app.request("/api/run", {
      method: "POST",
      body: JSON.stringify({ prompt: "say hello", cwd: "" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("empty prompt or cwd");
  });

  test("the conversation list streams a snapshot and later changes", async () => {
    const response = await app.request("/api/conversations");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = new Frames(response.body as ReadableStream<Uint8Array>);
    expect(await frames.until((frame: readonly Summary[]) => frame.length === 0)).toEqual([]);

    faux.setResponses([fauxAssistantMessage("hello")]);
    await run("say hello");

    const listed = await frames.until((frame: readonly Summary[]) => frame.length > 0);
    expect(listed.map(({ label }) => label)).toEqual(["say hello"]);
    await frames.close();
  });

  test("a transcript streams its view and the stats the view cannot carry", async () => {
    const id = await startRun("say hello");

    const response = await app.request(`/api/conversations/${id}`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = new Frames(response.body as ReadableStream<Uint8Array>);

    // The first frame is a whole view, and later frames carry each revision the run commits:
    // the verdict is the completed one, not the user entry the run starts from.
    const { view: snapshot, stats } = await frames.until<Transcript>(
      ({ view }: Transcript) =>
        view.conversation.id === id && view.entries.some((entry) => entry.kind === "pi.assistant"),
    );
    expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.system",
      "pi.assistant",
    ]);
    const answer = snapshot.entries.at(-1)?.model?.[0];
    expect(answer).toMatchObject({ role: "assistant", content: [{ text: "hello" }] });
    expect(stats).toMatchObject({ model: "deepseek-flash" });
    expect(stats.contextWindow).toBeGreaterThan(0);
    await frames.close();
  });

  /** Start a context from a prompt, as a client does: the prompt and its directory. */
  async function run(prompt: string): Promise<Response> {
    return app.request("/api/run", {
      method: "POST",
      body: JSON.stringify({ prompt, cwd: "/key/repo" }),
    });
  }

  /** Start a context from a prompt and find the conversation its task owns. */
  async function startRun(prompt: string): Promise<number> {
    faux.setResponses([fauxAssistantMessage("hello")]);
    const list = new Frames(
      (await app.request("/api/conversations")).body as ReadableStream<Uint8Array>,
    );
    await run(prompt);
    const listed = await list.until((frame: readonly Summary[]) => frame.length > 0);
    await list.close();
    return listed[0].id;
  }
});
