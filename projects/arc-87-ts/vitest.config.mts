import { puyaTsTransformer } from "@algorandfoundation/algorand-typescript-testing/vitest-transformer";
import typescript from "@rollup/plugin-typescript";
import { defineConfig } from "vitest/config";

/**
 * Offline (network-free) test suite.
 *
 * `*.algo.test.ts` files are run through `puyaTsTransformer` so Algorand TypeScript
 * contracts can be executed by `algorand-typescript-testing`; plain `tests/*.test.ts`
 * files (e.g. the ABI parity check) need no transformation. Localnet integration
 * tests live in `vitest.integration.config.mts`.
 */
export default defineConfig({
  esbuild: {},
  test: {
    include: ["smart_contracts/**/*.algo.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/**/*.integration.test.ts"],
    setupFiles: "vitest.setup.ts",
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.test.json",
      noEmitOnError: false,
      transformers: {
        before: [puyaTsTransformer],
      },
    }),
  ],
});
