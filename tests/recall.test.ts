// The bundled recall skill reads the store the host writes: a real session.sqlite, rendered by the
// shipped script from outside the harness, exactly as a sandboxed conversation runs it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, test } from "vitest";
import { keySetup, MODEL, openKey } from "./harness.ts";

const context = BACKGROUND_CONTEXT;
const script = fileURLToPath(new URL("../skills/recall/show.mjs", import.meta.url));

/** One store: the conversation the run started in, and the conversation forked from it. */
type Store = {
  readonly directory: string;
  readonly root: number;
  readonly fork: number;
  /** Entry ids of the root's own turns, and the fork's. */
  readonly rootEntries: readonly number[];
  readonly forkEntries: readonly number[];
};

let opened: Harness | undefined;
let temporary: string | undefined;

afterEach(async () => {
  await opened?.close(context);
  opened = undefined;
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

/** `node show.mjs …` with nothing but the store's directory: as a sandboxed conversation runs it. */
function recall(store: Store, ...args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], {
    env: { KEY_DATA_DIR: store.directory, TZ: "UTC" },
    encoding: "utf8",
    input: "",
  });
}

/** The rendered rows under the ancestry header, as `role text`, so a test reads the conversation. */
function dialogue(output: string): string[] {
  return output
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) =>
      line
        .replace(/^\d\d-\d\d \d\d:\d\d +\d+ +/, "")
        .replace(/\s+/g, " ")
        .trim(),
    );
}

/** A root that answers with a tool call, and a fork that inherits it and adds its own turn. */
async function store(): Promise<Store> {
  temporary = mkdtempSync(join(tmpdir(), "key-recall-"));
  const setup = keySetup();
  const harness = await openKey(
    await openNodeSqliteStorage(join(temporary, "session.sqlite")),
    setup,
  );
  opened = harness;

  const root = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd: process.cwd() } },
    context,
  );
  setup.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("read", { path: "src/sandbox.ts" }), fauxText("root thinking")],
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage("the root answer"),
  ]);
  const asked = await root.submit(
    { type: "input", content: "hello marker from the root" },
    context,
  );
  harness.resume();
  expect((await asked.wait(context)).status).toBe("done");
  const rootEntries = (await root.context(context)).entries.map((entry) => entry.id);

  // A fork inherits the chain up to its fork point, so it opens on the root's own words.
  const fork = await root.fork(
    rootEntries[rootEntries.length - 1],
    { ownership: { kind: "ownerless" } },
    context,
  );
  setup.faux.setResponses([fauxAssistantMessage("the fork answer")]);
  const followed = await fork.submit(
    { type: "input", content: "a forked marker follow-up" },
    context,
  );
  expect((await followed.wait(context)).status).toBe("done");
  // The fork's view is its whole chain; its own entries are the ones the root does not hold.
  const forkEntries = (await fork.context(context)).entries
    .map((entry) => entry.id)
    .filter((id) => !rootEntries.includes(id));

  return { directory: temporary, root: root.id, fork: fork.id, rootEntries, forkEntries };
}

describe("show.mjs", () => {
  test("--titles lists the newest conversations by opening prompt, the fork nested under its root", async () => {
    const held = await store();
    const lines = recall(held, "--titles").trimEnd().split("\n");

    expect(lines).toEqual([
      // Oldest first, so a fork prints under the conversation it came from, indented.
      `#${held.root}  hello marker from the root`,
      `#${held.fork}    hello marker from the root`,
    ]);
    expect(recall(held, "--titles", "-n", "1").trimEnd()).toBe(lines[1]);
  });

  test("a conversation renders as its fork chain: the ancestor's turns, then the fork's own", async () => {
    const held = await store();
    const shown = recall(held, String(held.fork));

    expect(shown.split("\n")[0]).toBe(
      `#${held.fork} · fork of #${held.root} at entry ${held.rootEntries.at(-1)}`,
    );
    expect(dialogue(shown)).toEqual([
      "user hello marker from the root",
      "tool read: src/sandbox.ts",
      "assistant root thinking",
      "assistant the root answer",
      "user a forked marker follow-up",
      "assistant the fork answer",
    ]);
    expect(recall(held, String(held.root)).split("\n")[0]).toBe(`#${held.root}`);
  });

  test("--full adds the tool results and the system prompt, the dialogue omits them", async () => {
    const held = await store();
    const rows = dialogue(recall(held, String(held.root), "--full"));

    expect(rows.some((row) => row.startsWith("system You are an agent operating inside key"))).toBe(
      true,
    );
    expect(rows.some((row) => row.startsWith("result read (error)"))).toBe(true);
    expect(dialogue(recall(held, String(held.root))).some((row) => row.startsWith("result"))).toBe(
      false,
    );
  });

  test("--user keeps only what the human asked", async () => {
    const held = await store();
    const rows = dialogue(recall(held, String(held.fork), "--user"));

    expect(rows).toEqual(["user hello marker from the root", "user a forked marker follow-up"]);
  });

  test("an id spec renders exactly the entries it names, inherited ones included", async () => {
    const held = await store();
    const [asked] = held.rootEntries;
    const [followed, answered] = held.forkEntries;

    expect(dialogue(recall(held, String(held.fork), `${asked},${answered}`))).toEqual([
      "user hello marker from the root",
      "assistant the fork answer",
    ]);
    expect(dialogue(recall(held, String(held.fork), `${followed}`))).toEqual([
      "user a forked marker follow-up",
    ]);
    // A range names every id in it, and a named entry renders losslessly: the prompt and tool results too.
    const range = dialogue(recall(held, String(held.root), `${asked}-${followed}`));
    expect(range.map((row) => row.split(" ")[0])).toEqual([
      "user",
      "system",
      "tool",
      "assistant",
      "result",
      "assistant",
    ]);
    expect(range.at(-1)).toBe("assistant the root answer");
  });

  test("search ranks conversations by hits and its rows pipe back into a conversation's ids", async () => {
    const held = await store();
    const both = recall(held, "search", "marker", "answer").trimEnd().split("\n");

    const forkLine = both.find((line) => line.startsWith(`#${held.fork}  `)) as string;
    expect(forkLine).toBe(`#${held.fork}  hello marker from the root  2 hits  marker 1, answer 1`);
    expect(both.filter((line) => line.startsWith("#"))).toHaveLength(2);

    const found = recall(held, "search", "forked");
    expect(dialogue(found)).toEqual(["user a forked marker follow-up"]);
    expect(found.split("\n")[0]).toContain(
      `#${held.fork}  hello marker from the root  1 hit  forked 1`,
    );
    expect(recall(held, "search", "not-a-word-anywhere")).toBe("no hits for not-a-word-anywhere\n");
    // A term is literal text, case aside: `_` and `%` reach no further than the stored words.
    expect(recall(held, "search", "HELLO")).toContain(`#${held.root}`);
    expect(recall(held, "search", "hel_o")).toBe("no hits for hel_o\n");

    // `show <conversation> -` reads the ids out of piped rows, keeping the ones this chain holds.
    const fed = execFileSync(process.execPath, [script, String(held.fork), "-"], {
      env: { KEY_DATA_DIR: held.directory, TZ: "UTC" },
      encoding: "utf8",
      input: both.join("\n"),
    });
    expect(dialogue(fed)).toEqual([
      "user hello marker from the root",
      "assistant the root answer",
      "user a forked marker follow-up",
      "assistant the fork answer",
    ]);
  });

  test("fails loudly when the store is not where the host says it is", async () => {
    const held = await store();
    const bare = [script, "--titles"];

    expect(() =>
      execFileSync(process.execPath, bare, {
        env: { TZ: "UTC" },
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/KEY_DATA_DIR is unset/);
    expect(() =>
      execFileSync(process.execPath, bare, {
        env: { KEY_DATA_DIR: join(held.directory, "nowhere"), TZ: "UTC" },
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/session\.sqlite is missing/);
  });
});
