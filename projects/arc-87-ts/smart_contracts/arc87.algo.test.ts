/**
 * Offline tests for the Algorand TypeScript `ARC87` contract.
 *
 * Executed by `algorand-typescript-testing` (no localnet). Mirrors
 * `projects/arc-87-py/tests/test_arc87.py`: `set`/`remove`/`concat` (and their bytes
 * twins) store under the `o_` prefix exactly the box keys produced by
 * `@algorandfoundation/arc87`, the `length`/`extract` reads are public while writes
 * stay creator-only, the per-value `maxValue` cap is fixed at create (bare create or
 * `create(uint64)`) and every hardening rule (no rekey, size limits, update/delete
 * gates, reclaim guards, 1018-byte extract cap, foreign reads always on) holds. The
 * AVM 13 `app_params_set` op is emulated by `tests/helpers/avm13-shims.ts`.
 */
import { readFileSync } from "node:fs";
import {
  type Account,
  Bytes,
  type bytes,
  OnCompleteAction,
  Uint64,
  type uint64,
} from "@algorandfoundation/algorand-typescript";
import { TestExecutionContext } from "@algorandfoundation/algorand-typescript-testing";
import {
  assemble,
  byteLength,
  type KeyValue,
  MAX_BOX_SIZE,
  MAX_KEY_SIZE,
  MAX_STRUCT_SIZE,
  PREFIX,
  stripPrefix,
  toBoxes,
} from "@algorandfoundation/arc87";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getForeignBoxReads,
  resetForeignBoxReads,
} from "../tests/helpers/avm13-shims";
import { ARC87 } from "./arc87.algo";

// --- vectors -----------------------------------------------------------------

type PathsVectors = {
  prefix: string;
  cases: { name: string; object: unknown; paths: string[]; keys: string[] }[];
};

type MbrVectors = {
  constants: Record<string, number | string>;
  cases: { name: string; object: unknown; boxes: KeyValue[]; mbr: string }[];
};

function loadVectors<T>(name: string): T {
  const url = new URL(
    `../../conformance/vectors/${name}.json`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

const PATHS = loadVectors<PathsVectors>("paths");
const MBR = loadVectors<MbrVectors>("mbr");

// --- helpers -----------------------------------------------------------------

const DELETE = OnCompleteAction.DeleteApplication;
const UPDATE = OnCompleteAction.UpdateApplication;
const NOOP = OnCompleteAction.NoOp;

const decoder = new TextDecoder();

describe("ARC87 contract", () => {
  const ctx = new TestExecutionContext();
  let contract: ARC87;

  /** Runs `body` inside an app-call group targeting `contract` with the given field overrides. */
  function inCall(
    overrides: {
      onCompletion?: OnCompleteAction;
      sender?: Account;
      rekeyTo?: Account;
    },
    body: () => void,
  ): void {
    const txn = ctx.any.txn.applicationCall({
      appId: contract,
      onCompletion: NOOP,
      ...overrides,
    });
    ctx.txn.createScope([txn]).execute(body);
  }

  function box(path: string): string {
    return decoder.decode(
      ctx.ledger.getBox(contract, Bytes(`${PREFIX}${path}`)),
    );
  }

  function hasBox(path: string): boolean {
    return ctx.ledger.boxExists(contract, Bytes(`${PREFIX}${path}`));
  }

  function set(path: string, value: string | Uint8Array): void {
    if (typeof value === "string") {
      contract.set(path, value);
    } else {
      contract.setBytes(path, Bytes(value));
    }
  }

  /** The whole value under `path` read back through the public ABI (`length` + `extract`). */
  function read(path: string): bytes {
    return contract.extract(path, 0, contract.length(path));
  }

  beforeEach(() => {
    // With an explicit bare create handler the app stays "creating" until it has been called.
    contract = ctx.contract.create(ARC87);
    contract.onCreate();
  });

  afterEach(() => {
    ctx.reset();
    resetForeignBoxReads();
  });

  // --- behaviour -------------------------------------------------------------

  it("uses the vector prefix", () => {
    expect(PREFIX).toBe(PATHS.prefix);
    expect(PREFIX).toBe(MBR.constants.PREFIX);
    set("k", "v");
    expect(ctx.ledger.boxExists(contract, Bytes("o_k"))).toBe(true);
  });

  it("sets and reads back", () => {
    set("metadata.rp", "algorand.co");
    expect(box("metadata.rp")).toBe("algorand.co");
    expect(read("metadata.rp").toString()).toBe("algorand.co");
  });

  it("overwrites on set", () => {
    set("index", "1");
    set("index", "2");
    expect(box("index")).toBe("2");
  });

  it("fails to read a missing path", () => {
    expect(() => contract.length("missing")).toThrow("path not found");
    expect(() => contract.extract("missing", 0, 0)).toThrow("path not found");
  });

  it("removes", () => {
    set("blobs[0]", "...");
    expect(hasBox("blobs[0]")).toBe(true);
    // `remove` deletes the prefixed box (`o_blobs[0]`), the same one `set` wrote.
    contract.remove("blobs[0]");
    expect(hasBox("blobs[0]")).toBe(false);
    expect(() => contract.remove("blobs[0]")).toThrow("path not found");
  });

  it("concatenates", () => {
    set("blobs[1]", "abc");
    contract.concat("blobs[1]", "def");
    expect(box("blobs[1]")).toBe("abcdef");
    expect(() => contract.concat("nope", "x")).toThrow("path not found");
  });

  it("concatenates past the 4096-byte AVM stack limit via resize/replace", () => {
    // Offline harness still builds each ABI argument on the stack, so chunk at
    // 4094 bytes (ABI length prefix overhead). Multiple concats grow the box
    // without ever materialising the full value as a single stack item.
    const chunk = "a".repeat(4094);
    set("big", chunk);
    contract.concat("big", chunk);
    expect(box("big").length).toBe(4094 * 2);
    contract.concat("big", "xyz");
    expect(box("big").endsWith("xyz")).toBe(true);
    expect(box("big").length).toBe(4094 * 2 + 3);
  });

  it("sets and reads back raw bytes, including non-UTF-8", () => {
    const raw = new Uint8Array([0xff, 0x00, 0xfe]);
    contract.setBytes("bin", Bytes(raw));
    expect(ctx.ledger.getBox(contract, Bytes("o_bin"))).toEqual(raw);
    expect(contract.length("bin")).toEqual(3);
    expect(read("bin").equals(Bytes(raw))).toBe(true);
    // Text and bytes share one map: whatever was written last wins.
    set("bin", "text");
    expect(read("bin").toString()).toBe("text");
    contract.setBytes("bin", Bytes("raw"));
    expect(box("bin")).toBe("raw");
  });

  it("concatenates bytes past the 4096-byte AVM stack limit", () => {
    const chunk = Bytes(new Uint8Array(4094).fill(0xab));
    contract.setBytes("bigbin", chunk);
    contract.concatBytes("bigbin", chunk);
    contract.concatBytes("bigbin", Bytes.fromHex("0102"));
    const stored = ctx.ledger.getBox(contract, Bytes("o_bigbin"));
    expect(stored.length).toBe(4094 * 2 + 2);
    expect(contract.length("bigbin")).toEqual(4094 * 2 + 2);
    expect(stored.slice(-2)).toEqual(new Uint8Array([1, 2]));
    expect(() => contract.concatBytes("nope", chunk)).toThrow("path not found");
  });

  it("extracts slices and rejects out-of-range reads", () => {
    set("blobs[2]", "abcdef");
    expect(contract.extract("blobs[2]", 0, 6).equals(Bytes("abcdef"))).toBe(
      true,
    );
    expect(contract.extract("blobs[2]", 3, 3).equals(Bytes("def"))).toBe(true);
    expect(contract.extract("blobs[2]", 6, 0).length).toEqual(0);
    expect(() => contract.extract("blobs[2]", 3, 4)).toThrow(
      "extract out of range",
    );
    expect(() => contract.extract("blobs[2]", 7, 0)).toThrow(
      "extract out of range",
    );
    expect(() => contract.extract("missing", 0, 1)).toThrow("path not found");
    expect(() => contract.length("missing")).toThrow("path not found");
  });

  it("caps extract at the 1018 bytes that fit a readonly log", () => {
    const chunk = "a".repeat(4094);
    set("big", chunk);
    expect(contract.extract("big", 0, 1018).length).toEqual(1018);
    expect(contract.extract("big", 4094 - 1018, 1018).length).toEqual(1018);
    // The cap is checked before the box is touched, so it also applies to missing paths.
    expect(() => contract.extract("big", 0, 1019)).toThrow(
      "slice exceeds 1018 bytes",
    );
    expect(() => contract.extract("missing", 0, 1019)).toThrow(
      "slice exceeds 1018 bytes",
    );
  });

  it("lets anyone read but only the creator write", () => {
    set("k", "v");
    const other = ctx.any.account();
    inCall({ sender: other }, () => {
      expect(contract.length("k")).toEqual(1);
      expect(contract.extract("k", 0, 1).equals(Bytes("v"))).toBe(true);

      const writes = [
        () => set("alice", "x"),
        () => contract.setBytes("alice", Bytes("x")),
        () => contract.concat("k", "x"),
        () => contract.concatBytes("k", Bytes("x")),
        () => contract.remove("k"),
        () => contract.reclaim(1),
      ];
      for (const write of writes) {
        expect(write).toThrow("creator only");
      }
    });
    expect(box("k")).toBe("v");
    expect(hasBox("alice")).toBe(false);
  });

  it("enables foreign box reads on create, with no method to turn them off", () => {
    const app = ctx.ledger.getApplicationForContract(contract);
    expect(getForeignBoxReads(app)).toBe(true);
    expect("setForeignReads" in contract).toBe(false);
  });

  // --- maxValue --------------------------------------------------------------

  /** The `maxValue` global read from the ledger, as a consumer would with `app_global_get_ex`. */
  function maxValueOf(c: ARC87): bigint {
    const [state, exists] = ctx.ledger.getGlobalState(c, Bytes("maxValue"));
    expect(exists).toBe(true);
    return BigInt((state?.value as uint64).valueOf());
  }

  it("defaults maxValue to 32 KiB on a bare create", () => {
    expect(maxValueOf(contract)).toBe(MAX_BOX_SIZE);
    expect(BigInt(contract.maxValue.value.valueOf())).toBe(MAX_BOX_SIZE);
  });

  it("records a custom maxValue through create(uint64) and enables foreign reads", () => {
    const capped = ctx.contract.create(ARC87);
    capped.create(Uint64(MAX_STRUCT_SIZE));
    expect(maxValueOf(capped)).toBe(MAX_STRUCT_SIZE);
    expect(
      getForeignBoxReads(ctx.ledger.getApplicationForContract(capped)),
    ).toBe(true);
    expect("setMaxValue" in capped).toBe(false);
  });

  it("rejects a maxValue of zero or above 32 KiB", () => {
    for (const bad of [0n, MAX_BOX_SIZE + 1n, 2n ** 64n - 1n]) {
      const app = ctx.contract.create(ARC87);
      expect(() => app.create(Uint64(bad))).toThrow("maxValue out of range");
    }
    for (const ok of [1n, MAX_STRUCT_SIZE, MAX_BOX_SIZE]) {
      const app = ctx.contract.create(ARC87);
      app.create(Uint64(ok));
      expect(maxValueOf(app)).toBe(ok);
    }
  });

  it("rejects rekeying on create(uint64)", () => {
    const rekeyed = ctx.contract.create(ARC87);
    const txn = ctx.any.txn.applicationCall({
      appId: rekeyed,
      onCompletion: NOOP,
      rekeyTo: ctx.any.account(),
    });
    ctx.txn.createScope([txn]).execute(() => {
      expect(() => rekeyed.create(Uint64(MAX_STRUCT_SIZE))).toThrow(
        "rekey not allowed",
      );
    });
  });

  it("enforces maxValue on set, setBytes, concat and concatBytes", () => {
    const capped = ctx.contract.create(ARC87);
    capped.create(Uint64(100));
    const txn = ctx.any.txn.applicationCall({
      appId: capped,
      onCompletion: NOOP,
    });
    ctx.txn.createScope([txn]).execute(() => {
      capped.setBytes("k", Bytes(new Uint8Array(100)));
      expect(ctx.ledger.getBox(capped, Bytes("o_k")).length).toBe(100);
      expect(() => capped.setBytes("k", Bytes(new Uint8Array(101)))).toThrow(
        "value exceeds maxValue",
      );
      expect(() => capped.set("k", "a".repeat(101))).toThrow(
        "value exceeds maxValue",
      );
      expect(() => capped.concatBytes("k", Bytes("x"))).toThrow(
        "value exceeds maxValue",
      );
      expect(() => capped.concat("k", "x")).toThrow("value exceeds maxValue");
      // A rejected write leaves the box untouched; shrinking frees room again.
      expect(ctx.ledger.getBox(capped, Bytes("o_k")).length).toBe(100);
      capped.set("k", "a".repeat(99));
      capped.concat("k", "b");
      expect(ctx.ledger.getBox(capped, Bytes("o_k")).length).toBe(100);
    });
  });

  // --- hardening -------------------------------------------------------------

  it("rejects rekeying on every method, including bare delete/update", () => {
    set("k", "v");
    const rekeyTo = ctx.any.account();
    const calls: [() => unknown, OnCompleteAction][] = [
      [() => set("k", "v"), NOOP],
      [() => contract.setBytes("k", Bytes("v")), NOOP],
      [() => contract.length("k"), NOOP],
      [() => contract.extract("k", 0, 1), NOOP],
      [() => contract.remove("k"), NOOP],
      [() => contract.concat("k", "v"), NOOP],
      [() => contract.concatBytes("k", Bytes("v")), NOOP],
      [() => contract.reclaim(1), NOOP],
      [() => contract.onDelete(), DELETE],
      [() => contract.onUpdate(), UPDATE],
    ];
    for (const [call, onCompletion] of calls) {
      inCall({ onCompletion, rekeyTo }, () => {
        expect(call).toThrow("rekey not allowed");
      });
    }
    // The box survived every rejected call.
    expect(box("k")).toBe("v");
  });

  it("rejects rekeying on create", () => {
    const rekeyed = ctx.contract.create(ARC87);
    const txn = ctx.any.txn.applicationCall({
      appId: rekeyed,
      onCompletion: NOOP,
      rekeyTo: ctx.any.account(),
    });
    ctx.txn.createScope([txn]).execute(() => {
      expect(() => rekeyed.onCreate()).toThrow("rekey not allowed");
    });
    // The failed create leaves the app in its "creating" state, so ABI calls stay blocked.
    expect(() => rekeyed.set("k", "v")).toThrow();
  });

  it("rejects an empty path", () => {
    expect(() => set("", "x")).toThrow("path must not be empty");
  });

  it("rejects keys over 64 bytes", () => {
    // 62 path bytes + the 2-byte prefix is exactly 64 bytes and fine; one more byte fails.
    const ok = "k".repeat(Number(MAX_KEY_SIZE) - PREFIX.length);
    set(ok, "v");
    expect(box(ok)).toBe("v");
    expect(() => set(`${ok}k`, "v")).toThrow("key exceeds 64 bytes");
    // Multi-byte UTF-8 counts in bytes, not characters.
    expect(byteLength("\u00e9".repeat(32))).toBe(64);
    expect(() => set("\u00e9".repeat(32), "v")).toThrow("key exceeds 64 bytes");
  });

  it("rejects values over the default 32 KiB maxValue", () => {
    // `algorand-typescript-testing` emulates the 4096-byte AVM stack-value limit, so a
    // 32 KiB string cannot be built offline; the largest representable values go through
    // the public methods and the boundary itself is checked on the shared `assertValue`
    // guard (the localnet integration tests cover the end-to-end case).
    const chunk = "a".repeat(4094); // 4096 minus the 2-byte ABI length prefix
    set("big", chunk);
    expect(box("big").length).toBe(4094);

    const guard = contract as unknown as { assertValue(length: uint64): void };
    expect(() => guard.assertValue(Number(MAX_BOX_SIZE))).not.toThrow();
    expect(() => guard.assertValue(Number(MAX_BOX_SIZE) + 1)).toThrow(
      "value exceeds maxValue",
    );
    expect(() => guard.assertValue(Uint64(2n ** 64n - 1n))).toThrow(
      "value exceeds maxValue",
    );
  });

  it("reports missing paths with the same message everywhere", () => {
    for (const call of [
      () => contract.length("missing"),
      () => contract.extract("missing", 0, 0),
      () => contract.remove("missing"),
      () => contract.concat("missing", "x"),
      () => contract.concatBytes("missing", Bytes("x")),
    ]) {
      expect(call).toThrow("path not found");
    }
  });

  it("gates delete on DELETABLE", () => {
    ctx.setTemplateVar("DELETABLE", 0);
    inCall({ onCompletion: DELETE }, () => {
      expect(() => contract.onDelete()).toThrow("not deletable");
    });
    ctx.setTemplateVar("DELETABLE", 1);
    inCall({ onCompletion: DELETE }, () => {
      expect(() => contract.onDelete()).not.toThrow();
    });
  });

  it("gates update on UPDATABLE", () => {
    ctx.setTemplateVar("UPDATABLE", 0);
    inCall({ onCompletion: UPDATE }, () => {
      expect(() => contract.onUpdate()).toThrow("not updatable");
    });
    ctx.setTemplateVar("UPDATABLE", 1);
    inCall({ onCompletion: UPDATE }, () => {
      expect(() => contract.onUpdate()).not.toThrow();
    });
  });

  it("gates are creator only", () => {
    ctx.setTemplateVar("DELETABLE", 1);
    ctx.setTemplateVar("UPDATABLE", 1);
    const other = ctx.any.account();
    const calls: [() => void, OnCompleteAction][] = [
      [() => contract.onDelete(), DELETE],
      [() => contract.onUpdate(), UPDATE],
    ];
    for (const [call, onCompletion] of calls) {
      inCall({ onCompletion, sender: other }, () => {
        expect(call).toThrow("creator only");
      });
    }
  });

  it("guards reclaim", () => {
    const app = ctx.ledger.getApplicationForContract(contract);
    const minBalance = 100_000;
    ctx.ledger.patchAccountData(app.address, {
      account: { balance: minBalance + 1_000, minBalance },
    });

    // A call that throws leaves its group active in `algorand-typescript-testing`, so
    // the rejected calls get an explicit scope each to keep `lastGroup` meaningful.
    inCall({}, () => {
      expect(() => contract.reclaim(0)).toThrow("amount must be positive");
    });
    inCall({}, () => {
      expect(() => contract.reclaim(1_001)).toThrow(
        "cannot reclaim below minimum balance",
      );
    });
    expect(ctx.txn.lastGroup.itxnGroups).toHaveLength(0);

    // Exactly the surplus is fine and pays the creator with a zero-fee inner payment.
    contract.reclaim(1_000);
    const payment = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn();
    expect(payment.sender).toEqual(app.address);
    expect(payment.receiver).toEqual(app.creator);
    expect(payment.amount).toEqual(1_000);
    expect(payment.fee).toEqual(0);
  });

  // --- vectors ---------------------------------------------------------------

  describe("stores every paths.json vector key", () => {
    for (const c of PATHS.cases) {
      it(c.name, () => {
        // Writing every path of a vector object through `set` yields exactly the vector keys.
        const boxes = toBoxes(c.object);
        for (const [key, value] of boxes) {
          set(stripPrefix(key), value);
        }
        for (const key of c.keys) {
          expect(hasBox(stripPrefix(key))).toBe(true);
        }
        if (boxes.length > 0) {
          const stored: KeyValue[] = boxes.map(([k]) => [
            k,
            box(stripPrefix(k)),
          ]);
          expect(assemble(stored)).toEqual(assemble(boxes));
        }
      });
    }
  });

  describe("stores every mbr.json vector box", () => {
    for (const c of MBR.cases) {
      it(c.name, () => {
        // Escaped keys and keys of exactly 64 bytes are plain boxes; reading everything
        // back assembles the object.
        for (const [key, value] of c.boxes) {
          expect(byteLength(key)).toBeLessThanOrEqual(Number(MAX_KEY_SIZE));
          set(stripPrefix(key), value);
        }
        const stored: KeyValue[] = c.boxes.map(([k]) => [
          k,
          box(stripPrefix(k)),
        ]);
        expect(assemble(stored)).toEqual(c.object);
      });
    }
  });
});
