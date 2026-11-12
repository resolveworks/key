import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { TZ: "UTC" },
    // Each file gets its own process: tests drive durable harnesses whose
    // global state must not leak between files.
    pool: "forks",
    clearMocks: true,
    restoreMocks: true,
    // The tools live in sibling packages: Vite must process them so vi.mock
    // reaches the playwright-core they import.
    server: { deps: { inline: ["mine", "scry"] } },
  },
});
