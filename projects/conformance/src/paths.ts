import { PREFIX, RESERVED_CHARACTERS } from "./constants.js";
import type { KeyValueMap } from "./type.js";

/**
 * Matches a single escaped span `${...}`. The span ends at the first `}`;
 * `}` alone is not reserved, so a literal may never contain a `}` that is
 * followed by more escaped text.
 *
 * @protected
 */
const ESCAPED_SPAN = /\$\{[^}]*\}?/g;

/**
 * Matches a bracketed numeric index `[N]`.
 *
 * @protected
 */
const BRACKET_INDEX = /\[(\d+)\]/g;

const encoder = new TextEncoder();

/**
 * UTF-8 byte length of a string, or the length of a raw byte value. Box key
 * and value limits are measured in bytes, not characters.
 *
 * @param {string | Uint8Array} value The text or bytes to measure.
 * @return {number} The number of bytes in the UTF-8 encoding (or of the bytes).
 */
export function byteLength(value: string | Uint8Array): number {
  if (value instanceof Uint8Array) return value.length;
  return encoder.encode(value).length;
}

/**
 * Checks whether a path segment contains a reserved character and must be escaped.
 *
 * @param {string} segment The raw path segment.
 * @return {boolean} `true` when the segment needs to be wrapped as `${...}`.
 */
export function isReserved(segment: string): boolean {
  for (const char of RESERVED_CHARACTERS) {
    if (segment.includes(char)) return true;
  }
  return false;
}

/**
 * Wraps a single path segment as `${...}` when it contains any reserved character
 * (`.`, `[`, `]`, `$`, `{`). Segments without reserved characters are returned unchanged.
 *
 * @example
 * ```TypeScript
 * escapeSegment("a.b") // "${a.b}"
 * escapeSegment("alice") // "alice"
 * ```
 *
 * @param {string} segment The raw path segment.
 * @return {string} The escaped segment.
 */
export function escapeSegment(segment: string): string {
  return isReserved(segment) ? `\${${segment}}` : segment;
}

/**
 * Reverses {@link escapeSegment}. A segment of the form `${...}` is unwrapped,
 * anything else is returned unchanged.
 *
 * @param {string} segment The (possibly) escaped path segment.
 * @return {string} The original segment.
 */
export function unescapeSegment(segment: string): string {
  if (segment.startsWith("${") && segment.endsWith("}")) {
    return segment.slice(2, -1);
  }
  return segment;
}

/**
 * Applies `fn` to every stretch of text that lies outside of an escaped `${...}` span.
 *
 * @protected
 */
function mapOutsideSpans(path: string, fn: (text: string) => string): string {
  let result = "";
  let last = 0;
  for (const match of path.matchAll(ESCAPED_SPAN)) {
    result += fn(path.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + fn(path.slice(last));
}

/**
 * Normalizes a key or path so that the canonical `[N]` index form and the
 * dotted `.N` form resolve to the same slot: every `[N]` outside of an escaped
 * `${...}` span is rewritten as `.N`. The function is idempotent and works on
 * both prefixed keys and bare paths.
 *
 * @example
 * ```TypeScript
 * normalizePath("o_blobs[1]") // "o_blobs.1"
 * normalizePath("o_${a[1]}[2]") // "o_${a[1]}.2"
 * ```
 *
 * @param {string} path The key or path to normalize.
 * @return {string} The normalized key or path.
 */
export function normalizePath(path: string): string {
  return mapOutsideSpans(path, (text) => text.replace(BRACKET_INDEX, ".$1"));
}

/**
 * Splits a (prefix-less) path into its unescaped segments. Indices are
 * normalized first, so `a[1].b`, `a.1.b` and `${a}.1.b` all yield `["a", "1", "b"]`.
 *
 * @param {string} path The path to split.
 * @return {string[]} The raw (unescaped) segments.
 */
export function toSegments(path: string): string[] {
  const normalized = normalizePath(path);
  const segments: string[] = [];
  let current = "";
  let last = 0;
  const push = (text: string) => {
    const parts = text.split(".");
    current += parts[0];
    for (let i = 1; i < parts.length; i++) {
      segments.push(current);
      current = parts[i];
    }
  };
  for (const match of normalized.matchAll(ESCAPED_SPAN)) {
    push(normalized.slice(last, match.index));
    current += match[0];
    last = match.index + match[0].length;
  }
  push(normalized.slice(last));
  segments.push(current);
  return segments.map(unescapeSegment);
}

/**
 * Strips the standard {@link PREFIX} from a box key.
 *
 * @param {string} key The full box key.
 * @return {string} The path without prefix.
 */
export function stripPrefix(key: string): string {
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
}

/**
 * Recursively generates the paths for all leaves in an object, formatted as dot notation.
 * Arrays are indexed with the canonical `[N]` form and object keys containing reserved
 * characters are escaped as `${...}`. Scalars, `null` and empty containers are leaves.
 *
 * @example
 * ```TypeScript
 * // Define an object
 * const animal = {
 *   type: "cat",
 *   petName: "Corey",
 *   tags: ["a", "b"],
 * }
 * // List of paths for this object
 * const paths = toPaths(animal)
 * // ["type", "petName", "tags[0]", "tags[1]"]
 * ```
 *
 * @param {unknown} obj The object or array for which to generate key paths.
 * @param {string} parentKey The path of the parent, used to build the complete key paths.
 * @return {string[]} An array of strings representing the paths of the leaves in dot notation.
 */
export function toPaths(obj: unknown, parentKey?: string): string[] {
  if (Array.isArray(obj) && obj.length > 0) {
    // Map the Array to paths
    return obj.flatMap((item, idx) =>
      toPaths(item, `${parentKey || ""}[${idx}]`),
    );
  }
  if (isPlainObject(obj) && Object.keys(obj).length > 0) {
    // Map the Object Keys to paths
    return Object.keys(obj).flatMap((key) =>
      toPaths(obj[key], escapeSegment(key)).map(
        (subkey: string) => `${parentKey ? `${parentKey}.` : ""}${subkey}`,
      ),
    );
  }
  // Leaf (scalar, null, or empty container): the path is the parent key itself
  return typeof parentKey === "undefined" ? [] : [parentKey];
}

/**
 * Checks for a plain object (not an array, `null`, class instance, etc.).
 *
 * @protected
 */
export function isPlainObject(obj: unknown): obj is KeyValueMap {
  return Object.prototype.toString.call(obj) === "[object Object]";
}
