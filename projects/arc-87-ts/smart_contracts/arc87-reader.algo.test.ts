/**
 * Offline tests for the Algorand TypeScript `ARC87Reader` contract.
 *
 * Executed by `algorand-typescript-testing` (no localnet) against an `ARC87` store
 * created in the same test ledger: the reads return the store's box data through the
 * AVM 13 `app_box_*` shims of `tests/helpers/avm13-shims.ts`, `readUint64` decodes an
 * 8-byte leaf, slices are capped at the 1018 bytes that fit a readonly log, `maxValue`
 * reads the store's cap, `readPacked`/`sumPacked`/`readRecord` decode whole ARC-4
 * struct leaves of up to 4094 bytes, and missing boxes, bad ranges and leaves of the
 * wrong size fail with a descriptive assert.
 */
import { createHash } from "node:crypto";
import {
  type Account,
  Bytes,
  OnCompleteAction,
  Uint64,
  type uint64,
} from "@algorandfoundation/algorand-typescript";
import { TestExecutionContext } from "@algorandfoundation/algorand-typescript-testing";
import { MAX_STRUCT_SIZE, PREFIX } from "@algorandfoundation/arc87";
import { ABIType } from "algosdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetForeignBoxReads } from "../tests/helpers/avm13-shims";
import { ARC87 } from "./arc87.algo";
import { ARC87Reader } from "./arc87-reader.algo";

// --- ARC-4 fixtures -----------------------------------------------------------

const PACKED_TYPE = ABIType.from("(uint64,uint64)");
const RECORD_TYPE = ABIType.from("(uint64,string,byte[])");

/** `PackedValue { a, b }` encoded: 16 bytes. */
function encodePacked(a: bigint, b: bigint): Uint8Array {
  return PACKED_TYPE.encode([a, b]);
}

/**
 * `Record { id, tags, payload }` encoded to exactly `size` bytes: the head is
 * 8 (id) + 2 + 2 (offsets), each dynamic field adds a 2-byte length.
 */
function encodeRecord(
  size: number,
  id = 7n,
  tags = "struct,avm13",
): { bytes: Uint8Array; payload: Uint8Array } {
  const payloadLength = size - 16 - Buffer.byteLength(tags);
  const payload = new Uint8Array(payloadLength).map((_, i) => i % 251);
  const bytes = RECORD_TYPE.encode([id, tags, payload]);
  expect(bytes.length).toBe(size);
  return { bytes, payload };
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

describe("ARC87Reader contract", () => {
  const ctx = new TestExecutionContext();
  let store: ARC87;
  let storeId: uint64;
  let reader: ARC87Reader;

  /** Runs `body` inside an app-call group targeting `reader` with the given field overrides. */
  function inCall(
    overrides: { sender?: Account; rekeyTo?: Account },
    body: () => void,
  ): void {
    const txn = ctx.any.txn.applicationCall({
      appId: reader,
      onCompletion: OnCompleteAction.NoOp,
      ...overrides,
    });
    ctx.txn.createScope([txn]).execute(body);
  }

  beforeEach(() => {
    store = ctx.contract.create(ARC87);
    store.onCreate();
    storeId = ctx.ledger.getApplicationForContract(store).id;
    store.set("name", "cat");
    store.setBytes("count", Bytes.fromHex("000000000000002a")); // itob(42)
    reader = ctx.contract.create(ARC87Reader);
    reader.onCreate();
  });

  afterEach(() => {
    ctx.reset();
    resetForeignBoxReads();
  });

  it("reads the store's boxes directly", () => {
    expect(reader.readLength(storeId, "name")).toEqual(3);
    expect(reader.readBytes(storeId, "name", 0, 3).equals(Bytes("cat"))).toBe(
      true,
    );
    expect(reader.readBytes(storeId, "name", 1, 2).equals(Bytes("at"))).toBe(
      true,
    );
    expect(reader.readBytes(storeId, "name", 3, 0).length).toEqual(0);
    expect(reader.readUint64(storeId, "count")).toEqual(42);
    // The reader addresses the same `o_`-prefixed key the store writes.
    expect(ctx.ledger.boxExists(store, Bytes(`${PREFIX}count`))).toBe(true);
  });

  it("lets anyone read", () => {
    inCall({ sender: ctx.any.account() }, () => {
      expect(reader.readUint64(storeId, "count")).toEqual(42);
      expect(reader.readLength(storeId, "name")).toEqual(3);
    });
  });

  it("fails descriptively on missing paths, bad ranges and non-uint64 leaves", () => {
    for (const read of [
      () => reader.readLength(storeId, "missing"),
      () => reader.readBytes(storeId, "missing", 0, 1),
      () => reader.readUint64(storeId, "missing"),
    ]) {
      expect(read).toThrow("path not found in store");
    }
    expect(() => reader.readBytes(storeId, "name", 1, 3)).toThrow(
      "extract out of range",
    );
    expect(() => reader.readBytes(storeId, "name", 4, 0)).toThrow(
      "extract out of range",
    );
    expect(() => reader.readUint64(storeId, "name")).toThrow(
      "leaf is not a uint64",
    );
    // The size is checked before the value is read, so a leaf too large for
    // `app_box_get` fails with the same assert instead of an AVM size error.
    store.setBytes("big", Bytes(new Uint8Array(4094).fill(1)));
    store.concatBytes("big", Bytes(new Uint8Array(4094).fill(1)));
    expect(reader.readLength(storeId, "big")).toEqual(4094 * 2);
    expect(() => reader.readUint64(storeId, "big")).toThrow(
      "leaf is not a uint64",
    );
    // A store that does not exist is an AVM failure, not a contract assert.
    expect(() => reader.readLength(storeId + 1_000, "name")).toThrow();
  });

  it("caps readBytes at the 1018 bytes that fit a readonly log", () => {
    store.set("big", "a".repeat(4094));
    expect(reader.readBytes(storeId, "big", 0, 1018).length).toEqual(1018);
    expect(reader.readBytes(storeId, "big", 4094 - 1018, 1018).length).toEqual(
      1018,
    );
    expect(() => reader.readBytes(storeId, "big", 0, 1019)).toThrow(
      "slice exceeds 1018 bytes",
    );
    expect(() => reader.readBytes(storeId, "missing", 0, 1019)).toThrow(
      "slice exceeds 1018 bytes",
    );
  });

  // --- struct leaves -----------------------------------------------------------

  it("reads the store's maxValue cap", () => {
    expect(reader.maxValue(storeId)).toEqual(32_768);
    const capped = ctx.contract.create(ARC87);
    capped.create(Uint64(MAX_STRUCT_SIZE));
    const cappedId = ctx.ledger.getApplicationForContract(capped).id;
    expect(reader.maxValue(cappedId)).toEqual(Number(MAX_STRUCT_SIZE));
    // An application without the global (the reader itself) is not an ARC-87 store.
    const readerId = ctx.ledger.getApplicationForContract(reader).id;
    expect(() => reader.maxValue(readerId)).toThrow("store has no maxValue");
  });

  it("decodes a PackedValue leaf whole and works on its fields", () => {
    store.setBytes("packed", Bytes(encodePacked(40n, 2n)));
    const packed = reader.readPacked(storeId, "packed");
    expect(packed.a.asUint64()).toEqual(40);
    expect(packed.b.asUint64()).toEqual(2);
    expect(reader.sumPacked(storeId, "packed")).toEqual(42);
    // Any other size is not a PackedValue: the 8-byte `count` and the 3-byte `name`.
    expect(() => reader.readPacked(storeId, "count")).toThrow(
      "leaf is not a PackedValue",
    );
    expect(() => reader.sumPacked(storeId, "name")).toThrow(
      "leaf is not a PackedValue",
    );
    expect(() => reader.readPacked(storeId, "missing")).toThrow(
      "path not found in store",
    );
  });

  it("decodes a 4094-byte Record leaf whole and hashes its payload", () => {
    const { bytes, payload } = encodeRecord(Number(MAX_STRUCT_SIZE));
    store.setBytes("record", Bytes(bytes));
    expect(reader.readLength(storeId, "record")).toEqual(
      Number(MAX_STRUCT_SIZE),
    );
    const [id, length, digest] = reader.readRecord(storeId, "record");
    expect(id).toEqual(7);
    expect(length).toEqual(payload.length);
    expect(digest.equals(Bytes(sha256(payload)))).toBe(true);
  });

  it("refuses to load a leaf over 4094 bytes onto the stack", () => {
    const { bytes } = encodeRecord(Number(MAX_STRUCT_SIZE) + 1);
    // The default store accepts it (maxValue 32 KiB) — in two writes, since one
    // ABI argument carries at most 4094 bytes; the reader will not decode it.
    store.setBytes("record", Bytes(bytes.slice(0, Number(MAX_STRUCT_SIZE))));
    store.concatBytes("record", Bytes(bytes.slice(Number(MAX_STRUCT_SIZE))));
    expect(reader.readLength(storeId, "record")).toEqual(
      Number(MAX_STRUCT_SIZE) + 1,
    );
    expect(() => reader.readRecord(storeId, "record")).toThrow(
      "leaf exceeds 4094 bytes",
    );
    expect(() => reader.readPacked(storeId, "record")).toThrow(
      "leaf exceeds 4094 bytes",
    );
    // A 4094-byte leaf is loaded but is not a PackedValue.
    store.setBytes(
      "record",
      Bytes(encodeRecord(Number(MAX_STRUCT_SIZE)).bytes),
    );
    expect(() => reader.readPacked(storeId, "record")).toThrow(
      "leaf is not a PackedValue",
    );
    expect(() => reader.readRecord(storeId, "missing")).toThrow(
      "path not found in store",
    );
  });

  it("rejects rekeying on every method", () => {
    store.setBytes("packed", Bytes(encodePacked(1n, 2n)));
    const rekeyTo = ctx.any.account();
    for (const call of [
      () => reader.readLength(storeId, "name"),
      () => reader.readBytes(storeId, "name", 0, 1),
      () => reader.readUint64(storeId, "count"),
      () => reader.maxValue(storeId),
      () => reader.readPacked(storeId, "packed"),
      () => reader.sumPacked(storeId, "packed"),
      () => reader.readRecord(storeId, "packed"),
    ]) {
      inCall({ rekeyTo }, () => {
        expect(call).toThrow("rekey not allowed");
      });
    }
  });
});
