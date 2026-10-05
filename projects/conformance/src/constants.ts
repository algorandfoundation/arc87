/**
 * Maximum Box Value Size (bytes)
 *
 * @protected
 */
export const MAX_BOX_SIZE = 1024n * 32n;

/**
 * Maximum Key Name Size (bytes, including the prefix)
 *
 * @protected
 */
export const MAX_KEY_SIZE = 64n;

/**
 * Maximum size (bytes) of the arguments of a single ABI call at the flat
 * minimum fee (consensus `MaxAppTotalArgLen`); values larger than this are
 * written in chunks with `set` followed by `concat`.
 *
 * @protected
 */
export const MAX_ABI_SIZE = 2048n;

/**
 * Absolute maximum size (bytes) of the arguments of a single ABI call
 * (consensus v42 `MaxAbsoluteTotalArgLen`). Every byte over {@link MAX_ABI_SIZE}
 * is charged {@link PER_BYTE_SURCHARGE}.
 *
 * @protected
 */
export const MAX_ARG_SIZE = 16384n;

/**
 * Maximum size (bytes) of a single application argument — and of any AVM
 * byte-string (`MaxAVMBytesSize`, not a consensus parameter). algod rejects a
 * transaction whose argument exceeds it (`tx.ApplicationArgs[N] length is too
 * long`), so one ABI `string` / `byte[]` argument carries at most
 * `MAX_AVM_BYTES - 2` bytes of value after its length prefix, whatever the
 * total budget ({@link MAX_ARG_SIZE}) allows.
 *
 * @protected
 */
export const MAX_AVM_BYTES = 4096n;

/**
 * Recommended ceiling (bytes) for a leaf that a consuming contract decodes
 * whole on the AVM stack as an ARC-4 struct: `MAX_AVM_BYTES - 2`, the largest
 * value one `setBytes` call can carry (after the 2-byte ABI length prefix) and
 * comfortably under the 4096-byte cap of `app_box_get`. A store created with
 * `maxValue <= MAX_STRUCT_SIZE` guarantees every leaf is stack-decodable.
 *
 * @protected
 */
export const MAX_STRUCT_SIZE = MAX_AVM_BYTES - 2n;

/**
 * Fee surcharge per argument byte over {@link MAX_ABI_SIZE}, in millionths of
 * the minimum fee (consensus v42 `PerByteTxnSurcharge`): 100 → 0.1 µALGO per byte.
 *
 * @protected
 */
export const PER_BYTE_SURCHARGE = 100n;

/**
 * Minimum transaction fee (µALGO) assumed when no `minFee` is supplied.
 *
 * @protected
 */
export const MIN_FEE = 1_000n;

/**
 * Minimum Balance
 *
 * @protected
 */
export const MIN_BALANCE = 100_000n;

/**
 * Per Box Fee
 *
 * @protected
 */
export const PER_BOX = 2500n;

/**
 * Per Unit Fee
 *
 * @protected
 */
export const PER_UNIT = 400n;

/**
 * Standard Prefix
 *
 * @protected
 */
export const PREFIX = "o_";

/**
 * Characters that force a path segment to be escaped as `${...}`.
 *
 * @protected
 */
export const RESERVED_CHARACTERS = [".", "[", "]", "$", "{"] as const;

/**
 * Group Size
 *
 * @protected
 */
export const GROUP_SIZE = 16;
