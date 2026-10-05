/**
 * A box as stored on chain: full key (prefix included) and value, either UTF-8
 * text (written with `set`/`concat`) or raw bytes such as an ARC-4 encoded leaf
 * (written with `setBytes`/`concatBytes`).
 */
export type KeyValue = [key: string, value: string | Uint8Array];

/**
 * Selects the leaves whose box value is returned as raw `Uint8Array` by
 * `assemble` / `fromBoxes` instead of being decoded as text: a list of
 * (un-prefixed) paths, `[N]` and `.N` index forms being equivalent, or a
 * predicate over the un-prefixed path.
 */
export type BinaryFilter = string[] | ((path: string) => boolean);

/**
 * Options of `assemble` / `fromBoxes`.
 */
export type AssembleOptions = {
  /** Leaves to keep as raw bytes, see {@link BinaryFilter}. Everything else is text. */
  binary?: BinaryFilter;
};

/**
 * A changed leaf as reported by `diff`: prefixed key and the new (raw) value,
 * `undefined` when the leaf was removed.
 */
export type Change = [key: string, value: unknown];

export type KeyValueMap = Record<string, unknown>;
