/**
 * Offline shims for the AVM 13 ops that `algorand-typescript-testing` 1.2.0 does not
 * implement yet and the contracts rely on: `AppParamsSet.appForeignBoxReads` (the
 * store's bare create) and `AppBox.length/extract/get` (the reader's direct reads) — the
 * `app_params_set` and `app_box_*` opcodes.
 *
 * How it works: the testing library's `op` namespace is frozen, but it resolves members
 * it does not override (`AppBox`, `AppParamsSet`) by getter to the plain objects exported
 * from `@algorandfoundation/algorand-typescript/op`, whose methods throw
 * `NoImplementation`. Those objects are mutable, so the method bodies are replaced here
 * with ledger-backed fakes.
 *
 * The fakes need the active `TestExecutionContext`; it is captured by wrapping the
 * context's prototype getters (the library itself goes through them for every op), so
 * test files keep creating `new TestExecutionContext()` as usual.
 *
 * Install once per worker from `vitest.setup.ts` via {@link installAvm13Shims}; inspect
 * the per-app flag with {@link getForeignBoxReads}.
 */
import type {
  Application,
  bytes,
  uint64,
} from "@algorandfoundation/algorand-typescript";
import {
  AppBox,
  AppParamsSet,
} from "@algorandfoundation/algorand-typescript/op";
import {
  AvmError,
  TestExecutionContext,
} from "@algorandfoundation/algorand-typescript-testing";

type AlgoTs = typeof import("@algorandfoundation/algorand-typescript");
type AlgoTsOp = typeof import("@algorandfoundation/algorand-typescript/op");

/** The testing library's runtime re-exports the algorand-typescript surface (typed `{}`). */
const internal = (await import(
  "@algorandfoundation/algorand-typescript-testing/internal"
)) as unknown as AlgoTs & { op: AlgoTsOp };

const { Bytes, Uint64 } = internal;

// --- active context capture -----------------------------------------------

let active: TestExecutionContext | undefined;

function captureContext(): void {
  const proto = TestExecutionContext.prototype;
  for (const name of ["ledger", "txn", "contract", "any", "defaultSender"]) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc?.get) continue;
    const original = desc.get;
    Object.defineProperty(proto, name, {
      ...desc,
      get(this: TestExecutionContext) {
        active = this;
        return original.call(this);
      },
    });
  }
}

function context(): TestExecutionContext {
  if (!active) {
    throw new Error("avm13-shims: no TestExecutionContext has been used yet");
  }
  return active;
}

// --- helpers ----------------------------------------------------------------

function toBigInt(value: uint64 | bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt((value as { valueOf(): bigint | number }).valueOf());
}

function appId(a: Application | uint64): bigint {
  return typeof a === "object" && a !== null && "id" in a
    ? toBigInt((a as Application).id)
    : toBigInt(a as uint64);
}

function appExists(ctx: TestExecutionContext, id: bigint): boolean {
  try {
    ctx.ledger.getApplication(Uint64(id));
    return true;
  } catch {
    return false;
  }
}

function boxOf(
  ctx: TestExecutionContext,
  a: Application | uint64,
  name: bytes,
): { content: Uint8Array; exists: boolean } {
  const id = appId(a);
  if (!appExists(ctx, id)) {
    throw new AvmError(`no app ${id}`);
  }
  const app = ctx.ledger.getApplication(Uint64(id));
  return {
    content: ctx.ledger.getBox(app, name),
    exists: ctx.ledger.boxExists(app, name),
  };
}

function activeAppId(ctx: TestExecutionContext): bigint {
  return toBigInt(ctx.txn.activeGroup.activeApplicationId);
}

/** Largest AVM byte-string (`MaxStringSize`), the cap of `app_box_get`. */
const MAX_AVM_BYTES = 4096;

// --- foreign-reads flag -----------------------------------------------------

const foreignBoxReads = new Map<bigint, boolean>();

/**
 * The `AppForeignBoxReads` flag recorded for `app` by the `AppParamsSet` shim
 * (`false` when never set, matching the AVM default).
 */
export function getForeignBoxReads(app: Application | uint64): boolean {
  return foreignBoxReads.get(appId(app)) ?? false;
}

/** Clears every recorded flag (call from `afterEach` next to `ctx.reset()`). */
export function resetForeignBoxReads(): void {
  foreignBoxReads.clear();
}

// --- install ----------------------------------------------------------------

let installed = false;

/**
 * Patches the op objects in place. Returns `true` when the objects reached through the
 * testing library's `op` namespace are the very same instances that were patched (i.e.
 * the patch-by-reference approach is effective for the current module graph).
 */
export function installAvm13Shims(): boolean {
  if (!installed) {
    installed = true;
    captureContext();

    AppParamsSet.appForeignBoxReads = (a: boolean): void => {
      foreignBoxReads.set(activeAppId(context()), a);
    };

    AppBox.length = (a, b): readonly [uint64, boolean] => {
      const { content, exists } = boxOf(context(), a, b);
      return [Uint64(content.length), exists];
    };

    AppBox.extract = (a, b, c, d): bytes => {
      const { content, exists } = boxOf(context(), a, b);
      if (!exists) {
        throw new AvmError("box does not exist");
      }
      const start = Number(toBigInt(c));
      const length = Number(toBigInt(d));
      if (start + length > content.length) {
        throw new AvmError("extract range beyond box size");
      }
      return Bytes(content.slice(start, start + length));
    };

    AppBox.get = (a, b): readonly [bytes, boolean] => {
      const { content, exists } = boxOf(context(), a, b);
      // Like `box_get`, the whole value must fit a single AVM byte-string.
      if (content.length > MAX_AVM_BYTES) {
        throw new AvmError(
          `box_get produced a too big (${content.length}) byte-array`,
        );
      }
      return [Bytes(exists ? content : new Uint8Array(0)), exists];
    };
  }

  return (
    internal.op.AppBox === AppBox && internal.op.AppParamsSet === AppParamsSet
  );
}
