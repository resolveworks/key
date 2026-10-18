// A child runs in a worktree inside the repo, on its own branch, and is told so in its prompt.
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
import { afterEach, describe, expect, it } from "vitest";
import { FakeGitEnv, REPO } from "../tests/git.ts";
import { KeySystem, KeyTask } from "./system.ts";
import { branchFor, ensureWorktree } from "./worktree.ts";

describe("ensureWorktree", () => {
	it("asks git for a worktree under .key, on branch agent/<name>", async () => {
		const env = new FakeGitEnv();
		const tree = await ensureWorktree("fix-the-bug", env, BACKGROUND_CONTEXT);
		expect(tree).toEqual({
			path: join(REPO, ".key", "worktrees", "fix-the-bug"),
			branch: branchFor("fix-the-bug"),
		});
		expect(env.calls).toContainEqual([
			"git",
			"worktree",
			"add",
			"--quiet",
			"-b",
			"agent/fix-the-bug",
			tree.path,
			"HEAD",
		]);
	});

	it("a name that is not kebab-case fails loudly", async () => {
		const env = new FakeGitEnv();
		await expect(ensureWorktree("Not Kebab", env, BACKGROUND_CONTEXT)).rejects.toThrow(
			/lowercase kebab-case/,
		);
		expect(env.calls).toEqual([]);
	});
});

describe("a child's run", () => {
	const harnesses: Harness[] = [];
	const created: ConversationRecord[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT);
	});

	/** A harness with fake git underneath: faux model, memory storage, one env rooted at the repo. */
	async function open(): Promise<Harness> {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(KeySystem);
		const env = new FakeGitEnv();
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models,
				registry,
				env: () => env,
				conversationCreated: (_tx, conversation: ConversationRecord) => {
					created.push(conversation);
				},
			},
			BACKGROUND_CONTEXT,
		);
		harnesses.push(harness);
		return harness;
	}

	/** Run one child task in the root conversation and wait for it. */
	async function runChild(harness: Harness, name: string): Promise<void> {
		const root = await harness.root(BACKGROUND_CONTEXT);
		const id = await root.commit(
			(tx) =>
				tx.createTask(
					KeyTask,
					{ prompt: "ask the child", name, child: true },
					{ ownership: { kind: "conversation" } },
				),
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

	it("a child runs inside the worktree its name mints", async () => {
		const harness = await open();
		await runChild(harness, "fix-the-bug");
		const conversation = created.at(-1);
		if (conversation === undefined) throw new Error("no conversation created");
		const agent = await agentState(harness, conversation.id);
		// Inside the repo, so project files are still found.
		expect(agent?.cwd).toBe(join(REPO, ".key", "worktrees", "fix-the-bug"));
	});

	it("a child's prompt names its branch and tells it to commit", async () => {
		const harness = await open();
		await runChild(harness, "commit-it");
		const conversation = created.at(-1);
		if (conversation === undefined) throw new Error("no conversation created");
		const [prompt] = await userMessages(harness, conversation.id);
		expect(prompt).toMatch(/^You work in an isolated git worktree on branch agent\/commit-it\./);
		expect(prompt).toMatch(/Commit/);
	});
});
