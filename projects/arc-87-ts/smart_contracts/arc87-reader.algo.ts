import {
  abimethod,
  arc4,
  assert,
  Bytes,
  baremethod,
  type bytes,
  Contract,
  Global,
  op,
  Txn,
  type uint64,
} from "@algorandfoundation/algorand-typescript";

// This contract consumes the boxes of an ARC87 store from another application

const PREFIX = "o_";
const UINT64_SIZE: uint64 = 8; // bytes
const MAX_EXTRACT: uint64 = 1018; // bytes: 1024-byte log cap - 4-byte return prefix - 2-byte length
const MAX_STRUCT_SIZE: uint64 = 4094; // bytes: largest leaf loaded whole onto the stack (4096 - 2-byte ABI prefix)
const PACKED_SIZE: uint64 = 16; // bytes: two uint64 fields

/** A static ARC-4 struct leaf: `(uint64,uint64)`, 16 bytes. */
export class PackedValue extends arc4.Struct<{
  a: arc4.Uint64;
  b: arc4.Uint64;
}> {}

/** A dynamic ARC-4 struct leaf: `(uint64,string,byte[])`, sized by its two dynamic fields. */
export class Record extends arc4.Struct<{
  id: arc4.Uint64;
  tags: arc4.Str;
  payload: arc4.DynamicBytes;
}> {}

/**
 * Minimal consumer of an `ARC87` store deployed as a sibling application.
 *
 * Every read uses the AVM 13 `app_box_*` opcodes against the store's boxes
 * (an `ARC87` store enables `AppForeignBoxReads` on create). Every method is
 * public and `readonly`; the slices returned through a log are capped at 1018
 * bytes, larger values are read in a loop of `app_box_extract` calls by the
 * consuming contract itself.
 *
 * Leaves of at most `MAX_STRUCT_SIZE` (4094) bytes are loaded whole with
 * `app_box_get` and decoded as ARC-4 structs (`readPacked`, `readRecord`): a
 * store whose `maxValue` global is `<= 4094` guarantees that for every leaf.
 */
export class ARC87Reader extends Contract {
  /** Never while rekeying (every method). */
  private assertNoRekey(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, "rekey not allowed");
  }

  /** The full box key of `path` in the store (`o_` + path). */
  private key(path: string): bytes {
    return Bytes(PREFIX).concat(Bytes(path));
  }

  /**
   * The whole leaf under `path` in `store` on the stack. The size is checked
   * first so an oversized leaf fails with a descriptive assert instead of the
   * AVM's `box_get produced a too big byte-array`.
   */
  private leaf(store: uint64, path: string): bytes {
    const key = this.key(path);
    const [size, exists] = op.AppBox.length(store, key);
    assert(exists, "path not found in store");
    assert(size <= MAX_STRUCT_SIZE, "leaf exceeds 4094 bytes");
    const [value] = op.AppBox.get(store, key);
    return value;
  }

  /** The 16-byte leaf under `path` decoded as a `PackedValue`. */
  private packed(store: uint64, path: string): PackedValue {
    const raw = this.leaf(store, path);
    assert(raw.length === PACKED_SIZE, "leaf is not a PackedValue");
    return arc4.convertBytes<PackedValue>(raw, { strategy: "validate" });
  }

  /** Create the contract; never while rekeying. */
  @baremethod({ onCreate: "require" })
  public onCreate(): void {
    this.assertNoRekey();
  }

  /** Size in bytes of the value stored under `path` in application `store`. */
  @abimethod({ readonly: true })
  public readLength(store: uint64, path: string): uint64 {
    this.assertNoRekey();
    const [length, exists] = op.AppBox.length(store, this.key(path));
    assert(exists, "path not found in store");
    return length;
  }

  /**
   * A slice of the value stored under `path` in application `store`; fails when
   * the range is out of bounds or longer than 1018 bytes (the log cap of a
   * readonly call).
   */
  @abimethod({ readonly: true })
  public readBytes(
    store: uint64,
    path: string,
    offset: uint64,
    length: uint64,
  ): bytes {
    this.assertNoRekey();
    assert(length <= MAX_EXTRACT, "slice exceeds 1018 bytes");
    const key = this.key(path);
    const [size, exists] = op.AppBox.length(store, key);
    assert(exists, "path not found in store");
    assert(offset + length <= size, "extract out of range");
    return op.AppBox.extract(store, key, offset, length);
  }

  /**
   * The 8-byte big-endian (ARC-4 `uint64`) leaf stored under `path` in
   * application `store`. The size is checked before the value is read, so a
   * leaf of any other size (including boxes too large for `app_box_get`)
   * fails with a descriptive assert.
   */
  @abimethod({ readonly: true })
  public readUint64(store: uint64, path: string): uint64 {
    this.assertNoRekey();
    const key = this.key(path);
    const [size, exists] = op.AppBox.length(store, key);
    assert(exists, "path not found in store");
    assert(size === UINT64_SIZE, "leaf is not a uint64");
    return op.btoi(op.AppBox.extract(store, key, 0, UINT64_SIZE));
  }

  /**
   * The per-value size cap of application `store` (its `maxValue` global, set
   * by the `ARC87` create). A cap of 4094 or less means every leaf of the store
   * can be decoded whole by `readPacked` / `readRecord`.
   */
  @abimethod({ readonly: true })
  public maxValue(store: uint64): uint64 {
    this.assertNoRekey();
    const [value, exists] = op.AppGlobal.getExUint64(store, Bytes("maxValue"));
    assert(exists, "store has no maxValue");
    return value;
  }

  /** The 16-byte `PackedValue { a, b }` leaf under `path` in `store`, decoded whole. */
  @abimethod({ readonly: true })
  public readPacked(store: uint64, path: string): PackedValue {
    this.assertNoRekey();
    return this.packed(store, path);
  }

  /** `a + b` of the `PackedValue` leaf under `path`: arithmetic on decoded fields. */
  @abimethod({ readonly: true })
  public sumPacked(store: uint64, path: string): uint64 {
    this.assertNoRekey();
    const value = this.packed(store, path);
    return value.a.asUint64() + value.b.asUint64();
  }

  /**
   * The dynamic `Record { id, tags, payload }` leaf under `path` in `store`
   * (up to 4094 bytes) decoded whole on the stack; returns
   * `(id, payload.length, sha256(payload))` — a 48-byte result that proves
   * there is budget left for work on the decoded struct, instead of the
   * struct itself, which could not fit the 1024-byte log cap.
   */
  @abimethod({ readonly: true })
  public readRecord(
    store: uint64,
    path: string,
  ): readonly [uint64, uint64, bytes<32>] {
    this.assertNoRekey();
    const raw = this.leaf(store, path);
    const record = arc4.convertBytes<Record>(raw, { strategy: "validate" });
    const payload = record.payload.native;
    return [record.id.asUint64(), payload.length, op.sha256(payload)];
  }
}
