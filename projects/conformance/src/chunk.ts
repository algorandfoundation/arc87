import { GROUP_SIZE, MAX_ABI_SIZE } from "./constants.js";
import { byteLength, toPaths } from "./paths.js";

/**
 * Splits the paths of an object into groups of at most `size` entries, so each
 * group can be sent as one atomic transaction group of `set` calls.
 *
 * @param {unknown} obj The object whose paths are chunked.
 * @param {number} size The maximum number of paths per chunk (defaults to {@link GROUP_SIZE}).
 * @return {string[][]} The chunked paths.
 */
export function toChunks(obj: unknown, size: number = GROUP_SIZE): string[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new TypeError("Chunk size must be a positive integer");
  }
  return toPaths(obj).reduce((accumulator, currentValue, index) => {
    const chunkIndex = Math.floor(index / size);
    if (!accumulator[chunkIndex]) {
      accumulator[chunkIndex] = []; // Start a new chunk
    }
    accumulator[chunkIndex].push(currentValue);
    return accumulator;
  }, [] as string[][]);
}

/**
 * UTF-8 encoded length of a single code point.
 *
 * @protected
 */
function codePointLength(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Splits a value into chunks of at most `size` **bytes**. Text is split at
 * code-point boundaries (a multi-byte character is never torn apart, so every
 * chunk is valid UTF-8 and the ABI `string` encoding of the chunks concatenates
 * to the encoding of the whole); raw bytes are split exactly. A single code
 * point wider than `size` forms a chunk of its own.
 *
 * @example
 * ```TypeScript
 * chunkValue("abcdefg", 3)          // ["abc", "def", "g"]
 * chunkValue("ééé", 3)              // ["é", "é", "é"] (2 bytes each)
 * chunkValue(new Uint8Array(5), 2)  // [2 bytes, 2 bytes, 1 byte]
 * ```
 *
 * @param {string | Uint8Array} value - The text or bytes to be divided into chunks.
 * @param {number} size - The maximum size of each chunk in bytes.
 * @return {string[] | Uint8Array[]} The chunks, of the same type as `value`.
 */
export function chunkValue(value: string, size: number): string[];
export function chunkValue(value: Uint8Array, size: number): Uint8Array[];
export function chunkValue(
  value: string | Uint8Array,
  size: number,
): string[] | Uint8Array[];
export function chunkValue(
  value: string | Uint8Array,
  size: number,
): string[] | Uint8Array[] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new TypeError("Chunk size must be a positive integer");
  }
  if (value instanceof Uint8Array) {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < value.length; i += size) {
      chunks.push(value.slice(i, i + size));
    }
    return chunks;
  }
  if (typeof value !== "string") {
    throw new TypeError("Value must be a string or a Uint8Array");
  }
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of value) {
    const width = codePointLength(char.codePointAt(0) ?? 0);
    if (bytes + width > size && current.length > 0) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += width;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Splits a value into chunks that fit, together with the key, into a single
 * ABI call ({@link MAX_ABI_SIZE}). The first chunk is written with `set`,
 * the remaining ones appended with `concat`.
 *
 * @param {string} key - The full box key whose byte length is reserved from each chunk.
 * @param {string | Uint8Array} value - The text or bytes to be chunked.
 * @return {string[] | Uint8Array[]} The chunks derived from the provided value.
 */
export function chunkKeyValue(key: string, value: string): string[];
export function chunkKeyValue(key: string, value: Uint8Array): Uint8Array[];
export function chunkKeyValue(
  key: string,
  value: string | Uint8Array,
): string[] | Uint8Array[] {
  if (typeof key !== "string") {
    throw new TypeError("Key must be a string");
  }
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new TypeError("Value must be a string or a Uint8Array");
  }
  return chunkValue(value, Number(MAX_ABI_SIZE) - byteLength(key));
}
