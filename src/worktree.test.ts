// A child runs in a worktree inside the repo, on its own branch, and is told so in its prompt.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type AgentState,
	type ConversationId,
	type ConversationRecord,
	createRegistry,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import { KeySystem, KeyTask } from "./system.ts";
import { ensureWorktree } from "./worktree.ts";

const tempDirs: string[] = [];
const harnesses: Harness[] = [];
const created: ConversationRecord[] = [];
const started = process.cwd();

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT);
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
	process.chdir(started);
});

/** A repository with one commit, so `HEAD` exists; its own identity keeps `git worktree add` off global config. */
async function repo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "key-worktree-"));
	tempDirs.push(dir);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "--quiet", "--initial-branch=main");
	git("config", "user.name", "Key Test");
	git("config", "user.email", "key@example.com");
	git("commit", "--quiet", "--allow-empty", "-m", "root");
	return dir;
}

/** `git worktree list --porcelain` as its blocks: one path and branch each. */
function worktrees(dir: string): { path: string; branch?: string }[] {
	const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
		cwd: dir,
		encoding: "utf8",
	});
	return out
		.split("\n\n")
		.filter((block) => block.trim() !== "")
		.map((block) => {
			const lines = block.split("\n");
			return {
				path: lines[0].slice("worktree ".length),
				branch: lines.find((line) => line.startsWith("branch "))?.slice("branch ".length),
			};
		});
}

/** A harness for one repo: faux model, memory storage, and a real environment rooted at the repo. */
async function open(dir: string): Promise<Harness> {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(KeySystem);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			env: () => new NodeExecutionEnv({ cwd: dir }),
			conversationCreated: (_tx, conversation: ConversationRecord) => {
				created.push(conversation);
			},
		},
		BACKGROUND_CONTEXT,
	);
	harnesses.push(harness);
	return harness;
}

/** Run one task in the root conversation and wait for it. */
async function run(
	harness: Harness,
	input: { prompt: string; name?: string; child?: true },
): Promise<void> {
	const root = await harness.root(BACKGROUND_CONTEXT);
	const id = await root.commit(
		(tx) => tx.createTask(KeyTask, input, { ownership: { kind: "conversation" } }),
		BACKGROUND_CONTEXT,
	);
	await harness.waitForTask(id, BACKGROUND_CONTEXT);
}

async function userMessages(harness: Harness, id: ConversationId): Promise<string[]> {
	const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
	const view = await conversation?.context(BACKGROUND_CONTEXT);
	return (view?.messages ?? []).flatMap((message) =>
		message.role === "user" && typeof message.content === "string" ? [message.content] : [],
	);
}

async function agentState(harness: Harness, id: ConversationId): Promise<AgentState | undefined> {
	const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
	const view = await conversation?.viewState(BACKGROUND_CONTEXT);
	return view?.value.docs["pi.agent"] as AgentState | undefined;
}

describe("child worktrees", () => {
	it("a child gets its own worktree on branch agent/<name>", async () => {
		const dir = await repo();
		const harness = await open(dir);
		await run(harness, { prompt: "ask the child", name: "fix-the-bug", child: true });
		const entry = worktrees(dir).find(
			(worktree) => worktree.path === join(dir, ".key", "worktrees", "fix-the-bug"),
		);
		expect(entry).toEqual({
			path: join(dir, ".key", "worktrees", "fix-the-bug"),
			branch: "refs/heads/agent/fix-the-bug",
		});
	});

	it("the worktree sits inside the repo, so project files are still found", async () => {
		const dir = await repo();
		const harness = await open(dir);
		await run(harness, { prompt: "ask the child", name: "inside", child: true });
		const conversation = created.at(-1);
		if (conversation === undefined) throw new Error("no conversation created");
		const agent = await agentState(harness, conversation.id);
		expect(agent?.cwd).toBe(join(dir, ".key", "worktrees", "inside"));
	});

	it("a crashed attempt reuses the worktree it already made", async () => {
		const dir = await repo();
		const env = new NodeExecutionEnv({ cwd: dir });
		const first = await ensureWorktree("retry", env, BACKGROUND_CONTEXT);
		const second = await ensureWorktree("retry", env, BACKGROUND_CONTEXT);
		expect(second).toEqual(first);
		const mine = worktrees(dir).filter((worktree) => worktree.path === first.path);
		expect(mine).toHaveLength(1);
		expect(mine[0].branch).toBe("refs/heads/agent/retry");
	});

	it("a name that is not kebab-case fails loudly", async () => {
		const dir = await repo();
		const env = new NodeExecutionEnv({ cwd: dir });
		await expect(ensureWorktree("Not Kebab", env, BACKGROUND_CONTEXT)).rejects.toThrow(
			/lowercase kebab-case/,
		);
	});

	it("a child's prompt names its branch and tells it to commit", async () => {
		const dir = await repo();
		const harness = await open(dir);
		await run(harness, { prompt: "ask the child", name: "commit-it", child: true });
		const conversation = created.at(-1);
		if (conversation === undefined) throw new Error("no conversation created");
		const [prompt] = await userMessages(harness, conversation.id);
		expect(prompt).toMatch(/^You work in an isolated git worktree on branch agent\/commit-it\./);
		expect(prompt).toMatch(/Commit/);
	});
});
