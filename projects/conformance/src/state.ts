import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import get from "lodash.get";
import set from "lodash.set";
import { MAX_KEY_SIZE, PREFIX } from "./constants.js";
import {
  ALGORAND_CLIENT_REQUIRED,
  APPLICATION_ID_REQUIRED,
  MaxSizeError,
} from "./errors.js";
import {
  byteLength,
  isPlainObject,
  normalizePath,
  stripPrefix,
  toPaths,
  toSegments,
} from "./paths.js";
import type {
  AssembleOptions,
  BinaryFilter,
  Change,
  KeyValue,
} from "./type.js";

/**
 * Serialises a leaf value as stored in a box. Text is stored as is and
 * `Uint8Array` leaves (raw bytes, e.g. ARC-4 encoded values) pass through
 * untouched; other scalars use `String(value)` (so `2` → `"2"`, `null` →
 * `"null"`); empty containers are stored as their compact JSON (`"[]"` / `"{}"`).
 *
 * @param {unknown} value The leaf value.
 * @return {string | Uint8Array} The box value.
 */
export function serialize(value: unknown): string | Uint8Array {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

const INTEGER = /^-?\d+$/;

/**
 * Reverses {@link serialize} on a best-effort basis: integer text becomes a
 * `number` (or `bigint` beyond the safe range), the literals `null`, `true`,
 * `false`, `[]` and `{}` become their JSON values, anything else stays a string.
 *
 * @param {string} text The box value.
 * @return {unknown} The leaf value.
 */
export function deserialize(text: string): unknown {
  if (INTEGER.test(text)) {
    const big = BigInt(text);
    return big <= BigInt(Number.MAX_SAFE_INTEGER) &&
      big >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(big)
      : big;
  }
  switch (text) {
    case "null":
      return null;
    case "true":
      return true;
    case "false":
      return false;
    case "[]":
      return [];
    case "{}":
      return {};
    default:
      return text;
  }
}

/**
 * Reads the leaf at an un-prefixed path.
 *
 * @protected
 */
export function getPath(obj: unknown, path: string): unknown {
  return get(obj, toSegments(path));
}

/**
 * Flattens an object into the list of `[key, value]` boxes to be written on
 * chain: every leaf keyed by `PREFIX + path`. A key longer than
 * {@link MAX_KEY_SIZE} bytes cannot be stored as a box name and is rejected;
 * templating long key names is out of scope of ARC-87.
 *
 * @example
 * ```TypeScript
 * toBoxes({ index: 2, blobs: ["a"] })
 * // [["o_index", "2"], ["o_blobs[0]", "a"]]
 * ```
 *
 * @param {unknown} obj The object to flatten.
 *
 * @throws {TypeError} If `obj` is undefined.
 * @throws {MaxSizeError} If a full key exceeds {@link MAX_KEY_SIZE} bytes.
 * @return {KeyValue[]} The boxes in `toPaths` order.
 */
export function toBoxes(obj: unknown): KeyValue[] {
  if (typeof obj === "undefined") {
    throw new TypeError("Object is required");
  }
  return toPaths(obj).map((path) => {
    const key = `${PREFIX}${path}`;
    if (BigInt(byteLength(key)) > MAX_KEY_SIZE) {
      throw new MaxSizeError(
        `Key size exceeds maximum of ${MAX_KEY_SIZE}: ${key}`,
      );
    }
    return [key, serialize(getPath(obj, path))];
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Builds the predicate selecting binary leaves from a {@link BinaryFilter}:
 * listed paths are compared in their normalized form (`[N]` ≡ `.N`).
 *
 * @protected
 */
function binaryPredicate(binary?: BinaryFilter): (path: string) => boolean {
  if (typeof binary === "function") return binary;
  if (!binary || binary.length === 0) return () => false;
  const selected = new Set(binary.map(normalizePath));
  return (path) => selected.has(normalizePath(path));
}

/**
 * Decodes a box value as a leaf: binary leaves are returned as `Uint8Array`
 * (text is UTF-8 encoded), the rest is decoded as text with {@link deserialize}.
 *
 * @protected
 */
function toLeaf(value: string | Uint8Array, binary: boolean): unknown {
  if (binary) {
    return typeof value === "string" ? encoder.encode(value) : value;
  }
  return deserialize(typeof value === "string" ? value : decoder.decode(value));
}

/**
 * Assembles a structured object from a list of `[key, value]` boxes. Every
 * key is stripped of the prefix, normalized (`[N]` and `.N` are equivalent),
 * split into unescaped segments and set on the result. Values are decoded
 * with {@link deserialize}, except the leaves selected by `binary` which are
 * returned as raw `Uint8Array` (for ARC-4 encoded values written with
 * `setBytes`); without the option every value is treated as text.
 *
 * @example
 * ```TypeScript
 * assemble([["o_blobs[0]", "x"], ["o_blobs.1", "y"]])
 * // { blobs: ["x", "y"] }
 * assemble([["o_count", itob(42)]], { binary: ["count"] })
 * // { count: Uint8Array(8) }
 * ```
 *
 * @param {KeyValue[]} kvs The boxes.
 * @param {AssembleOptions} options `binary`: the leaves to keep as raw bytes.
 * @return A structured object of type T, with top-level keys sorted.
 */
export function assemble<T>(kvs: KeyValue[], options: AssembleOptions = {}): T {
  const isBinary = binaryPredicate(options.binary);
  const data: Record<string, unknown> = {};
  for (const [key, value] of kvs) {
    const path = stripPrefix(key);
    set(data, toSegments(path), toLeaf(value, isBinary(path)));
  }
  return Object.keys(data)
    .sort()
    .reduce((obj: Record<string, unknown>, key) => {
      obj[key] = data[key];
      return obj;
    }, {}) as T;
}

/**
 * Reads every box of an application and assembles them into a structured
 * object. `[N]` and `.N` indices are both accepted and escaped segments are
 * unwrapped.
 *
 * @example
 * ```TypeScript
 * const animal = await fromBoxes<Animal>(algorand, 1001n)
 * ```
 *
 * @param {AlgorandClient} algorand The Algorand client used to read the boxes.
 * @param {bigint} appId The application whose boxes hold the object.
 * @param {AssembleOptions} options `binary`: the leaves to return as raw `Uint8Array`, see {@link assemble}.
 *
 * @throws {TypeError} If `algorand` is not an `AlgorandClient` or `appId` is not a `bigint`.
 * @return A structured object of type T.
 */
export async function fromBoxes<T>(
  algorand: AlgorandClient,
  appId: bigint,
  options: AssembleOptions = {},
): Promise<T> {
  if (!(algorand instanceof AlgorandClient)) {
    throw new TypeError(ALGORAND_CLIENT_REQUIRED);
  }
  if (typeof appId !== "bigint") {
    throw new TypeError(APPLICATION_ID_REQUIRED);
  }
  const names = await algorand.app.getBoxNames(appId);
  const values = await algorand.app.getBoxValues(appId, names);
  const kvs: KeyValue[] = names.map((name, idx) => [
    decoder.decode(name.nameRaw),
    values[idx],
  ]);
  return assemble<T>(kvs, options);
}

/**
 * Byte-wise equality of two `Uint8Array` values.
 *
 * @protected
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compares two objects and returns the leaves whose value changed, keyed by
 * their prefixed key. A leaf that exists only in `a` is reported with the
 * value `undefined`. `Uint8Array` leaves are scalars compared byte-wise.
 *
 * @example
 * ```TypeScript
 * diff({ a: 1, b: 2 }, { a: 1, b: 3 })
 * // [["o_b", 3]]
 * ```
 *
 * @param {T} a The first object to compare.
 * @param {T} b The second object to compare.
 * @return {Change[]} The changed `[key, value]` pairs with values taken from `b`.
 */
export function diff<T>(a: T, b: T): Change[] {
  const paths = new Set([...toPaths(a), ...toPaths(b)]);
  const changes: Change[] = [];
  for (const path of paths) {
    const va = getPath(a, path);
    const vb = getPath(b, path);
    const equal =
      va === vb ||
      (va instanceof Uint8Array || vb instanceof Uint8Array
        ? va instanceof Uint8Array &&
          vb instanceof Uint8Array &&
          bytesEqual(va, vb)
        : typeof va === "object" &&
          typeof vb === "object" &&
          va !== null &&
          vb !== null &&
          JSON.stringify(va) === JSON.stringify(vb));
    if (!equal) {
      changes.push([`${PREFIX}${path}`, vb]);
    }
  }
  return changes;
}

/**
 * Recursively merges the properties of a source object into a target object
 * without mutating either. Arrays, `Uint8Array` leaves and scalars are
 * replaced, not merged.
 *
 * @param {T} target The target object to merge properties into.
 * @param {T} source The source object whose properties are merged into the target.
 * @return {T} The merged object.
 */
export function deepMerge<T>(target: T, source: T): T {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return source;
  }
  const out: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    out[key] = deepMerge(target[key], source[key]);
  }
  return out as T;
}
