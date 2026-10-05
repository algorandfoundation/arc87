/**
 * Localnet integration tests for the Algorand TypeScript `ARC87Reader` contract.
 *
 * Opt-in (`npm run test:integration`): requires a running localnet
 * (`algokit localnet start`) and a prior `npm run build` for the typed clients.
 * Proves on the real AVM what the offline suite emulates: a consumer application
 * reads a sibling `ARC87` store's boxes directly with the AVM 13 `app_box_*`
 * opcodes (via `readonly` simulate and via a real send carrying the foreign
 * app, its box and the box I/O budget in the access list), decodes a `uint64`
 * leaf, caps the slices it returns through a log at 1018 bytes, reads a
 * store's `maxValue` cap, decodes whole ARC-4 struct leaves of up to 4094
 * bytes (`PackedValue`, a 4094-byte `Record`) with opcode budget to spare, and
 * fails with a descriptive assert on missing paths, bad ranges and leaves of
 * the wrong size — including leaves too large for `app_box_get`.
 */
import { createHash } from "node:crypto";
import { Config, microAlgo } from "@algorandfoundation/algokit-utils";
import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { ResourceReference } from "@algorandfoundation/algokit-utils/types/app-manager";
import {
  MAX_BOX_SIZE,
  MAX_STRUCT_SIZE,
  PREFIX,
} from "@algorandfoundation/arc87";
import { ABIType, type ABIValue, encodeUint64 } from "algosdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Arc87ReaderClient,
  Arc87ReaderFactory,
  APP_SPEC as READER_SPEC,
} from "../smart_contracts/arc87-reader.client.js";
import { accessRefsForBox, deploy } from "../src/deploy.js";
import { logicErrorMatcher } from "./helpers/logic-error.js";

Config.configure({ debug: false });

/** Asserts that `promise` is rejected by the reader at the `assert` carrying `message`. */
const expectReaderError = logicErrorMatcher(READER_SPEC);

/** Largest slice that fits the 1024-byte log cap (4-byte prefix + 2-byte length). */
const MAX_EXTRACT = 1018;

/** Opcode budget of a single application call. */
const CALL_BUDGET = 700;

// --- ARC-4 fixtures -----------------------------------------------------------

const PACKED_TYPE = ABIType.from("(uint64,uint64)");
const RECORD_TYPE = ABIType.from("(uint64,string,byte[])");

/**
 * `Record { id, tags, payload }` encoded to exactly `size` bytes: the head is
 * 8 (id) + 2 + 2 (offsets), each dynamic field adds a 2-byte length.
 */
function encodeRecord(
  size: number,
  id = 7n,
  tags = "struct,avm13",
): { bytes: Uint8Array; payload: Uint8Array } {
  const payload = new Uint8Array(size - 16 - Buffer.byteLength(tags)).map(
    (_, i) => i % 251,
  );
  const bytes = RECORD_TYPE.encode([id, tags, payload]);
  expect(bytes.length).toBe(size);
  return { bytes, payload };
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

const PACKED = PACKED_TYPE.encode([40n, 2n]);
const RECORD = encodeRecord(Number(MAX_STRUCT_SIZE));
const OVERSIZED = encodeRecord(Number(MAX_STRUCT_SIZE) + 1);

describe("ARC87Reader contract (localnet)", () => {
  const fixture = algorandFixture();
  const count = encodeUint64(42);
  // 3000 bytes of text: more than one 2 KiB box I/O reference, more than fits
  // in one readonly return; 4100 bytes: more than `app_box_get` can load at all.
  const text = "t".repeat(3_000);
  const big = "b".repeat(4_100);
  // `over`: one byte past the struct ceiling, allowed by the default 32 KiB cap.
  const stored = { count, text, big, name: "cat", over: OVERSIZED.bytes };
  // A store capped at MAX_STRUCT_SIZE: every leaf is stack-decodable.
  const capped = { packed: PACKED, record: RECORD.bytes };
  let storeId: bigint;
  let cappedId: bigint;
  let reader: Arc87ReaderClient;

  beforeAll(async () => {
    await fixture.newScope();
    const { algorand, testAccount } = fixture.context;
    storeId = await deploy(algorand, testAccount, "arc87-reader-store", stored);
    cappedId = await deploy(
      algorand,
      testAccount,
      "arc87-reader-capped",
      capped,
      { maxValue: Number(MAX_STRUCT_SIZE) },
    );
    const factory = algorand.client.getTypedAppFactory(Arc87ReaderFactory, {
      defaultSender: testAccount.addr,
      defaultSigner: testAccount.signer,
    });
    ({ appClient: reader } = await factory.send.create.bare());
  });

  function key(path: string): string {
    return `${PREFIX}${path}`;
  }

  /**
   * Access list of a real (non-simulated) reader call touching the store's box
   * `path` of `size` bytes: the store itself, the foreign box and the I/O budget
   * entries `accessRefsForBox` adds for the box size.
   */
  function foreignAccess(
    path: string,
    size: number,
    store = storeId,
  ): ResourceReference[] {
    return [
      { appId: store },
      ...(accessRefsForBox(key(path), size, store) as ResourceReference[]),
    ];
  }

  it("decodes a uint64 leaf of the store via readonly simulate", async () => {
    const { return: value } = await reader.send.readUint64({
      args: { store: storeId, path: "count" },
    });
    expect(value).toBe(42n);
  });

  it("matches the algod box API for readBytes and readLength", async () => {
    const { algorand } = fixture.context;
    const box = await algorand.app.getBoxValue(storeId, key("text"));
    expect(box.length).toBe(text.length);
    expect(
      (await reader.send.readLength({ args: { store: storeId, path: "text" } }))
        .return,
    ).toBe(BigInt(box.length));
    const offset = box.length - MAX_EXTRACT;
    const { return: tail } = await reader.send.readBytes({
      args: { store: storeId, path: "text", offset, length: MAX_EXTRACT },
    });
    expect(tail).toEqual(box.slice(offset));
    const { return: head } = await reader.send.readBytes({
      args: { store: storeId, path: "name", offset: 0, length: 3 },
    });
    expect(new TextDecoder().decode(head)).toBe("cat");
  });

  it("reads through a real send with the store, its box and the I/O budget in the access list", async () => {
    const { algorand, testAccount } = fixture.context;
    const box = await algorand.app.getBoxValue(storeId, key("text"));
    // `readonly` methods are always simulated by the typed client; a real
    // transaction is built from the ABI method instead, with resources supplied
    // explicitly (no simulate ahead of the send).
    const send = (
      method: string,
      args: ABIValue[],
      path: string,
      size: number,
    ) =>
      algorand.send.appCallMethodCall({
        sender: testAccount.addr,
        signer: testAccount.signer,
        appId: reader.appId,
        method: reader.appClient.getABIMethod(method),
        args,
        accessReferences: foreignAccess(path, size),
        populateAppCallResources: false,
        note: `${method}:${path}`,
      });
    const typed = await send("readUint64", [storeId, "count"], "count", 8);
    expect(typed.return?.returnValue).toBe(42n);
    const length = await send(
      "readLength",
      [storeId, "text"],
      "text",
      box.length,
    );
    expect(length.return?.returnValue).toBe(BigInt(box.length));
    const slice = await send(
      "readBytes",
      [storeId, "text", 0, MAX_EXTRACT],
      "text",
      box.length,
    );
    expect(slice.return?.returnValue).toEqual(box.slice(0, MAX_EXTRACT));
    // The box I/O budget is charged at the full box size: one reference is not
    // enough for the 3000-byte box however small the slice
    // (algod: "read budget exceeded (3000 > 2048)").
    await expect(
      algorand.send.appCallMethodCall({
        sender: testAccount.addr,
        signer: testAccount.signer,
        appId: reader.appId,
        method: reader.appClient.getABIMethod("readLength"),
        args: [storeId, "text"],
        accessReferences: [
          { appId: storeId },
          { box: { appId: storeId, name: key("text") } },
        ],
        populateAppCallResources: false,
      }),
    ).rejects.toThrow("read budget exceeded");
  });

  it("fails descriptively on missing paths, bad ranges and non-uint64 leaves", async () => {
    await expectReaderError(
      reader.send.readLength({ args: { store: storeId, path: "missing" } }),
      "path not found in store",
    );
    await expectReaderError(
      reader.send.readUint64({ args: { store: storeId, path: "missing" } }),
      "path not found in store",
    );
    await expectReaderError(
      reader.send.readBytes({
        args: { store: storeId, path: "name", offset: 1, length: 3 },
      }),
      "extract out of range",
    );
    await expectReaderError(
      reader.send.readUint64({ args: { store: storeId, path: "name" } }),
      "leaf is not a uint64",
    );
    // The size is checked before the value is read: a leaf too large for
    // `app_box_get` ("box_get produced a too big ... byte-array") fails with the
    // same assert as any other non-uint64 leaf.
    expect(
      (await reader.send.readLength({ args: { store: storeId, path: "big" } }))
        .return,
    ).toBe(BigInt(big.length));
    await expectReaderError(
      reader.send.readUint64({ args: { store: storeId, path: "big" } }),
      "leaf is not a uint64",
    );
  });

  it("caps readBytes at the 1018 bytes that fit a readonly log", async () => {
    const { algorand } = fixture.context;
    const box = await algorand.app.getBoxValue(storeId, key("big"));
    const { return: head } = await reader.send.readBytes({
      args: { store: storeId, path: "big", offset: 0, length: MAX_EXTRACT },
    });
    expect(head).toEqual(box.slice(0, MAX_EXTRACT));
    await expectReaderError(
      reader.send.readBytes({
        args: {
          store: storeId,
          path: "big",
          offset: 0,
          length: MAX_EXTRACT + 1,
        },
      }),
      "slice exceeds 1018 bytes",
    );
  });

  it("relies on the store's foreign box reads, which are on from create with no toggle", async () => {
    const { algorand } = fixture.context;
    const params = (
      await algorand.client.algod.getApplicationByID(storeId).do()
    ).params;
    expect(params?.foreignBoxReads).toBe(true);
    // Nothing in the store's ABI can clear the flag, so a consumer never needs
    // an inner-call fallback: every reader method is a direct `app_box_*` read.
    expect(READER_SPEC.methods.every((m) => m.readonly === true)).toBe(true);
    expect(READER_SPEC.methods.map((m) => m.name).sort()).toEqual([
      "maxValue",
      "readBytes",
      "readLength",
      "readPacked",
      "readRecord",
      "readUint64",
      "sumPacked",
    ]);
  });

  // --- struct leaves -----------------------------------------------------------

  it("reads the maxValue cap of a store with app_global_get_ex", async () => {
    expect(
      (await reader.send.maxValue({ args: { store: cappedId } })).return,
    ).toBe(MAX_STRUCT_SIZE);
    expect(
      (await reader.send.maxValue({ args: { store: storeId } })).return,
    ).toBe(MAX_BOX_SIZE);
    // The reader itself has no `maxValue` global: it is not an ARC-87 store.
    await expectReaderError(
      reader.send.maxValue({ args: { store: reader.appId } }),
      "store has no maxValue",
    );
  });

  it("decodes a PackedValue leaf whole and sums its fields", async () => {
    const { return: packed } = await reader.send.readPacked({
      args: { store: cappedId, path: "packed" },
    });
    expect(packed).toEqual({ a: 40n, b: 2n });
    expect(
      (
        await reader.send.sumPacked({
          args: { store: cappedId, path: "packed" },
        })
      ).return,
    ).toBe(42n);
    await expectReaderError(
      reader.send.readPacked({ args: { store: cappedId, path: "record" } }),
      "leaf is not a PackedValue",
    );
    await expectReaderError(
      reader.send.sumPacked({ args: { store: storeId, path: "count" } }),
      "leaf is not a PackedValue",
    );
    await expectReaderError(
      reader.send.readPacked({ args: { store: cappedId, path: "missing" } }),
      "path not found in store",
    );
  });

  it("decodes a 4094-byte Record leaf whole with opcode budget to spare", async () => {
    const { algorand } = fixture.context;
    expect(
      (await algorand.app.getBoxValue(cappedId, key("record"))).length,
    ).toBe(Number(MAX_STRUCT_SIZE));
    const expected = [
      7n,
      BigInt(RECORD.payload.length),
      sha256(RECORD.payload),
    ];
    const { return: record } = await reader.send.readRecord({
      args: { store: cappedId, path: "record" },
    });
    expect(record).toEqual(expected);

    // `app_box_get` of the whole leaf + ARC-4 decode + `sha256` + re-encoding
    // the 48-byte result: measured once here, recorded in docs/avm-limits.md.
    const simulated = await reader
      .newGroup()
      .readRecord({ args: { store: cappedId, path: "record" } })
      .simulate({ allowUnnamedResources: true, skipSignatures: true });
    const budget = simulated.simulateResponse.txnGroups[0]?.appBudgetConsumed;
    expect(budget).toBeDefined();
    expect(Number(budget)).toBeLessThan(CALL_BUDGET);
    console.info(
      `readRecord(4094-byte leaf): budgetConsumed = ${budget} / ${CALL_BUDGET}`,
    );
  });

  it("decodes the Record through a real send with the store, its box and the I/O budget", async () => {
    const { algorand, testAccount } = fixture.context;
    // ceil(4094 / 2048) = 2 box I/O references + the store app: 3 entries.
    const access = foreignAccess("record", Number(MAX_STRUCT_SIZE), cappedId);
    expect(access).toHaveLength(3);
    const result = await algorand.send.appCallMethodCall({
      sender: testAccount.addr,
      signer: testAccount.signer,
      appId: reader.appId,
      method: reader.appClient.getABIMethod("readRecord"),
      args: [cappedId, "record"],
      accessReferences: access,
      populateAppCallResources: false,
    });
    expect(result.return?.returnValue).toEqual([
      7n,
      BigInt(RECORD.payload.length),
      sha256(RECORD.payload),
    ]);
    const packed = await algorand.send.appCallMethodCall({
      sender: testAccount.addr,
      signer: testAccount.signer,
      appId: reader.appId,
      method: reader.appClient.getABIMethod("sumPacked"),
      args: [cappedId, "packed"],
      accessReferences: foreignAccess("packed", PACKED.length, cappedId),
      populateAppCallResources: false,
    });
    expect(packed.return?.returnValue).toBe(42n);
  });

  it("refuses to load a 4095-byte leaf onto the stack", async () => {
    const { algorand } = fixture.context;
    expect((await algorand.app.getBoxValue(storeId, key("over"))).length).toBe(
      Number(MAX_STRUCT_SIZE) + 1,
    );
    // Guarded by `app_box_len` first, so the failure is the contract's assert
    // and not the AVM's `box_get produced a too big byte-array`.
    await expectReaderError(
      reader.send.readRecord({ args: { store: storeId, path: "over" } }),
      "leaf exceeds 4094 bytes",
    );
    await expectReaderError(
      reader.send.readPacked({ args: { store: storeId, path: "over" } }),
      "leaf exceeds 4094 bytes",
    );
    // The capped store could never hold such a leaf in the first place.
    await expectReaderError(
      reader.send.readRecord({ args: { store: cappedId, path: "over" } }),
      "path not found in store",
    );
  });

  it("lets a stranger read through the reader", async () => {
    const other = await fixture.context.generateAccount({
      initialFunds: microAlgo(1_000_000),
    });
    const stranger = { sender: other.addr, signer: other.signer };
    expect(
      (
        await reader.send.readUint64({
          args: { store: storeId, path: "count" },
          ...stranger,
        })
      ).return,
    ).toBe(42n);
    expect(
      (
        await reader.send.readBytes({
          args: { store: storeId, path: "name", offset: 0, length: 3 },
          ...stranger,
        })
      ).return,
    ).toEqual(new TextEncoder().encode("cat"));
  });
});
