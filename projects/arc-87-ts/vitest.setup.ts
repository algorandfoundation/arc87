import { addEqualityTesters } from "@algorandfoundation/algorand-typescript-testing";
import { beforeAll, expect } from "vitest";
import { installAvm13Shims } from "./tests/helpers/avm13-shims";

beforeAll(() => {
  addEqualityTesters({ expect });
  // AVM 13 `app_params_set` / `app_params_get AppForeignBoxReads` / `app_box_*` are not
  // implemented by algorand-typescript-testing 1.2.0; back them with the test ledger.
  if (!installAvm13Shims()) {
    throw new Error(
      "AVM 13 shims did not reach the testing library's op namespace (duplicate @algorandfoundation/algorand-typescript instance?)",
    );
  }
});
