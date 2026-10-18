import { afterEach, vi } from "vitest";

// A test may enter a temp workspace; each test starts from wherever the run did.
const root = process.cwd();

afterEach(() => {
	vi.useRealTimers();
	process.chdir(root);
});
