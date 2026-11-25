// The bundled history skill reads the store the host writes: a real session.sqlite, queried by the
// shipped script from outside the harness, exactly as a sandboxed conversation runs it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, test } from "vitest";
import { keySetup, MODEL, openKey } from "./harness.ts";

const context = BACKGROUND_CONTEXT;
const script = fileURLToPath(new URL("../skills/session-history/history.mjs", import.meta.url));

/** What one store holds: the conversation the run started in, and the conversation forked from it. */
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

/** `node history.mjs …`, as a conversation in the sandbox runs it: a reader beside the host that
 * still holds the store open, which is what WAL is for. */
function history(store: Store, ...args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, KEY_DATA_DIR: store.directory },
    encoding: "utf8",
  });
}

/** One conversation whose prompt says `marker`, so both ends of the fork can be searched. */
async function store(): Promise<Store> {
  temporary = mkdtempSync(join(tmpdir(), "key-session-history-"));
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
  setup.faux.setResponses([fauxAssistantMessage("the root answer")]);
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

describe("history.mjs", () => {
  test("list prints the fork under the root's opening label, newest last", async () => {
    const held = await store();
    const lines = history(held, "list").trimEnd().split("\n");

    // The fork's own first entry is its follow-up; its label is the ancestor's opening prompt,
    // nested one level under the conversation it forked from.
    expect(lines).toEqual([
      `${String(held.root).padStart(4)}  hello marker from the root`,
      `${String(held.fork).padStart(4)}    hello marker from the root`,
    ]);
  });

  test("show renders the fork chain: the ancestor's turns, then the fork's own", async () => {
    const held = await store();
    const shown = history(held, "show", String(held.fork));

    expect(shown).toContain(
      `#${held.fork} · fork of #${held.root} at entry ${held.rootEntries.at(-1)}`,
    );
    expect(shown).toContain("hello marker from the root");
    expect(shown).toContain("the root answer");
    expect(shown).toContain("a forked marker follow-up");
    expect(shown).toContain("the fork answer");
  });

  test("show filters to the entry ids a spec names", async () => {
    const held = await store();
    const [asked, , answered] = held.rootEntries;
    const shown = history(held, "show", String(held.root), `${asked},${answered}-${answered}`);

    expect(shown).toContain("hello marker from the root");
    expect(shown).toContain("the root answer");
    expect(shown).not.toContain("a forked marker follow-up");
    expect(shown).not.toMatch(/system|tool/);

    // The same spec on the fork names one of its own entries, not the inherited chain.
    const own = history(held, "show", String(held.fork), String(held.forkEntries[0]));
    expect(own).toContain("a forked marker follow-up");
    expect(own).not.toContain("hello marker from the root");
  });

  test("--user keeps only what the human asked", async () => {
    const held = await store();
    const shown = history(held, "show", String(held.fork), "--user");

    expect(shown).toContain("hello marker from the root");
    expect(shown).toContain("a forked marker follow-up");
    expect(shown).not.toContain("the root answer");
    expect(shown).not.toContain("the fork answer");
  });

  test("search ranks conversations by hits, counts per term, and finds nothing for an absent term", async () => {
    const held = await store();
    const both = history(held, "search", "marker", "answer").trimEnd().split("\n");

    const conversation = both.find((line) => line.startsWith(`#${held.fork}  `)) as string;
    expect(conversation).toContain("2 hits  marker 1, answer 1");
    expect(both.filter((line) => line.startsWith("#"))).toHaveLength(2);
    // One rendered row per hit, in conversation order.
    expect(both.filter((line) => line.includes("the fork answer"))).toHaveLength(1);

    const one = history(held, "search", "forked").trimEnd().split("\n");
    expect(one.filter((line) => line.startsWith("#")).map((line) => line.split("  ")[0])).toEqual([
      `#${held.fork}`,
    ]);
    expect(history(held, "search", "not-a-word-anywhere")).toBe("no hits\n");
  });
});
