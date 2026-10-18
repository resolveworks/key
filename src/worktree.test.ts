// A child runs in a worktree inside the repo, on its own branch, and is told so in its prompt.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentState,
	type ConversationRecord,
	type Harness,
	MemoryStorage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGit, gitCalls, REPO, resetGit } from "../tests/git.ts";
import { conversationOf, KeyTask, keySetup, openKey } from "../tests/harness.ts";
import { branchFor, ensureWorktree } from "./worktree.ts";

const context = BACKGROUND_CONTEXT;

describe("ensureWorktree", () => {
	beforeEach(resetGit);

	it("asks git for a worktree under .key, on branch agent/<name>", async () => {
		const tree = await ensureWorktree("fix-the-bug", fakeGit, REPO);
		expect(tree).toEqual({
			path: join(REPO, ".key", "worktrees", "fix-the-bug"),
			branch: branchFor("fix-the-bug"),
		});
		expect(gitCalls()).toContainEqual([
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
		await expect(ensureWorktree("Not Kebab", fakeGit, REPO)).rejects.toThrow(
			/lowercase kebab-case/,
		);
		expect(gitCalls()).toEqual([]);
	});
});

describe("a child's run", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.close(context);
	});

	/** One harness with fake git underneath; the model just answers "done". */
	async function open(): Promise<Harness> {
		const setup = keySetup();
		setup.faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
		const harness = await openKey(new MemoryStorage(), setup);
		harnesses.push(harness);
		return harness;
	}

	/** Run one child task in the root conversation, wait for it, and return it with its conversation. */
	async function runChild(
		harness: Harness,
		name: string,
	): Promise<{ readonly task: TaskId; readonly conversation: ConversationRecord }> {
		const root = await harness.root(context);
		const task = await root.commit(
			(tx) =>
				tx.createTask(
					KeyTask,
					{ prompt: "ask the child", name, child: true, cwd: REPO },
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		await harness.waitForTask(task, context);
		const conversation = await harness.conversation(await conversationOf(harness, task), context);
		if (conversation === undefined) throw new Error(`no conversation for task #${task}`);
		return { task, conversation };
	}

	async function userMessages(harness: Harness, id: ConversationRecord["id"]): Promise<string[]> {
		const conversation = await harness.conversation(id, context);
		const view = await conversation?.context(context);
		return (view?.messages ?? []).flatMap((message) =>
			message.role === "user" && typeof message.content === "string" ? [message.content] : [],
		);
	}

	async function agentState(
		harness: Harness,
		id: ConversationRecord["id"],
	): Promise<AgentState | undefined> {
		const conversation = await harness.conversation(id, context);
		const view = await conversation?.viewState(context);
		return view?.value.docs["pi.agent"] as AgentState | undefined;
	}

	it("a child runs inside the worktree its name mints", async () => {
		const harness = await open();
		const { conversation } = await runChild(harness, "fix-the-bug");
		const agent = await agentState(harness, conversation.id);
		// Inside the repo, so project files are still found.
		expect(agent?.cwd).toBe(join(REPO, ".key", "worktrees", "fix-the-bug"));
	});

	it("a child's prompt names its branch and tells it to commit", async () => {
		const harness = await open();
		const { conversation } = await runChild(harness, "commit-it");
		const [prompt] = await userMessages(harness, conversation.id);
		expect(prompt).toMatch(/^You work in an isolated git worktree on branch agent\/commit-it\./);
		expect(prompt).toMatch(/Commit/);
	});
});
