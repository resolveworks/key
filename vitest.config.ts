import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
		env: { TZ: "UTC" },
		// Each file gets its own process: tests drive durable harnesses whose
		// global state must not leak between files.
		pool: "forks",
		clearMocks: true,
		restoreMocks: true,
		passWithNoTests: true,
	},
});
