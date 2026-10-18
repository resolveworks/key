import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, type KeyFixture, openKey, script, settled } from "./harness.ts";

describe("the fixture", () => {
	it("a context's result is its final assistant text", async () => {
		const key: KeyFixture = await openKey();
		try {
			script(key, fauxAssistantMessage("Hello there"));
			const id = await key.run("Say hello");
			const receipt = await settled(key.harness, id);
			expect(receipt.state.outcome).toEqual({ status: "completed", result: "Hello there" });
		} finally {
			await key.close();
			key.cleanup();
		}
	});
});
