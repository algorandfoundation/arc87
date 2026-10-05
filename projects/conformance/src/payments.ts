import {
  MAX_ABI_SIZE,
  MAX_ARG_SIZE,
  MAX_BOX_SIZE,
  MAX_KEY_SIZE,
  MIN_BALANCE,
  MIN_FEE,
  PER_BOX,
  PER_BYTE_SURCHARGE,
  PER_UNIT,
} from "./constants.js";
import { MaxSizeError } from "./errors.js";
import { byteLength } from "./paths.js";
import { toBoxes } from "./state.js";
import type { KeyValue } from "./type.js";

/**
 * Calculates the minimum balance requirement (MBR) for a list of boxes:
 * `MIN_BALANCE + Σ (PER_BOX + PER_UNIT * (keyBytes + valueBytes))`.
 *
 * @param {KeyValue[]} boxes The `[key, value]` boxes.
 *
 * @throws {MaxSizeError} If a key exceeds {@link MAX_KEY_SIZE} or a value exceeds {@link MAX_BOX_SIZE}.
 * @return {bigint} The MBR in microAlgos.
 */
export function boxesToMBR(boxes: KeyValue[]): bigint {
  return boxes.reduce((acc, [key, value]) => {
    const keySize = BigInt(byteLength(key));
    if (keySize > MAX_KEY_SIZE) {
      throw new MaxSizeError(`Key size exceeds maximum of ${MAX_KEY_SIZE}`);
    }
    const boxSize = BigInt(byteLength(value));
    if (boxSize > MAX_BOX_SIZE) {
      throw new MaxSizeError(`Box size exceeds maximum of ${MAX_BOX_SIZE}`);
    }
    return acc + (PER_BOX + PER_UNIT * (keySize + boxSize));
  }, MIN_BALANCE);
}

/**
 * Calculates the minimum balance requirement (MBR) for an object: one box per
 * leaf, keyed and serialised exactly as {@link toBoxes} does. Keys are
 * measured in UTF-8 bytes including the prefix; there is no templating of
 * long key names, a key over {@link MAX_KEY_SIZE} bytes is rejected.
 *
 * @param {unknown} obj The object for which to calculate the MBR.
 *
 * @throws {TypeError} Throws a `TypeError` if the object is undefined.
 * @throws {MaxSizeError} Throws a {@link MaxSizeError} if a key exceeds {@link MAX_KEY_SIZE} or a value exceeds {@link MAX_BOX_SIZE}.
 *
 * @example
 * ```typescript
 * // Define an object
 * const obj = {
 *   key: "value"
 * }
 * // Calculate the MBR
 * const mbr = toMBR(obj)
 * ```
 */
export function toMBR(obj: unknown): bigint {
  if (typeof obj === "undefined") {
    throw new TypeError("Object is required");
  }
  return boxesToMBR(toBoxes(obj));
}

/**
 * Checks every box value against a store's `maxValue` cap (the global the
 * ARC-87 contract fixes at create) so an oversized leaf is rejected before any
 * transaction is sent. Keys are not checked here; see {@link boxesToMBR}.
 *
 * @example
 * ```TypeScript
 * assertFits(toBoxes(obj), MAX_STRUCT_SIZE); // every leaf is stack-decodable
 * ```
 *
 * @param {KeyValue[]} boxes The `[key, value]` boxes.
 * @param {number | bigint} maxValue The per-value cap in bytes, `1 ≤ maxValue ≤ MAX_BOX_SIZE`.
 *
 * @throws {RangeError} If `maxValue` is outside `[1, MAX_BOX_SIZE]`.
 * @throws {MaxSizeError} If a value is larger than `maxValue` bytes.
 */
export function assertFits(boxes: KeyValue[], maxValue: number | bigint): void {
  const cap = BigInt(maxValue);
  if (cap < 1n || cap > MAX_BOX_SIZE) {
    throw new RangeError(
      `maxValue must be between 1 and ${MAX_BOX_SIZE} bytes: ${cap}`,
    );
  }
  for (const [key, value] of boxes) {
    const size = BigInt(byteLength(value));
    if (size > cap) {
      throw new MaxSizeError(
        `Value exceeds maxValue of ${cap} bytes for key ${key}: ${size}`,
      );
    }
  }
}

/**
 * Fee surcharge (µALGO) an application call pays for its encoded arguments:
 * every byte over {@link MAX_ABI_SIZE} costs `minFee * PER_BYTE_SURCHARGE / 1e6`
 * (0.1 µALGO at the default minimum fee), rounded up to a whole µALGO. algod
 * compares the *group* total, so the per-call rounding is a safe over-approximation.
 *
 * @example
 * ```TypeScript
 * surchargeFor(2048)  // 0n   (flat fee)
 * surchargeFor(2111)  // 7n   (63 bytes over → 6.3 → 7 µALGO)
 * surchargeFor(16384) // 1434n
 * ```
 *
 * @param {number | bigint} encodedArgBytes Total size of the encoded application arguments (selector included).
 * @param {bigint} minFee The network minimum fee in µALGO (defaults to {@link MIN_FEE}).
 *
 * @throws {MaxSizeError} If `encodedArgBytes` exceeds {@link MAX_ARG_SIZE}.
 * @return {bigint} The surcharge to add to the minimum fee, `0n` when the arguments fit the flat budget.
 */
export function surchargeFor(
  encodedArgBytes: number | bigint,
  minFee: bigint = MIN_FEE,
): bigint {
  const size = BigInt(encodedArgBytes);
  if (size > MAX_ARG_SIZE) {
    throw new MaxSizeError(
      `Argument size exceeds maximum of ${MAX_ARG_SIZE}: ${size}`,
    );
  }
  if (size <= MAX_ABI_SIZE) return 0n;
  const excess = size - MAX_ABI_SIZE;
  const scaled = excess * minFee * PER_BYTE_SURCHARGE;
  const unit = 1_000_000n;
  return (scaled + unit - 1n) / unit;
}
