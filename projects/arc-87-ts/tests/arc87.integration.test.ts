/**
 * Localnet integration tests for the Algorand TypeScript `ARC87` contract.
 *
 * Opt-in (`npm run test:integration`): requires a running localnet
 * (`algokit localnet start`) and a prior `npm run build` for the typed client.
 * Proves on the real AVM what the offline suite emulates: the demo `deploy()`
 * round-trips a conformance vector through `fromBoxes`, the `length`/`extract`
 * reads are public (`readonly` simulate, slices capped at 1018 bytes) while
 * writes stay creator-only, the AVM 13 `AppForeignBoxReads` flag is set on
 * create with no method to turn it off, large values are chunked either at the
 * flat fee (2 KiB) or with the consensus v42 per-byte surcharge (`chunkSize`
 * up to 16 KiB), `Uint8Array` leaves round-trip through `setBytes`/
 * `concatBytes`, the `maxValue` global is fixed at create (32 KiB by the bare
 * create, custom via `deploy({ maxValue })` → `create(uint64)`) and enforced on
 * every write, and every hardening rule (no rekey, update gate, reclaim guards,
 * deletable) is enforced with its descriptive assert message.
 */
import { readFileSync } from "node:fs";
import { algo, Config, microAlgo } from "@algorandfoundation/algokit-utils";
import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import {
  byteLength,
  chunkValue,
  fromBoxes,
  type KeyValue,
  MAX_ABI_SIZE,
  MAX_ARG_SIZE,
  MAX_BOX_SIZE,
  MAX_STRUCT_SIZE,
  MaxSizeError,
  PREFIX,
  stripPrefix,
  surchargeFor,
  toBoxes,
  toMBR,
} from "@algorandfoundation/arc87";
import { encodeUint64 } from "algosdk";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_SPEC, Arc87Client } from "../smart_contracts/client.js";
import {
  ABI_OVERHEAD,
  accessRefsForBox,
  deploy,
  MAX_VALUE_ARG,
} from "../src/deploy.js";
import { logicErrorMatcher } from "./helpers/logic-error.js";

Config.configure({ debug: false });

type PathsVectors = {
  cases: { name: string; object: unknown; keys: string[] }[];
};

const PATHS = JSON.parse(
  readFileSync(
    new URL("../../conformance/vectors/paths.json", import.meta.url),
    "utf8",
  ),
) as PathsVectors;

/** The vector exercising escaped segments, arrays and nested objects. */
const ESCAPED = PATHS.cases.find((c) =>
  c.name.startsWith("segments with reserved characters"),
);
if (!ESCAPED) throw new Error("paths.json: escaping vector not found");

/** Fee for the outer call plus the zero-fee inner payment of `reclaim`. */
const RECLAIM_FEE = microAlgo(2_000);

/** Largest `extract` slice that fits the 1024-byte log cap (4-byte prefix + 2-byte length). */
const MAX_EXTRACT = 1018;

/**
 * Fees `deploy()` pays for `obj` beyond the MBR it funds: the create and the
 * funding payment at the minimum fee, plus one call per chunk at
 * `minFee + surchargeFor(encoded arguments)` — the exact amounts the deployer
 * computes, mirrored here from the library primitives.
 */
function expectedDeployFees(
  obj: unknown,
  chunkSize: number,
  minFee: bigint,
): { calls: number; fees: bigint } {
  let calls = 0;
  let fees = 2n * minFee;
  for (const [key, value] of toBoxes(obj)) {
    const path = stripPrefix(key);
    const budget = Math.min(
      chunkSize - ABI_OVERHEAD - byteLength(path),
      MAX_VALUE_ARG,
    );
    const chunks =
      byteLength(value) > budget ? chunkValue(value, budget) : [value];
    for (const chunk of chunks) {
      calls++;
      const encoded = ABI_OVERHEAD + byteLength(path) + byteLength(chunk);
      fees += minFee + surchargeFor(encoded, minFee);
    }
  }
  return { calls, fees };
}

/** Asserts that `promise` is rejected by the store at the `assert` carrying `message`. */
const expectLogicError = logicErrorMatcher(APP_SPEC);

describe("ARC87 contract (localnet)", () => {
  const fixture = algorandFixture();
  let appId: bigint;
  let client: Arc87Client;

  beforeAll(async () => {
    await fixture.newScope();
    const { algorand, testAccount } = fixture.context;
    appId = await deploy(algorand, testAccount, "arc87-it", ESCAPED.object);
    client = algorand.client.getTypedAppClientById(Arc87Client, {
      appId,
      defaultSender: testAccount.addr,
      defaultSigner: testAccount.signer,
    });
  });

  function box(path: string): KeyValue[0] {
    return `${PREFIX}${path}`;
  }

  it("deploys and round-trips a conformance vector through fromBoxes", async () => {
    const { algorand } = fixture.context;
    const names = (await algorand.app.getBoxNames(appId))
      .map((n) => n.name)
      .sort();
    expect(names).toEqual([...ESCAPED.keys].sort());
    expect(await fromBoxes(algorand, appId)).toEqual(ESCAPED.object);
  });

  it("writes values larger than one ABI call with set + concat", async () => {
    const { algorand, testAccount } = fixture.context;
    // Two chunks: `set` + `concat`. `concat` uses box.resize/replace so the combined
    // value is not limited by the 4096-byte AVM stack; only MAX_BOX_SIZE applies.
    // The multi-byte text (3000 bytes of "é", 2 bytes each) straddles the chunk
    // boundary: chunks are cut at code points so each ABI `string` stays valid UTF-8.
    const big = {
      blob: "x".repeat(Number(MAX_ABI_SIZE) + 1_000),
      txt: "é".repeat(1_500),
    };
    const bigAppId = await deploy(algorand, testAccount, "arc87-it-big", big);
    expect(await fromBoxes(algorand, bigAppId)).toEqual(big);
    expect(
      (await algorand.app.getBoxValue(bigAppId, `${PREFIX}txt`)).length,
    ).toBe(3_000);
  });

  it("stores Uint8Array leaves with setBytes/concatBytes and reads them back as binary", async () => {
    const { algorand, testAccount } = fixture.context;
    const count = encodeUint64(42);
    // 3000 random bytes: `setBytes` + one `concatBytes` chunk at the default chunk size.
    const raw = Uint8Array.from({ length: 3_000 }, (_, i) => (i * 7919) & 0xff);
    const obj = { count, raw, name: "cat", n: 7 };
    const bytesAppId = await deploy(
      algorand,
      testAccount,
      "arc87-it-bytes",
      obj,
    );
    expect(
      await algorand.app.getBoxValue(bytesAppId, `${PREFIX}count`),
    ).toEqual(count);
    expect(await algorand.app.getBoxValue(bytesAppId, `${PREFIX}raw`)).toEqual(
      raw,
    );
    const typed = await fromBoxes<typeof obj>(algorand, bytesAppId, {
      binary: ["count", "raw"],
    });
    expect(typed).toEqual(obj);
    expect(typed.count).toBeInstanceOf(Uint8Array);
    // Without the filter every leaf is text: the 8-byte leaf is reinterpreted.
    const text = await fromBoxes<{ count: unknown }>(algorand, bytesAppId);
    expect(typeof text.count).toBe("string");
    // On-chain, a small ARC-4 leaf is read in full with `length` + `extract`.
    const bytesClient = algorand.client.getTypedAppClientById(Arc87Client, {
      appId: bytesAppId,
      defaultSender: testAccount.addr,
      defaultSigner: testAccount.signer,
    });
    const { return: size } = await bytesClient.send.length({
      args: { path: "count" },
    });
    expect(size).toBe(8n);
    const { return: onChain } = await bytesClient.send.extract({
      args: { path: "count", offset: 0, length: size ?? 0n },
    });
    expect(onChain).toEqual(count);
    expect(new DataView(count.buffer).getBigUint64(0)).toBe(42n);
  });

  it("validates chunkSize before touching the network", async () => {
    const { algorand, testAccount } = fixture.context;
    for (const chunkSize of [0, 72, 1.5, Number(MAX_ARG_SIZE) + 1, -1]) {
      await expect(
        deploy(algorand, testAccount, "arc87-it-bad", { a: 1 }, { chunkSize }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("stores a full 32 KiB box value via chunked set + concat", async () => {
    const { algorand, testAccount } = fixture.context;
    // Exactly MAX_BOX_SIZE bytes, written as many ABI-sized chunks. fromBoxes
    // reads boxes via algod (not an ABI return), so the round-trip is not
    // subject to the AVM stack limit. A 32 KiB box alone needs ~13.2 Algo of MBR,
    // so top up the shared test account before deploying.
    const blob = "y".repeat(Number(MAX_BOX_SIZE));
    const full = { blob };
    const mbr = toMBR(full);
    await algorand.account.ensureFunded(
      testAccount,
      await algorand.account.localNetDispenser(),
      // MBR + create/fund fees + ~16 chunked app calls with headroom
      microAlgo(mbr + 2_000_000n),
    );
    expect(mbr).toBeGreaterThan(algo(13).microAlgo);
    const minFee = BigInt((await algorand.getSuggestedParams()).minFee);
    const balance = async () =>
      (await algorand.account.getInformation(testAccount.addr)).balance
        .microAlgo;
    // Default: chunks of ≤ 2 KiB encoded arguments (2036 value bytes next to the
    // 4-byte path), i.e. 17 calls, every one at the flat minimum fee (no
    // surcharge). The deployer's spend is the MBR it funds plus the fees of
    // create, funding payment and the 17 calls — nothing else.
    const flat = expectedDeployFees(full, Number(MAX_ABI_SIZE), minFee);
    const valueBytes = Number(MAX_ABI_SIZE) - ABI_OVERHEAD - "blob".length;
    expect(flat.calls).toBe(Math.ceil(Number(MAX_BOX_SIZE) / valueBytes));
    expect(flat.calls).toBe(17);
    expect(flat.fees).toBe(19n * minFee);
    const before = await balance();
    const fullAppId = await deploy(
      algorand,
      testAccount,
      "arc87-it-32kib",
      full,
    );
    expect(before - (await balance())).toBe(mbr + flat.fees);
    const names = await algorand.app.getBoxNames(fullAppId);
    expect(names.map((n) => n.name)).toEqual([`${PREFIX}blob`]);
    const value = await algorand.app.getBoxValue(fullAppId, `${PREFIX}blob`);
    expect(value.length).toBe(Number(MAX_BOX_SIZE));
    expect(await fromBoxes(algorand, fullAppId)).toEqual(full);

    // The readonly reads run as a simulate (no box references or fee needed) and
    // can slice the tail of the 32 KiB box up to the log cap, which `extract`
    // enforces itself; the full value is only reachable via algod (`fromBoxes`)
    // or, from another contract, a loop of `app_box_extract` calls.
    const fullClient = algorand.client.getTypedAppClientById(Arc87Client, {
      appId: fullAppId,
      defaultSender: testAccount.addr,
      defaultSigner: testAccount.signer,
    });
    expect(
      (await fullClient.send.length({ args: { path: "blob" } })).return,
    ).toBe(MAX_BOX_SIZE);
    const offset = Number(MAX_BOX_SIZE) - MAX_EXTRACT;
    const tail = await fullClient.send.extract({
      args: { path: "blob", offset, length: MAX_EXTRACT },
    });
    expect(tail.return).toEqual(value.slice(offset));
    await expectLogicError(
      fullClient.send.extract({
        args: { path: "blob", offset: offset + 1, length: MAX_EXTRACT },
      }),
      "extract out of range",
    );
    await expectLogicError(
      fullClient.send.extract({
        args: { path: "blob", offset: 0, length: MAX_EXTRACT + 1 },
      }),
      "slice exceeds 1018 bytes",
    );
  });

  it("writes 32 KiB in 9 surcharged calls with chunkSize: 16384", async () => {
    const { algorand, testAccount } = fixture.context;
    const full = { blob: "z".repeat(Number(MAX_BOX_SIZE)) };
    const mbr = toMBR(full);
    await algorand.account.ensureFunded(
      testAccount,
      await algorand.account.localNetDispenser(),
      microAlgo(mbr + 2_000_000n),
    );
    const minFee = BigInt((await algorand.getSuggestedParams()).minFee);
    const balance = async () =>
      (await algorand.account.getInformation(testAccount.addr)).balance
        .microAlgo;
    // The 16 KiB *total* argument budget cannot be used by a single `value`
    // argument: algod caps every application argument at MAX_AVM_BYTES (4096,
    // `tx.ApplicationArgs[2] length is too long`), so each chunk carries 4094
    // value bytes → 8 full chunks (4106 encoded bytes, surcharged 206 µALGO
    // each) plus a 16-byte remainder at the flat fee: 9 calls instead of 17.
    const chunkSize = Number(MAX_ARG_SIZE);
    const surcharged = expectedDeployFees(full, chunkSize, minFee);
    expect(surcharged.calls).toBe(
      Math.ceil(Number(MAX_BOX_SIZE) / MAX_VALUE_ARG),
    );
    expect(surcharged.calls).toBe(9);
    const encodedFull = ABI_OVERHEAD + "blob".length + MAX_VALUE_ARG;
    expect(surchargeFor(encodedFull, minFee)).toBe(206n);
    expect(surcharged.fees).toBe(
      11n * minFee + 8n * surchargeFor(encodedFull, minFee),
    );
    const before = await balance();
    const appId16 = await deploy(
      algorand,
      testAccount,
      "arc87-it-16kib",
      full,
      {
        chunkSize,
      },
    );
    expect(before - (await balance())).toBe(mbr + surcharged.fees);
    expect(await fromBoxes(algorand, appId16)).toEqual(full);
  });

  it("rejects a surcharged call paying one µALGO less than surchargeFor", async () => {
    const { algorand, testAccount } = fixture.context;
    const minFee = BigInt((await algorand.getSuggestedParams()).minFee);
    const path = "fee";
    const key = box(path);
    // 63 bytes over the flat budget → 6.3 µALGO, rounded up to 7 by algod.
    const value = "f".repeat(
      Number(MAX_ABI_SIZE) + 63 - ABI_OVERHEAD - path.length,
    );
    const encoded = ABI_OVERHEAD + path.length + value.length;
    expect(encoded).toBe(Number(MAX_ABI_SIZE) + 63);
    const surcharge = surchargeFor(encoded, minFee);
    expect(surcharge).toBe(7n);
    await client.appClient.fundAppAccount({ amount: microAlgo(1_000_000) });
    // Resources are supplied explicitly so no simulate runs ahead of the send:
    // the fee is checked by algod's transaction pool exactly as for `deploy()`.
    const params = {
      args: { path, value },
      accessReferences: accessRefsForBox(key, value.length),
      sender: testAccount.addr,
      signer: testAccount.signer,
      populateAppCallResources: false,
    };
    const tooLow = await client.send
      .set({ ...params, staticFee: microAlgo(minFee + surcharge - 1n) })
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    expect(tooLow).toBeInstanceOf(Error);
    // algod: "txgroup with 1.006mA fees is less than 1.007mA (usage=1.006300 * base=1mA)"
    expect(tooLow?.message).toContain("fees is less than");
    expect(await algorand.app.getBoxNames(appId)).not.toContainEqual(
      expect.objectContaining({ name: key }),
    );
    // The exact amount is accepted.
    await client.send.set({
      ...params,
      staticFee: microAlgo(minFee + surcharge),
    });
    expect(await algorand.app.getBoxValue(appId, key)).toEqual(
      new TextEncoder().encode(value),
    );
    await client.send.remove({ args: { path }, boxReferences: [key] });
  });

  it("is deployed as updatable: false, deletable: true", async () => {
    const info = await fixture.context.algorand.app.getById(appId);
    expect(info.creator.toString()).toBe(
      fixture.context.testAccount.addr.toString(),
    );
    const [key, expected] = toBoxes(ESCAPED.object)[0];
    const path = stripPrefix(key);
    const { return: size } = await client.send.length({
      args: { path },
      boxReferences: [key],
    });
    const { return: value } = await client.send.extract({
      args: { path, offset: 0, length: size ?? 0n },
      boxReferences: [key],
    });
    expect(new TextDecoder().decode(value)).toBe(expected);
  });

  it("rejects an app call that rekeys the sender", async () => {
    const { testAccount, generateAccount } = fixture.context;
    const other = await generateAccount({ initialFunds: microAlgo(0) });
    const key = box("a");
    await expectLogicError(
      client.send.set({
        args: { path: "a", value: "rekeyed" },
        boxReferences: [key],
        rekeyTo: other.addr,
      }),
      "rekey not allowed",
    );
    // The sender is still in control of its own account
    const info = await fixture.context.algorand.account.getInformation(
      testAccount.addr,
    );
    expect(info.authAddr).toBeUndefined();
  });

  it("lets anyone read but rejects writes from anyone but the creator", async () => {
    const other = await fixture.context.generateAccount({
      initialFunds: microAlgo(1_000_000),
    });
    const path = "x.${c[0]}";
    const key = box(path);
    const expected = toBoxes(ESCAPED.object).find(([k]) => k === key)?.[1];
    expect(expected).toBeDefined();
    const stranger = { sender: other.addr, signer: other.signer };
    const raw = new TextEncoder().encode(expected as string);

    const { return: size } = await client.send.length({
      args: { path },
      ...stranger,
    });
    expect(size).toBe(BigInt(raw.length));
    const { return: whole } = await client.send.extract({
      args: { path, offset: 0, length: size ?? 0n },
      ...stranger,
    });
    expect(whole).toEqual(raw);
    const { return: slice } = await client.send.extract({
      args: { path, offset: 0, length: 1 },
      ...stranger,
    });
    expect(slice).toEqual(raw.slice(0, 1));

    await expectLogicError(
      client.send.remove({ args: { path }, boxReferences: [key], ...stranger }),
      "creator only",
    );
    await expectLogicError(
      client.send.setBytes({
        args: { path: "evil", value: new Uint8Array([1]) },
        boxReferences: [box("evil")],
        ...stranger,
      }),
      "creator only",
    );
    expect(await fromBoxes(fixture.context.algorand, appId)).toEqual(
      ESCAPED.object,
    );
  });

  it("stores raw bytes with setBytes/concatBytes and reads them back with extract", async () => {
    const raw = new Uint8Array([0xff, 0x00, 0xfe]);
    const key = box("bin");
    // `deploy()` funded the MBR of the vector object only; the extra box needs more.
    await client.appClient.fundAppAccount({ amount: microAlgo(100_000) });
    await client.send.setBytes({
      args: { path: "bin", value: raw },
      boxReferences: [key],
    });
    await client.send.concatBytes({
      args: { path: "bin", value: new Uint8Array([0x01]) },
      boxReferences: [key],
    });
    const stored = await fixture.context.algorand.app.getBoxValue(appId, key);
    expect(stored).toEqual(new Uint8Array([0xff, 0x00, 0xfe, 0x01]));
    expect(
      (
        await client.send.extract({
          args: { path: "bin", offset: 0, length: stored.length },
        })
      ).return,
    ).toEqual(stored);
    await client.send.remove({ args: { path: "bin" }, boxReferences: [key] });
  });

  it("enables foreign box reads on create, with no method to turn them off", async () => {
    const { algorand } = fixture.context;
    // algod omits the field when it is false.
    const flag = async () =>
      (await algorand.client.algod.getApplicationByID(appId).do()).params
        ?.foreignBoxReads ?? false;
    expect(await flag()).toBe(true);
    expect(APP_SPEC.methods.map((m) => m.name)).not.toContain(
      "setForeignReads",
    );
  });

  /** The `maxValue` global of `id` as algod reports it (what `app_global_get_ex` returns on-chain). */
  async function maxValueOf(id: bigint): Promise<bigint> {
    const state = await fixture.context.algorand.app.getGlobalState(id);
    const entry = state.maxValue;
    expect(entry).toBeDefined();
    return BigInt(entry?.value as bigint | number);
  }

  it("fixes maxValue at 32 KiB on the default (bare) create", async () => {
    expect(await maxValueOf(appId)).toBe(MAX_BOX_SIZE);
    const spec = APP_SPEC as unknown as {
      state: { schema: { global: { ints: number } } };
      bareActions: { create: string[] };
    };
    expect(spec.state.schema.global.ints).toBe(1);
    expect(spec.bareActions.create).toEqual(["NoOp"]);
    expect(APP_SPEC.methods.map((m) => m.name)).not.toContain("setMaxValue");
  });

  it("deploys a capped store through create(uint64) and enforces maxValue on chain", async () => {
    const { algorand, testAccount } = fixture.context;
    const path = "rec";
    const key = box(path);
    const leaf = new Uint8Array(Number(MAX_STRUCT_SIZE)).fill(0xab);
    const minFee = BigInt((await algorand.getSuggestedParams()).minFee);
    await algorand.account.ensureFunded(
      testAccount,
      await algorand.account.localNetDispenser(),
      microAlgo(toMBR({ [path]: leaf }) + 2_000_000n),
    );
    // One surcharged call carries the whole 4094-byte leaf: 8 + 3 + 4094 = 4105
    // encoded bytes, 2057 over the flat budget → 206 µALGO.
    const chunkSize = ABI_OVERHEAD + byteLength(path) + MAX_VALUE_ARG;
    const planned = expectedDeployFees({ [path]: leaf }, chunkSize, minFee);
    expect(planned.calls).toBe(1);
    expect(planned.fees).toBe(3n * minFee + surchargeFor(chunkSize, minFee));
    expect(surchargeFor(chunkSize, minFee)).toBe(206n);
    const account = async () => {
      const info = await algorand.account.getInformation(testAccount.addr);
      return {
        balance: info.balance.microAlgo,
        minBalance: info.minBalance.microAlgo,
      };
    };
    const before = await account();
    const cappedId = await deploy(
      algorand,
      testAccount,
      "arc87-it-capped",
      { [path]: leaf },
      { chunkSize, maxValue: Number(MAX_STRUCT_SIZE) },
    );
    const after = await account();
    expect(before.balance - after.balance).toBe(
      toMBR({ [path]: leaf }) + planned.fees,
    );
    // The global uint raises the *creator's* minimum balance (28 500 µALGO on
    // top of the 100 000 per created app), not the app account's box MBR.
    expect(after.minBalance - before.minBalance).toBe(128_500n);
    expect(await maxValueOf(cappedId)).toBe(MAX_STRUCT_SIZE);
    expect(
      (await algorand.client.algod.getApplicationByID(cappedId).do()).params
        ?.foreignBoxReads,
    ).toBe(true);
    expect(await fromBoxes(algorand, cappedId, { binary: [path] })).toEqual({
      [path]: leaf,
    });

    const capped = algorand.client.getTypedAppClientById(Arc87Client, {
      appId: cappedId,
      defaultSender: testAccount.addr,
      defaultSigner: testAccount.signer,
    });
    // A single argument can never exceed 4096 bytes (algod rejects it before
    // the program runs), so the cap is crossed on chain by appending: one more
    // byte than the cap fails for bytes and text alike.
    const refs = accessRefsForBox(key, Number(MAX_STRUCT_SIZE) + 1);
    await expectLogicError(
      capped.send.concatBytes({
        args: { path, value: new Uint8Array([0x01]) },
        accessReferences: refs,
        populateAppCallResources: false,
      }),
      "value exceeds maxValue",
    );
    await capped.appClient.fundAppAccount({
      amount: microAlgo(toMBR({ txt: "a" }) + 400n * MAX_STRUCT_SIZE),
    });
    const txtRefs = accessRefsForBox(box("txt"), Number(MAX_STRUCT_SIZE) + 1);
    await capped.send.set({
      args: { path: "txt", value: "a".repeat(Number(MAX_STRUCT_SIZE)) },
      accessReferences: txtRefs,
      staticFee: microAlgo(minFee + surchargeFor(chunkSize, minFee)),
      populateAppCallResources: false,
    });
    await expectLogicError(
      capped.send.concat({
        args: { path: "txt", value: "a" },
        accessReferences: txtRefs,
        populateAppCallResources: false,
      }),
      "value exceeds maxValue",
    );
    // The leaves are untouched by the rejected writes.
    expect(await algorand.app.getBoxValue(cappedId, key)).toEqual(leaf);
    expect((await algorand.app.getBoxValue(cappedId, box("txt"))).length).toBe(
      Number(MAX_STRUCT_SIZE),
    );
  });

  it("rejects an invalid maxValue or an oversized leaf before creating anything", async () => {
    const { algorand, testAccount } = fixture.context;
    const apps = async () =>
      (await algorand.client.algod.accountInformation(testAccount.addr).do())
        .createdApps?.length ?? 0;
    const before = await apps();
    for (const maxValue of [0, -1, 1.5, Number(MAX_BOX_SIZE) + 1]) {
      await expect(
        deploy(algorand, testAccount, "arc87-it-bad", { a: "x" }, { maxValue }),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      deploy(
        algorand,
        testAccount,
        "arc87-it-bad",
        { a: "x".repeat(Number(MAX_STRUCT_SIZE) + 1) },
        { maxValue: Number(MAX_STRUCT_SIZE) },
      ),
    ).rejects.toThrow(MaxSizeError);
    expect(await apps()).toBe(before);
  });

  it("fails descriptive size asserts on chain", async () => {
    await expectLogicError(
      client.send.set({ args: { path: "", value: "v" } }),
      "path must not be empty",
    );
    // No box reference: algod would reject a 65-byte box name before the
    // program runs, and the contract asserts the key size before touching the box.
    const long = "k".repeat(63);
    await expectLogicError(
      client.send.set({ args: { path: long, value: "v" } }),
      "key exceeds 64 bytes",
    );
  });

  it("rejects UpdateApplication when deployed with updatable: false", async () => {
    await expectLogicError(
      client.send.update.bare({ updatable: false, deletable: true }),
      "not updatable",
    );
  });

  it("guards reclaim and pays the creator on success", async () => {
    const { algorand, testAccount } = fixture.context;
    // The surcharge and 32 KiB tests above drain the shared account; top it up.
    await algorand.account.ensureFunded(
      testAccount,
      await algorand.account.localNetDispenser(),
      microAlgo(3_000_000),
    );
    const extra = microAlgo(1_000_000);
    await client.appClient.fundAppAccount({ amount: extra });
    const app = await algorand.account.getInformation(client.appAddress);
    const spare = app.balance.microAlgo - app.minBalance.microAlgo;
    expect(spare).toBeGreaterThanOrEqual(extra.microAlgo);

    await expectLogicError(
      client.send.reclaim({ args: { amount: 0n }, staticFee: RECLAIM_FEE }),
      "amount must be positive",
    );
    await expectLogicError(
      client.send.reclaim({
        args: { amount: spare + 1n },
        staticFee: RECLAIM_FEE,
      }),
      "cannot reclaim below minimum balance",
    );

    const before = (await algorand.account.getInformation(testAccount.addr))
      .balance.microAlgo;
    const result = await client.send.reclaim({
      args: { amount: spare },
      staticFee: RECLAIM_FEE,
    });
    const after = (await algorand.account.getInformation(testAccount.addr))
      .balance.microAlgo;
    expect(after - before).toBe(spare - RECLAIM_FEE.microAlgo);
    const inner = result.confirmation.innerTxns?.[0]?.txn.txn;
    expect(inner?.payment?.amount).toBe(spare);
    expect(inner?.payment?.receiver.toString()).toBe(
      testAccount.addr.toString(),
    );
    const drained = await algorand.account.getInformation(client.appAddress);
    expect(drained.balance.microAlgo).toBe(drained.minBalance.microAlgo);
  });

  it("deletes the application (deletable: true)", async () => {
    const { algorand, testAccount } = fixture.context;
    // Remove the boxes first so the app account can be closed by algod
    const keys = toBoxes(ESCAPED.object).map(([key]) => key);
    const group = client.newGroup();
    for (const key of keys) {
      group.remove({ args: { path: stripPrefix(key) }, boxReferences: [key] });
    }
    await group.send();
    expect(await algorand.app.getBoxNames(appId)).toEqual([]);

    await client.send.delete.bare();
    await expect(algorand.app.getById(appId)).rejects.toThrow();
    // Deleting is idempotent for the deployer: the name can be reused
    expect(
      await deploy(algorand, testAccount, "arc87-it-after-delete", {
        ok: true,
      }),
    ).toBeGreaterThan(appId);
  });
});
