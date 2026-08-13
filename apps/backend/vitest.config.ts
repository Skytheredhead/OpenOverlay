import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Authentication tests intentionally exercise bcrypt. Under the full
    // parallel suite, CPU contention can exceed Vitest's five-second default
    // even though isolated requests complete in under a second.
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000
  }
});
