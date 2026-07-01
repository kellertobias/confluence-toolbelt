import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run the TypeScript sources, never the compiled dist copies (which
    // would be a separate module instance and miss the DOM registration).
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Register the node (linkedom) DOM adapter before any test runs so the
    // conversion code's getDom() resolves without each test wiring it up.
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
