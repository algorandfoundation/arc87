import { defineConfig } from "vitest/config";

/**
 * Opt-in localnet integration suite (`npm run test:integration`).
 *
 * Requires a running localnet (`algokit localnet start`). The tests drive the
 * compiled contract through the generated typed client, so no `puyaTsTransformer`
 * is applied here; run `npm run build` first to produce `smart_contracts/client.ts`.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
