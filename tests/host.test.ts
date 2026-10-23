import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Agents } from "../src/agents.ts";
import type { api } from "../src/api.ts";
import type { Stats } from "../src/footer.ts";
import { Host, type Summary } from "../src/host.ts";
import { keySystem } from "../src/system.ts";
import { fakeGit, REPO } from "./git.ts";

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
      model: () => ({ provider: "deepseek", modelId: "deepseek-flash" }),
      storage: () => new MemoryStorage(),
      extensions: [CodingTools, keySystem(fakeGit).extension, Agents],
      port: 0,
      thinkingLevel: () => "high",
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "  \n\t", cwd: "/key/repo" }),
    });
    expect(run.status).toBe(500);
    expect(await run.text()).toContain("/prompt");

    const message = await app.request("/api/conversations/1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "  \n\t" }),
    });
    expect(message.status).toBe(500);
    expect(await message.text()).toContain("/prompt");
  });

  test("a run without a cwd is rejected", async () => {
    const response = await app.request("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "say hello", cwd: "" }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("/cwd");
  });

  test("an interrupt is accepted and an unknown transcript is refused", async () => {
    const id = await startRun("say hello");
    const abort = await app.request(`/api/conversations/${id}/abort`, { method: "POST" });
    expect(abort.status).toBe(202);

    const unknown = await app.request("/api/conversations/999999/abort", { method: "POST" });
    expect(unknown.status).toBe(500);
    expect(await unknown.text()).toBe("Error: no conversation #999999");
  });

  test("an interrupt parks the conversation: the dots say it no longer streams", async () => {
    const hung = stuck();
    faux.setResponses([hung.step]);

    const list = await openList();
    await run("say hello");
    const [running] = await list.until((frame: readonly Summary[]) => frame.length > 0);
    await hung.reached;
    expect(running.running).toBe(true);

    await app.request(`/api/conversations/${running.id}/abort`, { method: "POST" });
    const parked = await list.until((frame: readonly Summary[]) =>
      frame.some((item) => !item.running),
    );
    expect(parked.find((item) => item.id === running.id)?.running).toBe(false);
    await list.close();
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

  test("a run answers the conversation its context mints, whatever the prompt's shape", async () => {
    faux.setResponses([fauxAssistantMessage("hello")]);
    const id = await startRun("say hello\nand more");
    const list = await openList();
    const listed = await list.until((frame: readonly Summary[]) => frame.length > 0);
    await list.close();
    // The holder the run's commit made is never listed; the context's conversation is, named by
    // the prompt's first line.
    expect(listed[0]).toMatchObject({ id, label: "say hello" });
  });

  test("a forking kickoff lists its child beneath it", async () => {
    faux.setResponses([
      turn("I forked a.", ["a"]),
      turn("a is on its way"),
      turn("a answers"),
      turn("summed"),
    ]);
    const list = await openList();
    await run("kick off");
    const listed = await list.until((frame: readonly Summary[]) => frame.length === 3);
    await list.close();

    expect(listed.map(({ label, depth }) => ({ label, depth }))).toEqual([
      { label: "kick off", depth: 0 },
      { label: "task for a", depth: 1 },
      { label: "a is on its way", depth: 1 },
    ]);
    // The child mints after its kickoff and lists beneath it anyway.
    expect(listed[1].id).toBeGreaterThan(listed[0].id);
    expect(listed[1].cwd).toBe(`${homedir()}/.key/worktrees/a`);
  });

  test("interleaved cascades hold one block each, the newest cascade's on top", async () => {
    const child = held("a answers");
    faux.setResponses([
      turn("the first forks a.", ["a"]),
      turn("the first heir"),
      child.step,
      turn("the second forks b.", ["b"]),
      turn("the second heir"),
      turn("b answers"),
      turn("the second summed"),
      turn("the first summed"),
    ]);
    const list = await openList();
    await run("the first");
    await child.asked;
    await run("the second");

    // The second cascade finishes while the first's child is held: its block sits on top.
    const midway = await list.until((frame: readonly Summary[]) => frame.length === 5);
    expect(midway.map(({ label }) => label)).toEqual([
      "the second",
      "task for b",
      "the second heir",
      "the first",
      "task for a",
    ]);

    child.release();
    const listed = await list.until((frame: readonly Summary[]) => frame.length === 6);
    await list.close();

    expect(listed.map(({ label, depth }) => ({ label, depth }))).toEqual([
      { label: "the first", depth: 0 },
      { label: "task for a", depth: 1 },
      { label: "the first heir", depth: 1 },
      { label: "the second", depth: 0 },
      { label: "task for b", depth: 1 },
      { label: "the second heir", depth: 1 },
    ]);
    // The first block leads on the strength of its newer heir, though its kickoff is the older.
    expect(listed[0].id).toBeLessThan(listed[3].id);
    expect(listed[2].id).toBeGreaterThan(listed[5].id);
  });

  test("a minted heir lists after the forks of its terminus, its own forks under it", async () => {
    faux.setResponses([
      turn("I fork a.", ["a"]),
      turn("the first heir"),
      turn("a answers"),
      turn("the heir forks b.", ["b"]),
      turn("the second heir"),
      turn("b answers"),
      turn("summed"),
    ]);
    const list = await openList();
    await run("kick off");
    const listed = await list.until((frame: readonly Summary[]) => frame.length === 5);
    await list.close();

    expect(listed.map(({ label, depth }) => ({ label, depth }))).toEqual([
      { label: "kick off", depth: 0 },
      { label: "task for a", depth: 1 },
      { label: "the first heir", depth: 1 },
      { label: "task for b", depth: 2 },
      { label: "the second heir", depth: 2 },
    ]);
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
    expect(stats).toMatchObject({ model: "deepseek-flash", thinkingLevel: "high" });
    expect(stats.contextWindow).toBeGreaterThan(0);
    await frames.close();
  });

  test("a prompt line completes against the host's filesystem", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "key-complete-"));
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "main.ts"), "");
    writeFileSync(join(cwd, "README.md"), "");
    const complete = (text: string, force: boolean) =>
      app.request("/api/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, text, force }),
      });

    // A forced completion (tab) lists what the directory holds; a typed path narrows it; a line
    // that names nothing answers no suggestions at all.
    expect(await (await complete("sr", true)).json()).toMatchObject({
      prefix: "sr",
      items: [{ value: "src/", label: "src/" }],
    });
    expect(await (await complete("src/", false)).json()).toMatchObject({
      prefix: "src/",
      items: [{ value: "src/main.ts", label: "main.ts" }],
    });
    expect(await (await complete("nothing", false)).json()).toBeNull();
  });

  /** The transcript list stream, as the client opens it. */
  async function openList(): Promise<Frames> {
    return new Frames((await app.request("/api/conversations")).body as ReadableStream<Uint8Array>);
  }

  /** Start a context from a prompt, as a client does: the prompt and its directory. */
  async function run(prompt: string): Promise<Response> {
    return app.request("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, cwd: REPO }),
    });
  }

  /** Start a context from a prompt: the conversation the run's answer names. */
  async function startRun(prompt: string): Promise<number> {
    faux.setResponses([fauxAssistantMessage("hello")]);
    const { conversation } = (await (await run(prompt)).json()) as { conversation: number };
    return conversation;
  }

  /** One answer: the forks it calls, then the text its turn ends with. */
  function turn(text: string, forks: readonly string[] = []) {
    return fauxAssistantMessage(
      [
        ...forks.map((name) => fauxToolCall("fork", { name, prompt: `task for ${name}` })),
        fauxText(text),
      ],
      { stopReason: forks.length === 0 ? "stop" : "toolUse" },
    );
  }

  /** A held answer: some context asks for it (`asked`, so the test knows the queue slot is taken),
   * then waits for its release. */
  function held(text: string): {
    readonly step: FauxResponseStep;
    readonly asked: Promise<void>;
    readonly release: () => void;
  } {
    let asked!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => (asked = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const step: FauxResponseStep = async () => {
      asked();
      await gate;
      return fauxAssistantMessage(text);
    };
    return { step, asked: arrived, release };
  }

  /** A faux response that never answers: the run stays mid-generation until its request is aborted. */
  function stuck(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const step: FauxResponseStep = (_context, options) =>
      new Promise((_resolve, reject) => {
        reached();
        const signal = options?.signal;
        if (signal === undefined) throw new Error("faux: the request has no abort signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    return { step, reached: arrived };
  }
});
