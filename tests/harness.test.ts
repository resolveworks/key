import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { configure, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { KeyTask } from "../src/system.ts";
import { REPO } from "./git.ts";
import { keySetup, MODEL, openKey } from "./harness.ts";

describe("a context's result", () => {
	it("is its final assistant text", async () => {
		const setup = keySetup();
		const harness = await openKey(new MemoryStorage(), setup);
		try {
			setup.faux.setResponses([fauxAssistantMessage("Hello there")]);
			const id = await harness.commit(async (tx) => {
				const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
				await configure(tx, conversation.id, { model: MODEL, cwd: REPO });
				return tx.createTask(
					KeyTask,
					{ prompt: "Say hello" },
					{ ownership: { kind: "conversation" }, conversationId: conversation.id },
				);
			}, BACKGROUND_CONTEXT);
			harness.resume();
			const receipt = await harness.waitForTask(id, BACKGROUND_CONTEXT);
			expect(receipt.state.outcome).toEqual({ status: "completed", result: "Hello there" });
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
