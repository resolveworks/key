import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type KeyFixture,
	type KeyRecord,
	openKey,
} from "../tests/harness.ts";

let key: KeyFixture | undefined;
afterEach(async () => {
	await key?.close();
	key = undefined;
});

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

const children = (records: readonly KeyRecord[]) => records.filter((r) => r.input.child === true);

/** The fresh context a forking context mints: it waits on the children that context forked. */
function successor(records: readonly KeyRecord[]): KeyRecord | undefined {
	const ids = children(records).map((child) => child.id);
	return records.find(
		(record) =>
			record.input.on !== undefined &&
			record.input.on.length > 0 &&
			record.input.on.every((id) => ids.includes(id)),
	);
}

/** The conversation a context minted for its own run, once it has. */
async function conversationOf(key: KeyFixture, id: number): Promise<ConversationId> {
	let found: ConversationId | undefined;
	await vi.waitFor(
		async () => {
			const { items } = await key.harness.commit(
				(tx) => tx.scanConversations({}, 1000, undefined),
				BACKGROUND_CONTEXT,
			);
			found = items.find((item) => item.owner?.taskId === id)?.id;
			expect(found).toBeDefined();
		},
		{ interval: 5 },
	);
	return found as ConversationId;
}

async function entriesOf(key: KeyFixture, conversationId: ConversationId) {
	return key.harness.commit((tx) => tx.scanEntries({ conversationId }, 1000), BACKGROUND_CONTEXT);
}

/** Start a cascade and return its task ID. */
async function started(key: KeyFixture, prompt: string): Promise<number> {
	const id = await key.run(prompt);
	await key.settled(id);
	return id;
}

/** Wait until a forking context has minted its successor. */
async function waitForSuccessor(key: KeyFixture): Promise<KeyRecord> {
	let next: KeyRecord | undefined;
	await vi.waitFor(
		async () => {
			next = successor(await key.cascade());
			expect(next).toBeDefined();
		},
		{ interval: 5 },
	);
	return next as KeyRecord;
}

describe("the fork cascade", () => {
	it("one fork call mints one child and a fresh successor", async () => {
		key = await openKey();
		// The second answer is the round after the fork: it is the text the successor inherits.
		key.answer([turn("I forked a.", ["a"]), turn("a is on its way")]);

		await started(key, "kick off");
		const next = await waitForSuccessor(key);
		const child = children(await key.cascade())[0];

		expect(child.input).toEqual({ prompt: "task for a", name: "a", child: true });
		expect(next.input).toEqual({ prompt: "a is on its way", on: [child.id] });
	});

	it("several fork calls in a turn mint several children", async () => {
		key = await openKey();
		key.answer([turn("I forked a and b.", ["a", "b"]), turn("both are underway")]);

		await started(key, "kick off");
		const next = await waitForSuccessor(key);
		const forked = children(await key.cascade()).sort((left, right) => left.id - right.id);

		expect(forked.map((record) => record.input.name)).toEqual(["a", "b"]);
		expect(next.input.on).toEqual(forked.map((record) => record.id));
	});

	it("the parent never receives its child's result", async () => {
		key = await openKey();
		key.answer([
			turn("parent answer", ["a"]),
			turn("the parent ends here"),
			turn("CHILD-ANSWER-BENEATH-THE-SURFACE"),
		]);

		const parent = await started(key, "kick off");
		const next = await waitForSuccessor(key);
		const record = (await key.cascade()).find((task) => task.id === parent);

		expect(record?.state.outcome).toEqual({
			status: "completed",
			result: "the parent ends here",
		});
		const transcript = await entriesOf(key, await conversationOf(key, parent));
		expect(JSON.stringify(transcript.items)).not.toContain("CHILD-ANSWER-BENEATH-THE-SURFACE");
		// It crosses only into the successor, as an upstream result.
		expect(next.input.prompt).toBe("the parent ends here");
	});

	it("a successor is a new context, not the parent resumed", async () => {
		key = await openKey();
		key.answer([turn("I forked a.", ["a"]), turn("a is on its way"), turn("a answers")]);

		const parent = await started(key, "kick off");
		const next = await waitForSuccessor(key);
		await key.settled(next.id);

		const parentConversation = await conversationOf(key, parent);
		expect(await conversationOf(key, next.id)).not.toBe(parentConversation);
		// The parent's conversation ends where the parent did: the successor never writes there.
		const transcripts = await entriesOf(key, parentConversation);
		const author = transcripts.items.flatMap((entry) =>
			entry.model?.map((message) => message.role),
		);
		expect(author.filter((role) => role === "user")).toHaveLength(1);
	});

	it("a context that forks nothing ends the cascade", async () => {
		key = await openKey();
		key.answer([turn("just an answer")]);

		const parent = await started(key, "kick off");
		const records = await key.cascade();

		expect(records.find((record) => record.id === parent)?.state.outcome).toEqual({
			status: "completed",
			result: "just an answer",
		});
		expect(children(records)).toEqual([]);
	});

	it("a child cannot fork", async () => {
		key = await openKey();
		// The child's conversation has fork removed, so its call is refused and mints nothing.
		key.answer([turn("I forked a.", ["a"]), turn("a is on its way")]);
		const kickoff = await key.run("kick off");
		// The child's refusal is scripted behind its prompt request: answer the child once, then refuse.
		await vi.waitFor(() => expect(key?.requests.length).toBeGreaterThanOrEqual(2), { interval: 5 });
		key.answer([turn("a forks b", ["b"])]);
		await key.settled(kickoff);

		expect(children(await key.cascade()).map((record) => record.input.name)).toEqual(["a"]);
	});
});

describe("what a context scans for forks", () => {
	it("a fork call whose result is an error mints nothing", async () => {
		key = await openKey();
		key.answer([
			turn("I forked a.", ["a"]),
			turn("a is on its way"),
			// The successor's turn contains the attempt; the scan considers every assistant message of a run.
			fauxAssistantMessage(
				[fauxToolCall("fork", { name: "b", prompt: "task for b" }), fauxText("no")],
				{ stopReason: "toolUse" },
			),
			turn("done"),
		]);

		await started(key, "kick off");
		const next = await waitForSuccessor(key);
		await key.settled(next.id);

		// b was refused, so the only child is a.
		expect(children(await key.cascade()).map((record) => record.input.name)).toEqual(["a"]);
	});
});
