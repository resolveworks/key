import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, openKey } from "./harness.ts";

describe("the fixture", () => {
	it("a context's result is its final assistant text", async () => {
		const key = await openKey();
		try {
			key.answer([fauxAssistantMessage("Hello there")]);
			const id = await key.run("Say hello");
			const receipt = await key.settled(id);
			expect(receipt.state.outcome).toEqual({ status: "completed", result: "Hello there" });
		} finally {
			await key.close();
		}
	});
});
