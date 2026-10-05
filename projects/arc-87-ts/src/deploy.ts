import type { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { microAlgo } from "@algorandfoundation/algokit-utils";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";

import {
  assertFits,
  byteLength,
  chunkValue,
  GROUP_SIZE,
  type KeyValue,
  MAX_ABI_SIZE,
  MAX_ARG_SIZE,
  MAX_BOX_SIZE,
  MAX_KEY_SIZE,
  MAX_STRUCT_SIZE,
  stripPrefix,
  surchargeFor,
  toBoxes,
  toMBR,
} from "@algorandfoundation/arc87";

import { Arc87Factory } from "../smart_contracts/client.js";

/**
 * Options of {@link deploy}.
 */
export type DeployOptions = {
  /**
   * Maximum size (bytes) of the encoded ABI arguments of a single `set` /
   * `concat` call, i.e. of each chunk a large value is written in. Defaults to
   * `MAX_ABI_SIZE` (2048), the largest size at the flat minimum fee. Up to
   * `MAX_ARG_SIZE` (16384): every byte over `MAX_ABI_SIZE` is paid with the
   * consensus v42 per-byte surcharge (`surchargeFor`). Must be greater than
   * `ABI_OVERHEAD + MAX_KEY_SIZE`.
   *
   * A single `value` argument can never exceed `MAX_AVM_BYTES` (4096) bytes
   * however large the total budget is, so the effective chunk is
   * `min(chunkSize - ABI_OVERHEAD - pathBytes, MAX_AVM_BYTES - 2)`: a 32 KiB
   * value lands in 9 surcharged calls (`chunkSize >= 4106`) instead of 17 flat ones.
   */
  chunkSize?: number;
  /**
   * Per-value size cap (bytes) of the store, `1 ≤ maxValue ≤ MAX_BOX_SIZE`.
   * When given, every leaf of `obj` is checked against it before anything is
   * sent and the application is created through `create(uint64)`, which fixes
   * the cap in the `maxValue` global for every later write; a consumer reads it
   * with `app_global_get_ex`. `maxValue <= MAX_STRUCT_SIZE` (4094) guarantees
   * every leaf can be loaded whole onto the AVM stack and decoded as an ARC-4
   * struct. Omitted: the bare create with the default 32 KiB cap.
   */
  maxValue?: number;
};

/**
 * Deploys an `ARC87` application, funds its minimum balance requirement and
 * writes every box of `obj` (as produced by {@link toBoxes}, escaped segments
 * included). Text leaves are written with `set` / `concat`, `Uint8Array`
 * leaves (e.g. ARC-4 encoded values) with `setBytes` / `concatBytes`. Values
 * that do not fit in a single ABI call are chunked, see {@link DeployOptions}.
 *
 * The application is deployed with `updatable: false` and `deletable: true`
 * (`TMPL_UPDATABLE=0`, `TMPL_DELETABLE=1`).
 *
 * This is just for demonstration purposes.
 *
 * @example
 * ```TypeScript
 * const appId = await deploy(algorand, deployer, "animal-1", { type: "cat" })
 * // fewer, surcharged calls for large values
 * await deploy(algorand, deployer, "blob", { blob }, { chunkSize: 16384 })
 * // every leaf stays stack-decodable for consuming contracts
 * await deploy(algorand, deployer, "packed", { packed }, { maxValue: MAX_STRUCT_SIZE })
 * ```
 *
 * @param {AlgorandClient} algorand The Algorand client.
 * @param {TransactionSignerAccount} deployer The creator (and only writer) of the application.
 * @param {string} name The application name used for idempotent deployment.
 * @param {T} obj The object to store.
 * @param {DeployOptions} options `chunkSize`: encoded-argument budget per call; `maxValue`: per-value cap of the store.
 *
 * @throws {MaxSizeError} If a key exceeds `MAX_KEY_SIZE` or a value exceeds `MAX_BOX_SIZE` (or `maxValue` when given).
 * @throws {RangeError} If `chunkSize` is not an integer in `(ABI_OVERHEAD + MAX_KEY_SIZE, MAX_ARG_SIZE]` or `maxValue` not in `[1, MAX_BOX_SIZE]`.
 * @return {Promise<bigint>} The application id.
 */
export async function deploy<T>(
  algorand: AlgorandClient,
  deployer: TransactionSignerAccount,
  name: string,
  obj: T,
  options: DeployOptions = {},
): Promise<bigint> {
  const chunkSize = validateChunkSize(options.chunkSize);
  const maxValue = validateMaxValue(options.maxValue);
  // Fail before creating the application if the object cannot be stored
  const boxes = toBoxes(obj);
  const mbr = toMBR(obj);
  if (maxValue !== undefined) assertFits(boxes, maxValue);
  // The surcharge is a multiple of the network minimum fee; only needed above the flat budget.
  const minFee =
    chunkSize > Number(MAX_ABI_SIZE)
      ? BigInt((await algorand.getSuggestedParams()).minFee)
      : undefined;
  const factory = algorand.client.getTypedAppFactory(Arc87Factory, {
    deletable: true,
    updatable: false,
    defaultSender: deployer.addr,
    defaultSigner: deployer.signer,
  });
  const { appClient } = await factory.deploy({
    onUpdate: "append",
    onSchemaBreak: "append",
    appName: name,
    // Bare create keeps the default 32 KiB cap; `create(uint64)` fixes a custom one.
    ...(maxValue !== undefined
      ? { createParams: { method: "create", args: { maxValue } } }
      : {}),
  });
  await appClient.appClient.fundAppAccount({
    amount: mbr.microAlgo(),
    sender: deployer.addr,
  });

  // Save State On-Chain, one group of calls at a time. Track the running size of
  // each box so every call can carry enough box I/O budget: the AVM charges the
  // *full* box size (not the bytes written) against a 2 KiB-per-reference budget,
  // so a 32 KiB value needs 16 references on the call that touches it.
  const sizes = new Map<string, number>();
  for (const group of groupCalls(toCalls(boxes, chunkSize))) {
    const atc = appClient.newGroup();
    for (const [index, call] of group.entries()) {
      const written = byteLength(call.value);
      const sizeAfter = (sizes.get(call.key) ?? 0) + written;
      sizes.set(call.key, sizeAfter);
      // Encoded arguments over MAX_ABI_SIZE pay the per-byte surcharge on top
      // of the minimum fee; within the flat budget the fee is left to algod.
      const encoded = ABI_OVERHEAD + byteLength(call.path) + written;
      const surcharge =
        minFee === undefined ? 0n : surchargeFor(encoded, minFee);
      const common = {
        // Named box + empty access slots for I/O budget (MaxAppAccess = 16).
        accessReferences: accessRefsForBox(call.key, sizeAfter),
        sender: deployer.addr,
        signer: deployer.signer,
        // Repeated `concat` chunks of the same value would otherwise be
        // identical transactions (duplicate transaction id) within the group
        note: `${name}:${index}`,
        ...(surcharge > 0n && minFee !== undefined
          ? { staticFee: microAlgo(minFee + surcharge) }
          : {}),
      };
      if (typeof call.value === "string") {
        const params = {
          ...common,
          args: { path: call.path, value: call.value },
        };
        if (call.method === "set") {
          atc.set(params);
        } else {
          atc.concat(params);
        }
      } else {
        const params = {
          ...common,
          args: { path: call.path, value: call.value },
        };
        if (call.method === "set") {
          atc.setBytes(params);
        } else {
          atc.concatBytes(params);
        }
      }
    }
    // Access references are supplied explicitly above. Auto resource packing is
    // skipped so full 16-txn groups of large-arg calls are not re-packed.
    await atc.send({ populateAppCallResources: false });
  }
  return appClient.appId;
}

/**
 * Bytes the ABI encoding adds to the raw `path` and `value` of a `set`,
 * `setBytes`, `concat` or `concatBytes` call: the 4-byte method selector and a
 * 2-byte length prefix per `string` / `byte[]` argument. Application arguments
 * beyond `MAX_ABI_SIZE` bytes in total are surcharged per byte, so chunks are
 * sized on their encoded length.
 */
export const ABI_OVERHEAD = 8;

/**
 * Largest `value` a single ABI `string` / `byte[]` argument can carry: the
 * per-argument cap (`MAX_AVM_BYTES`, enforced by algod) minus the 2-byte
 * length prefix — the same 4094 bytes as `MAX_STRUCT_SIZE`, so a leaf at the
 * recommended struct ceiling is written by a single (surcharged) call when
 * `chunkSize >= ABI_OVERHEAD + pathBytes + MAX_VALUE_ARG`.
 */
export const MAX_VALUE_ARG = Number(MAX_STRUCT_SIZE);

/**
 * Smallest accepted `chunkSize`: room for the ABI overhead, the longest
 * possible path (`MAX_KEY_SIZE`) and at least one byte of value.
 *
 * @protected
 */
const MIN_CHUNK_SIZE = ABI_OVERHEAD + Number(MAX_KEY_SIZE) + 1;

/**
 * Validates the `chunkSize` option, defaulting to `MAX_ABI_SIZE` (flat fee).
 *
 * @protected
 */
function validateChunkSize(chunkSize: number | undefined): number {
  if (chunkSize === undefined) return Number(MAX_ABI_SIZE);
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < MIN_CHUNK_SIZE ||
    chunkSize > Number(MAX_ARG_SIZE)
  ) {
    throw new RangeError(
      `chunkSize must be an integer in [${MIN_CHUNK_SIZE}, ${MAX_ARG_SIZE}], got ${chunkSize}`,
    );
  }
  return chunkSize;
}

/**
 * Validates the `maxValue` option; `undefined` keeps the bare create.
 *
 * @protected
 */
function validateMaxValue(maxValue: number | undefined): number | undefined {
  if (maxValue === undefined) return undefined;
  if (
    !Number.isInteger(maxValue) ||
    maxValue < 1 ||
    maxValue > Number(MAX_BOX_SIZE)
  ) {
    throw new RangeError(
      `maxValue must be an integer in [1, ${MAX_BOX_SIZE}], got ${maxValue}`,
    );
  }
  return maxValue;
}

/**
 * Box I/O budget granted by each box or empty access-list entry (bytes).
 * A 32 KiB box needs `MAX_BOX_SIZE / BOX_IO_PER_REF` = 16 references.
 *
 * @protected
 */
const BOX_IO_PER_REF = 2048;

/** Max entries in a single app-call access list (consensus `MaxAppAccess`). */
const MAX_ACCESS = 16;

/**
 * Access-list entries naming the box `key` of application `appId` (`0n` for
 * the called application) plus enough empty slots for the box I/O budget of a
 * value `size` bytes long (charged at the full box size, 2 KiB per entry,
 * `MAX_ACCESS` entries at most). Foreign boxes (AVM 13 `app_box_*` reads from
 * another application) are charged the same way, so a consumer contract call
 * can reuse this helper with the store's `appId`.
 */
export function accessRefsForBox(
  key: string,
  size: number,
  appId = 0n,
): ({ box: { appId: bigint; name: string } } | Record<string, never>)[] {
  const needed = Math.min(
    MAX_ACCESS,
    Math.max(1, Math.ceil(size / BOX_IO_PER_REF)),
  );
  return [
    { box: { appId, name: key } },
    ...Array.from({ length: needed - 1 }, () => ({})),
  ];
}

/**
 * A single write call: `set` / `concat` for text, `setBytes` / `concatBytes`
 * for raw bytes (the ABI method is picked from the value type).
 *
 * @protected
 */
type Call = {
  method: "set" | "concat";
  key: string;
  path: string;
  value: string | Uint8Array;
};

/**
 * Expands boxes into application calls: one `set` per box, followed by
 * `concat` calls for values whose encoded arguments do not fit `chunkSize`
 * (or whose `value` argument would exceed `MAX_VALUE_ARG`). Text is split at
 * code-point boundaries, bytes exactly (see `chunkValue`).
 *
 * @protected
 */
function toCalls(boxes: KeyValue[], chunkSize: number): Call[] {
  return boxes.flatMap(([key, value]) => {
    const path = stripPrefix(key);
    const budget = Math.min(
      chunkSize - ABI_OVERHEAD - byteLength(path),
      MAX_VALUE_ARG,
    );
    const chunks: (string | Uint8Array)[] =
      byteLength(value) > budget ? chunkValue(value, budget) : [value];
    return chunks.map((chunk, idx) => ({
      method: idx === 0 ? "set" : "concat",
      key,
      path,
      value: chunk,
    })) as Call[];
  });
}

/**
 * Splits calls into groups of at most `size` transactions.
 *
 * @protected
 */
function groupCalls(calls: Call[], size: number = GROUP_SIZE): Call[][] {
  const groups: Call[][] = [];
  for (let i = 0; i < calls.length; i += size) {
    groups.push(calls.slice(i, i + size));
  }
  return groups;
}
