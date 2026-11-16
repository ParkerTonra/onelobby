import { defineConfig } from "vitest/config";

// A settings variable left in the shell must not change a test (spec/settings.md s.3): tests that need one pass `advanced.env`.
export default defineConfig({ test: { setupFiles: ["./test/setup-env.ts"] } });
