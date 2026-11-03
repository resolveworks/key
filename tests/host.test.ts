import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentText,
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import type { AgentState, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Agents } from "../src/agents.ts";
import type { api } from "../src/api.ts";
import type { Stats } from "../src/footer.ts";
import { Host, type Summary } from "../src/host.ts";
import type { LoginEvent, ProviderInfo } from "../src/login.ts";
import { keySystem } from "../src/system.ts";
import { repoSlug } from "../src/worker.ts";
import { fakeGit, setGitToplevel } from "./git.ts";
import { requestText, route } from "./harness.ts";

/** In-memory storage a second Host can open again: the records outlive the Session that wrote them. */
class ReopenableStorage extends MemoryStorage {
  reopen(): this {
    (this as unknown as { closed: boolean }).closed = false;
    return this;
  }
}

/** One transcript frame: the conversation's view, and what its footer needs beyond it. */
type Transcript = {
  readonly view: ConversationView;
  readonly stats?: Stats;
  readonly contextTokens: number;
};

const allNamed = (frame: readonly Summary[], count: number): boolean =>
  frame.length === count && frame.every(({ label }) => label !== "");

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
  let cwd: string;
  let faux: ReturnType<typeof fauxProvider>;
  let app: ReturnType<typeof api>;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "key-host-"));
    setGitToplevel(cwd);
    // The fake provider serves the pair the tests set as both defaults.
    faux = fauxProvider({
      provider: "deepseek",
      models: [
        { id: "deepseek-flash", reasoning: true },
        { id: "deepseek-chat", reasoning: true },
        { id: "deepseek-plain", reasoning: false },
      ],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    models.setProvider(groqProvider());
    host = new Host({
      models,
      storage: new MemoryStorage(),
      extensions: [CodingTools, keySystem(fakeGit), Agents],
      port: 0,
      hostname: "127.0.0.1",
    });
    await host.open();
    await host.setModelDefault("conversation", {
      provider: "deepseek",
      modelId: "deepseek-flash",
    });
    await host.setModelDefault("child", {
      provider: "deepseek",
      modelId: "deepseek-flash",
    });
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

  test("new conversation paths resolve to real directories on the host", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "key-cwd-"));
    const resolveCwd = (path: string, base?: string) =>
      app.request("/api/cwd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, cwd: base }),
      });

    const relative = await resolveCwd(".", cwd);
    expect(relative.status).toBe(200);
    expect(await relative.json()).toEqual({ cwd });
    expect((await resolveCwd(join(cwd, "missing"))).status).toBe(500);

    const file = join(cwd, "file");
    writeFileSync(file, "");
    expect(await (await resolveCwd(file)).text()).toBe(`Error: not a directory: ${file}`);

    const invalidRun = await app.request("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello", cwd: join(cwd, "missing") }),
    });
    expect(invalidRun.status).toBe(500);
    expect(host.summaries).toEqual([]);
  });

  test("the host lists the configured providers' models and the two stored defaults", async () => {
    const body = (await (await app.request("/api/models")).json()) as {
      readonly defaults: unknown;
      readonly models: readonly { readonly provider: string; readonly id: string }[];
    };
    expect(body.defaults).toEqual({
      conversation: { provider: "deepseek", modelId: "deepseek-flash" },
      child: { provider: "deepseek", modelId: "deepseek-flash" },
    });
    // groq is registered but unconfigured, so none of its catalog is offered.
    expect(body.models.map(({ provider, id }) => `${provider}/${id}`)).toEqual([
      "deepseek/deepseek-flash",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-plain",
    ]);
  });

  test("the host answers the two thinking defaults, high until /thinking sets them", async () => {
    expect(await (await app.request("/api/thinking")).json()).toEqual({
      defaults: { conversation: "high", child: "high" },
    });
    expect((await setThinking("conversation", "low")).status).toBe(202);
    expect(await (await app.request("/api/thinking")).json()).toEqual({
      defaults: { conversation: "low", child: "high" },
    });
    expect((await setThinking("child", "minimal")).status).toBe(202);
    expect(await (await app.request("/api/thinking")).json()).toEqual({
      defaults: { conversation: "low", child: "minimal" },
    });
  });

  test("an unknown thinking level is rejected", async () => {
    const response = await setThinking("conversation", "loud");
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("/level");
  });

  test("the host lists the providers and the methods /login can start", async () => {
    const body = (await (await app.request("/api/providers")).json()) as readonly ProviderInfo[];
    expect(body.find((provider) => provider.id === "groq")).toMatchObject({
      id: "groq",
      name: "Groq",
      apiKey: { login: true },
    });
  });

  test("a login takes the provider's prompt and stores what it answered", async () => {
    const start = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "groq", type: "api_key" }),
    });
    expect(start.status).toBe(202);

    const stream = await app.request("/api/login");
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const frames = new Frames(stream.body as ReadableStream<Uint8Array>);
    const prompt = await frames.until<LoginEvent>((event) => event.kind === "prompt");
    if (prompt.kind !== "prompt") throw new Error("expected a login prompt");
    expect(prompt.prompt).toMatchObject({ type: "secret" });

    const answer = await app.request("/api/login/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: prompt.id, value: "gsk-test" }),
    });
    expect(answer.status).toBe(202);
    expect(await frames.until<LoginEvent>((event) => event.kind === "done")).toMatchObject({
      kind: "done",
      provider: "groq",
      type: "api_key",
    });
    await frames.close();

    const providers = (await (
      await app.request("/api/providers")
    ).json()) as readonly ProviderInfo[];
    expect(providers.find((provider) => provider.id === "groq")?.status).toMatchObject({
      type: "api_key",
      source: "stored credential",
    });

    // Configuring the provider adds its models to `/model`.
    const { models } = (await (await app.request("/api/models")).json()) as {
      readonly models: readonly { readonly provider: string; readonly id: string }[];
    };
    expect(models.map(({ provider, id }) => `${provider}/${id}`)).toContain(
      "groq/llama-3.1-8b-instant",
    );
  });

  test("the two defaults steer new conversations and their children", async () => {
    const set = (target: string, modelId: string) =>
      app.request("/api/models/defaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, provider: "deepseek", modelId }),
      });
    expect((await set("conversation", "deepseek-chat")).status).toBe(202);
    expect((await set("child", "deepseek-flash")).status).toBe(202);
    expect((await setThinking("conversation", "low")).status).toBe(202);
    expect((await setThinking("child", "minimal")).status).toBe(202);

    const answer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, turn("summed")]);
    const list = await openList();
    const kickoff = await runId("kick off");
    const heir = `Successor of conversation #${kickoff}.`;
    const listed = await list.until((frame: readonly Summary[]) => allNamed(frame, 3));
    await list.close();

    expect((await statsOf(idOf(listed, "kick off"))).agent?.model?.modelId).toBe("deepseek-chat");
    expect((await statsOf(idOf(listed, "task for a"))).agent?.model?.modelId).toBe(
      "deepseek-flash",
    );
    // The child starts on the child default; the successor continues on the conversation's.
    expect((await statsOf(idOf(listed, heir))).agent?.model?.modelId).toBe("deepseek-chat");
    expect((await statsOf(idOf(listed, "kick off"))).agent?.thinkingLevel).toBe("low");
    expect((await statsOf(idOf(listed, "task for a"))).agent?.thinkingLevel).toBe("minimal");
    expect((await statsOf(idOf(listed, heir))).agent?.thinkingLevel).toBe("low");
  });

  test("the thinking defaults are clamped to each conversation's model", async () => {
    expect((await setThinking("conversation", "xhigh")).status).toBe(202);
    expect((await setThinking("child", "xhigh")).status).toBe(202);
    await host.setModelDefault("child", { provider: "deepseek", modelId: "deepseek-plain" });

    const answer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, turn("summed")]);
    const list = await openList();
    await run("kick off");
    const listed = await list.until((frame: readonly Summary[]) => allNamed(frame, 3));
    await list.close();

    // The fake reasoning model supports high but not xhigh; the plain one supports only off.
    expect((await statsOf(idOf(listed, "kick off"))).agent?.thinkingLevel).toBe("high");
    expect((await statsOf(idOf(listed, "task for a"))).agent?.thinkingLevel).toBe("off");
  });

  test("without a conversation default a run fails loudly instead of falling back", async () => {
    const models = createModels();
    models.setProvider(faux.provider);
    const local = new Host({
      models,
      storage: new MemoryStorage(),
      extensions: [CodingTools, keySystem(fakeGit), Agents],
      port: 0,
      hostname: "127.0.0.1",
    });
    await local.open();
    const settings = (await (await local.app.request("/api/models")).json()) as {
      readonly defaults: unknown;
    };
    expect(settings.defaults).toEqual({});
    await expect(local.run(cwd, "say hello")).rejects.toThrow(
      "no conversation model default: set one with /model",
    );
    await local.close();
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

  test("an interrupted conversation stops streaming: the green dot says it", async () => {
    const hung = stuck();
    faux.setResponses([hung.step]);

    const list = await openList();
    await run("say hello");
    const [running] = await list.until((frame: readonly Summary[]) => frame.length > 0);
    await hung.reached;
    expect(running.streaming).toBe(true);

    await app.request(`/api/conversations/${running.id}/abort`, { method: "POST" });
    const after = await list.until((frame: readonly Summary[]) =>
      frame.some((item) => !item.streaming && !item.attention),
    );
    expect(after.find((item) => item.id === running.id)).toMatchObject({
      streaming: false,
      attention: false,
    });
    await list.close();
  });

  test("a restarted host lists the same conversations with their opening labels", async () => {
    // One storage across two hosts: the opening transcript entry names the cascade after restart.
    // Closing a Session closes its storage, so the second opening reopens the same in-memory one.
    const storage = new ReopenableStorage();
    const models = createModels();
    models.setProvider(faux.provider);
    const open = async () => {
      const reopened = new Host({
        models,
        storage,
        extensions: [CodingTools, keySystem(fakeGit), Agents],
        port: 0,
        hostname: "127.0.0.1",
      });
      await reopened.open();
      await reopened.setModelDefault("conversation", {
        provider: "deepseek",
        modelId: "deepseek-flash",
      });
      await reopened.setModelDefault("child", {
        provider: "deepseek",
        modelId: "deepseek-flash",
      });
      reopened.resume();
      return reopened;
    };

    faux.setResponses([fauxAssistantMessage("hello")]);
    const first = await open();
    const id = await first.run(cwd, "say hello");
    await settled(first, id);
    await first.close();
    storage.reopen();

    const second = await open();
    expect(second.summaries).toEqual([
      { id, label: "say hello", cwd: cwd, depth: 0, streaming: false, attention: true },
    ]);
    // The stop survived the restart unseen: looking at it retires the mark again.
    const watch = await second.watch(id);
    if (watch === undefined) throw new Error(`no conversation #${id}`);
    await watch.stop();
    expect(second.summaries[0]?.attention).toBe(false);
    await second.close();
  });

  test("a transcript list streams a snapshot and later changes", async () => {
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

  test("a run answers the conversation it starts, whatever the prompt's shape", async () => {
    faux.setResponses([fauxAssistantMessage("hello")]);
    const id = await startRun("say hello\nand more");
    const list = await openList();
    const listed = await list.until((frame: readonly Summary[]) => frame.length > 0);
    await list.close();
    // The run's one conversation is listed, named by the prompt's first line.
    expect(listed[0]).toMatchObject({ id, label: "say hello" });
  });

  test("a fork inherits the history to its entry and lists as its own cascade", async () => {
    const list = await openList();
    faux.setResponses([fauxAssistantMessage("hello"), fauxAssistantMessage("hello again")]);
    const source = await runId("say hello");
    await answered(source, "hello");
    await host.continue(source, "again");
    const history = await answered(source, "hello again");
    const at = history.find(({ kind }) => kind === "pi.assistant")?.id;
    if (at === undefined) throw new Error("the source answered nothing");
    const calls = faux.state.callCount;

    const forked = await app.request(`/api/conversations/${source}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ at: Number(at) }),
    });
    expect(forked.status).toBe(202);
    const { conversation: fork } = (await forked.json()) as { conversation: number };
    expect(fork).toBeGreaterThan(source);
    // Forking submits nothing: no model request, and the source keeps every entry it had.
    expect(faux.state.callCount).toBe(calls);
    expect((await host.entries(source, { order: "ascending" }, 100)).items).toEqual(history);

    // The fork is an independent cascade, listed without a prompt of its own: it is named by the
    // one it inherited, at the top level rather than beneath its source.
    const listed = await list.until((frame: readonly Summary[]) =>
      frame.some(({ id }) => id === fork),
    );
    await list.close();
    expect(listed.find(({ id }) => id === fork)).toMatchObject({
      label: "say hello",
      cwd: cwd,
      depth: 0,
      streaming: false,
    });
    expect(listed.filter(({ depth }) => depth === 0).map(({ id }) => id)).toEqual([fork, source]);

    const watch = await host.watch(fork);
    if (watch === undefined) throw new Error(`no conversation #${fork}`);
    expect(watch.value.conversation.parent).toEqual({ conversationId: source, at });
    // The history is inherited up to and including the chosen entry, and nothing past it.
    expect(watch.value.entries.map(({ id }) => Number(id))).toEqual(
      history.filter(({ id }) => Number(id) <= Number(at)).map(({ id }) => Number(id)),
    );
    await watch.stop();

    // The fork answers for itself, from the history it inherited: its own run, its own entries,
    // and the source still exactly as it was.
    let asked = "";
    faux.setResponses([
      (request) => {
        asked = requestText(request.messages);
        return fauxAssistantMessage("the fork answers");
      },
    ]);
    const message = await app.request(`/api/conversations/${fork}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "go on" }),
    });
    expect(message.status).toBe(202);
    const grown = await answered(fork, "the fork answers");
    // Its request carries the history it inherited, up to the entry it forked at and no further.
    expect(asked).toContain("say hello");
    expect(asked).not.toContain("again");
    expect(grown.filter((entry) => entry.conversationId === fork).map(({ kind }) => kind)).toEqual([
      "pi.user",
      "pi.assistant",
    ]);
    expect(grown.at(-1)?.model?.[0]).toMatchObject({
      role: "assistant",
      content: [{ text: "the fork answers" }],
    });
    expect((await host.entries(source, { order: "ascending" }, 100)).items).toEqual(history);
    expect(faux.state.callCount).toBe(calls + 1);
  });

  test("a fork of an unknown transcript is refused, and the entry id is validated", async () => {
    const unknown = await app.request("/api/conversations/999999/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ at: 3 }),
    });
    expect(unknown.status).toBe(500);
    expect(await unknown.text()).toBe("Error: no conversation #999999");

    const id = await startRun("say hello");
    const invalid = await app.request(`/api/conversations/${id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ at: "first" }),
    });
    expect(invalid.status).toBe(500);
    expect(await invalid.text()).toContain("/at");
  });

  test("a delegating kickoff lists its child beneath it", async () => {
    const answer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, turn("summed")]);
    const list = await openList();
    const id = await runId("kick off");
    const listed = await list.until((frame: readonly Summary[]) => allNamed(frame, 3));
    await list.close();

    expect(listed.map(({ label, depth }) => ({ label, depth }))).toEqual([
      { label: "kick off", depth: 0 },
      { label: "task for a", depth: 1 },
      { label: `Successor of conversation #${id}.`, depth: 1 },
    ]);
    // The child's conversation lists beneath its kickoff.
    expect(listed[1].id).toBeGreaterThan(listed[0].id);
    expect(listed[1].cwd).toBe(`${homedir()}/.key/worktrees/${repoSlug(cwd)}/a`);
  });

  test("a settled cascade leaves attention on its final heir alone", async () => {
    const answer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, turn("summed")]);
    const list = await openList();
    const id = await runId("kick off");
    const heir = `Successor of conversation #${id}.`;
    const listed = await list.until(
      (frame: readonly Summary[]) =>
        frame.length === 3 && frame.some((item) => item.label === heir && item.attention),
    );
    await list.close();

    // The parent yielded to its heir. Only the heir is left.
    expect(listed.map(({ label, attention }) => ({ label, attention }))).toEqual([
      { label: "kick off", attention: false },
      { label: "task for a", attention: false },
      { label: heir, attention: true },
    ]);
  });

  test("a run that ends without an answer needs attention", async () => {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "the model broke" }),
    ]);
    const list = await openList();
    await run("say hello");
    const listed = await list.until((frame: readonly Summary[]) =>
      frame.some((item) => item.attention),
    );
    await list.close();

    expect(listed.find((item) => item.label === "say hello")).toMatchObject({
      streaming: false,
      attention: true,
    });
  });

  test("opening a transcript retires its need for attention", async () => {
    const list = await openList();
    const id = await startRun("say hello");
    await list.until((frame: readonly Summary[]) =>
      frame.some((item) => item.id === id && item.attention),
    );

    // Attaching the transcript's view is the human looking: the mark retires, in every list.
    const transcript = new Frames(
      (await app.request(`/api/conversations/${id}`)).body as ReadableStream<Uint8Array>,
    );
    await transcript.until<Transcript>(({ view }) => view.conversation.id === id);
    await transcript.close();
    const retired = await list.until((frame: readonly Summary[]) =>
      frame.some((item) => item.id === id && !item.attention),
    );
    await list.close();
    expect(retired.find((item) => item.id === id)?.attention).toBe(false);
  });

  test("a stop that lands while its transcript is open is already seen", async () => {
    const answer = held("hello");
    faux.setResponses([answer.step]);
    const list = await openList();
    const id = await runId("say hello");
    await answer.asked;

    // The human is looking when the run ends, so no flag ever lands.
    const transcript = new Frames(
      (await app.request(`/api/conversations/${id}`)).body as ReadableStream<Uint8Array>,
    );
    await transcript.until<Transcript>(({ view }) => view.conversation.id === id);
    answer.release();
    const stopped = await list.until((frame: readonly Summary[]) =>
      frame.some((item) => item.id === id && !item.streaming),
    );
    await transcript.close();
    await list.close();

    expect(stopped.find((item) => item.id === id)).toMatchObject({
      streaming: false,
      attention: false,
    });
  });

  test("a continued conversation flags again when its new run ends", async () => {
    const list = await openList();
    const id = await startRun("say hello");
    await list.until((frame: readonly Summary[]) =>
      frame.some((item) => item.id === id && item.attention),
    );
    const transcript = new Frames(
      (await app.request(`/api/conversations/${id}`)).body as ReadableStream<Uint8Array>,
    );
    await transcript.until<Transcript>(({ view }) => view.conversation.id === id);
    await transcript.close();
    await list.until((frame: readonly Summary[]) =>
      frame.some((item) => item.id === id && !item.attention),
    );

    // The run the looker starts ends as a new stop, unseen: it flags again.
    faux.setResponses([fauxAssistantMessage("hello again")]);
    const message = await app.request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "again" }),
    });
    expect(message.status).toBe(202);
    const reflagged = await list.until((frame: readonly Summary[]) =>
      frame.some((item) => item.id === id && item.attention && !item.streaming),
    );
    await list.close();
    expect(reflagged.find((item) => item.id === id)).toMatchObject({
      attention: true,
      streaming: false,
    });
  });

  test("interleaved cascades hold one block each, the newest cascade's on top", async () => {
    const child = held("a answers");
    const second: FauxResponseStep = (request) => {
      if (requestText(request.messages).includes("Successor of conversation"))
        return turn("the second summed");
      return request.messages.at(-1)?.role === "toolResult"
        ? turn("the second heir")
        : turn("the second delegates b.", ["b"]);
    };
    const first: FauxResponseStep = (request) =>
      requestText(request.messages).includes("Successor of conversation")
        ? turn("the first summed")
        : turn("the first heir");
    const answer = route(first, {
      "task for a": child.step,
      "task for b": turn("b answers"),
      "the second": second,
    });
    faux.setResponses([
      turn("the first delegates a.", ["a"]),
      answer,
      answer,
      answer,
      answer,
      answer,
      answer,
      answer,
    ]);
    const list = await openList();
    const firstRun = await runId("the first");
    await child.asked;
    const secondRun = await runId("the second");

    // The second cascade finishes while the first's child is held: its block sits on top.
    const midway = await list.until((frame: readonly Summary[]) => allNamed(frame, 5));
    expect(midway.map(({ label }) => label)).toEqual([
      "the second",
      "task for b",
      `Successor of conversation #${secondRun}.`,
      "the first",
      "task for a",
    ]);

    child.release();
    const listed = await list.until((frame: readonly Summary[]) => allNamed(frame, 6));
    await list.close();

    expect(listed.map(({ label, depth }) => ({ label, depth }))).toEqual([
      { label: "the first", depth: 0 },
      { label: "task for a", depth: 1 },
      { label: `Successor of conversation #${firstRun}.`, depth: 1 },
      { label: "the second", depth: 0 },
      { label: "task for b", depth: 1 },
      { label: `Successor of conversation #${secondRun}.`, depth: 1 },
    ]);
    // The first block leads on the strength of its newer heir, though its kickoff is the older.
    expect(listed[0].id).toBeLessThan(listed[3].id);
    expect(listed[2].id).toBeGreaterThan(listed[5].id);
  });

  test("a successor lists after its run's children, with its own children beneath it", async () => {
    const firstAnswer = route(turn("the first heir"), { "task for a": turn("a answers") });
    const secondAnswer = route(turn("the second heir"), { "task for b": turn("b answers") });
    faux.setResponses([
      turn("I delegate a.", ["a"]),
      firstAnswer,
      firstAnswer,
      turn("the successor delegates b.", ["b"]),
      secondAnswer,
      secondAnswer,
      turn("summed"),
    ]);
    const list = await openList();
    const kickoff = await runId("kick off");
    const listed = await list.until((frame: readonly Summary[]) => allNamed(frame, 5));
    await list.close();

    const heir = `Successor of conversation #${kickoff}.`;
    const heirId = listed.find((item) => item.label === heir)?.id;
    expect(heirId).toBeDefined();
    expect(listed.map(({ label, depth }) => ({ label, depth }))).toEqual([
      { label: "kick off", depth: 0 },
      { label: "task for a", depth: 1 },
      { label: heir, depth: 1 },
      { label: "task for b", depth: 2 },
      { label: `Successor of conversation #${heirId}.`, depth: 2 },
    ]);
  });

  test("a transcript streams its view and the stats the view cannot carry", async () => {
    const id = await startRun("say hello");

    const response = await app.request(`/api/conversations/${id}`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = new Frames(response.body as ReadableStream<Uint8Array>);

    // The opening frame carries the stats; later frames carry each revision the run commits:
    // the verdict is the completed one, not the user entry the run starts from.
    const { stats, contextTokens } = await frames.until<Transcript>(
      (frame) => frame.stats !== undefined,
    );
    const { view: snapshot } = await frames.until<Transcript>(
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
    expect(snapshot.docs["pi.agent"]).toMatchObject({
      model: { modelId: "deepseek-flash" },
      thinkingLevel: "high",
    });
    expect(stats?.contextWindow).toBeGreaterThan(0);
    expect(contextTokens).toBeGreaterThan(0);
    await frames.close();
  });

  test("entry pages reach the history behind Durable's bounded view window", async () => {
    const id = await startRun("first");
    await settled(host, id);
    faux.setResponses(
      Array.from({ length: 51 }, (_, index) => fauxAssistantMessage(`answer ${index}`)),
    );
    for (let index = 0; index < 51; index++) await host.continue(id, `question ${index}`);
    await settled(host, id);

    const response = await app.request(`/api/conversations/${id}`);
    const frames = new Frames(response.body as ReadableStream<Uint8Array>);
    const { view } = await frames.until<Transcript>(
      (frame) => frame.view.conversation.id === id && frame.view.entries.length === 50,
    );
    expect(view.entries.at(-1)?.model?.[0]).toMatchObject({
      role: "assistant",
      content: [{ text: "answer 50" }],
    });
    const page = async (maxEntryId: number): Promise<readonly EntryRecord[]> => {
      const response = await app.request(
        `/api/conversations/${id}/entries?maxEntryId=${maxEntryId}&order=descending&limit=50`,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { readonly items: readonly EntryRecord[] }).items;
    };
    const earlier = await page(Number(view.before));
    const oldest = earlier.at(-1);
    if (oldest === undefined) throw new Error("no entries before the window");
    const beginning = await page(Number(oldest.id) - 1);
    expect(earlier).toHaveLength(50);
    expect(beginning).toHaveLength(5);
    expect(beginning.at(-1)?.model?.[0]).toMatchObject({ role: "user", content: "first" });
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

  /** Resolve once a host's list shows the conversation stopped, needing attention. */
  async function settled(target: Host, id: number): Promise<void> {
    for (
      let i = 0;
      !target.summaries.some((item) => item.id === id && !item.streaming && item.attention);
      i++
    ) {
      if (i > 200) throw new Error("the conversation never stopped for attention");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Start a conversation from a prompt, as a client does: the prompt and its directory. */
  async function run(prompt: string): Promise<Response> {
    return app.request("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, cwd: cwd }),
    });
  }

  /** Start a conversation from a prompt, then return the id the run endpoint answered. */
  async function runId(prompt: string): Promise<number> {
    const { conversation } = (await (await run(prompt)).json()) as { conversation: number };
    return conversation;
  }

  /** Start a conversation from a prompt: the ID the run endpoint answers. */
  async function startRun(prompt: string): Promise<number> {
    faux.setResponses([fauxAssistantMessage("hello")]);
    const { conversation } = (await (await run(prompt)).json()) as { conversation: number };
    return conversation;
  }

  /** Set one target's thinking level, as `/thinking` does. */
  async function setThinking(target: string, level: string): Promise<Response> {
    return await app.request("/api/thinking", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, level }),
    });
  }

  /** One conversation's agent doc and the stats its view cannot carry, read the way the
   * transcript stream reads them. */
  async function statsOf(id: number): Promise<{
    stats: Stats;
    agent: AgentState | undefined;
  }> {
    const watch = await host.watch(id);
    if (watch === undefined) throw new Error(`no conversation #${id}`);
    const stats = await host.stats(watch.value);
    const agent = watch.value.docs["pi.agent"] as AgentState | undefined;
    await watch.stop();
    return { stats, agent };
  }

  /** The ID of the conversation a summary labels. */
  function idOf(listed: readonly Summary[], label: string): number {
    const summary = listed.find((candidate) => candidate.label === label);
    if (summary === undefined) throw new Error(`no conversation labelled ${label}`);
    return summary.id;
  }

  /** Resolve with a conversation's history once its newest answer says `text`: an answer entry
   * commits just after the run's stop, so the list alone cannot say the run is written. */
  async function answered(id: number, text: string): Promise<readonly EntryRecord[]> {
    for (let i = 0; ; i++) {
      const items = (await host.entries(id, { order: "ascending" }, 100)).items;
      const answer = items.filter(({ kind }) => kind === "pi.assistant").at(-1)?.model?.[0];
      if (answer?.role === "assistant" && contentText(answer.content).includes(text)) return items;
      if (i > 200) throw new Error(`the conversation never answered ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** One answer: the children it calls, then the text its turn ends with. */
  function turn(text: string, children: readonly string[] = []) {
    return fauxAssistantMessage(
      [
        ...children.map((name) => fauxToolCall("delegate", { name, prompt: `task for ${name}` })),
        fauxText(text),
      ],
      { stopReason: children.length === 0 ? "stop" : "toolUse" },
    );
  }

  /** A held answer: some task asks for it (`asked`, so the test knows the queue slot is taken),
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
