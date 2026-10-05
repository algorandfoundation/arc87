import {
  abimethod,
  assert,
  BoxMap,
  Bytes,
  baremethod,
  type bytes,
  Contract,
  Global,
  GlobalState,
  itxn,
  op,
  TemplateVar,
  Txn,
  type uint64,
} from "@algorandfoundation/algorand-typescript";

// This contract is a simple key-value store that allows you to set and get values from boxes

const PREFIX = "o_";
const MAX_KEY_SIZE: uint64 = 64; // bytes, including the prefix
const MAX_BOX_SIZE: uint64 = 32_768; // bytes
const MAX_EXTRACT: uint64 = 1018; // bytes: 1024-byte log cap - 4-byte return prefix - 2-byte length

/**
 * Simple Contract for storing key-value pairs.
 *
 * Writes are creator-only. The boxes are exposed to other applications through
 * AVM 13 foreign box reads (`AppForeignBoxReads`, always enabled on create) and
 * to everyone off-chain through the algod box API; the public `readonly`
 * methods `length` and `extract` cover what fits in a single log.
 *
 * Every value is capped at `maxValue` bytes, fixed at create (32 KiB by default,
 * or the argument of `create(uint64)`). Consumers read the cap with
 * `app_global_get_ex` to know whether every leaf fits on the AVM stack.
 */
export class ARC87 extends Contract {
  /** Boxes that store the public object (UTF-8 text via `set`, raw bytes via `setBytes`) */
  public = BoxMap<string, bytes>({ keyPrefix: PREFIX });

  /** Immutable per-value size cap in bytes, set at create. */
  maxValue = GlobalState<uint64>({ key: "maxValue" });

  /** Never while rekeying (every method, reads included). */
  private assertNoRekey(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, "rekey not allowed");
  }

  /** Only the creator may call, and never while rekeying. */
  private authorize(): void {
    this.assertNoRekey();
    assert(Txn.sender === Global.creatorAddress, "creator only");
  }

  /** The full box key (prefix + path) must be non-empty and fit in 64 bytes. */
  private assertKey(path: string): void {
    const length = Bytes(path).length;
    assert(length > 0, "path must not be empty");
    assert(
      length + Bytes(PREFIX).length <= MAX_KEY_SIZE,
      "key exceeds 64 bytes",
    );
  }

  /** A box value may not exceed the store's `maxValue`. */
  private assertValue(length: uint64): void {
    assert(length <= this.maxValue.value, "value exceeds maxValue");
  }

  /**
   * Shared create logic: never while rekeying, record the value cap and make
   * the boxes readable by other applications from the start.
   */
  private init(maxValue: uint64): void {
    this.assertNoRekey();
    assert(maxValue > 0 && maxValue <= MAX_BOX_SIZE, "maxValue out of range");
    this.maxValue.value = maxValue;
    op.AppParamsSet.appForeignBoxReads(true);
  }

  /** Store `value` under `path`, replacing any previous value. */
  private put(path: string, value: bytes): void {
    this.assertKey(path);
    this.assertValue(value.length);
    this.public(path).value = value;
  }

  /**
   * Append `value` to an existing box without loading the current contents onto
   * the AVM stack (which is capped at 4096 bytes). Resize + replace keeps the
   * full 32 KiB box-value ceiling reachable via chunked `set`/`concat` calls.
   */
  private append(path: string, value: bytes): void {
    const box = this.public(path);
    assert(box.exists, "path not found");
    const oldLen = box.length;
    const newLen: uint64 = oldLen + value.length;
    this.assertValue(newLen);
    box.resize(newLen);
    box.replace(oldLen, value);
  }

  /**
   * Create the contract (the sender becomes the creator) with the default
   * 32 KiB value cap.
   */
  @baremethod({ onCreate: "require" })
  public onCreate(): void {
    this.init(MAX_BOX_SIZE);
  }

  /**
   * Create the contract with a custom value cap (`0 < maxValue <= 32768`).
   * A cap of 4094 or less guarantees every leaf can be loaded whole onto the
   * AVM stack and decoded as an ARC-4 struct by a consuming contract.
   */
  @abimethod({ onCreate: "require" })
  public create(maxValue: uint64): void {
    this.init(maxValue);
  }

  /** Delete the contract. */
  @baremethod({ allowActions: "DeleteApplication" })
  public onDelete(): void {
    this.authorize();
    assert(TemplateVar<uint64>("DELETABLE"), "not deletable");
  }

  /** Update the contract. */
  @baremethod({ allowActions: "UpdateApplication" })
  public onUpdate(): void {
    this.authorize();
    assert(TemplateVar<uint64>("UPDATABLE"), "not updatable");
  }

  /** Set a text value in the public object. */
  @abimethod()
  public set(path: string, value: string): void {
    this.authorize();
    this.put(path, Bytes(value));
  }

  /** Set a raw bytes value (e.g. an ARC-4 encoded leaf) in the public object. */
  @abimethod()
  public setBytes(path: string, value: bytes): void {
    this.authorize();
    this.put(path, value);
  }

  /** Append text to an existing value. */
  @abimethod()
  public concat(path: string, value: string): void {
    this.authorize();
    this.append(path, Bytes(value));
  }

  /** Append raw bytes to an existing value. */
  @abimethod()
  public concatBytes(path: string, value: bytes): void {
    this.authorize();
    this.append(path, value);
  }

  /** Remove a value from the public object. */
  @abimethod()
  public remove(path: string): void {
    this.authorize();
    assert(this.public(path).exists, "path not found");
    this.public(path).delete();
  }

  /** Reclaim any ALGO that was sent to the contract by the creator. */
  @abimethod()
  public reclaim(amount: uint64): void {
    this.authorize();
    assert(amount > 0, "amount must be positive");
    const app = Global.currentApplicationAddress;
    assert(
      app.balance - amount >= app.minBalance,
      "cannot reclaim below minimum balance",
    );
    itxn
      .payment({
        sender: app,
        receiver: Global.creatorAddress,
        amount,
        fee: 0,
      })
      .submit();
  }

  /** Size in bytes of the value stored under `path`. */
  @abimethod({ readonly: true })
  public length(path: string): uint64 {
    this.assertNoRekey();
    assert(this.public(path).exists, "path not found");
    return this.public(path).length;
  }

  /**
   * A slice of the value stored under `path`; fails when the range is out of
   * bounds or longer than 1018 bytes, the most that fits the 1024-byte log cap
   * of a readonly call (4-byte return prefix + 2-byte length). Larger reads go
   * through `app_box_extract` on-chain or the algod box API off-chain.
   */
  @abimethod({ readonly: true })
  public extract(path: string, offset: uint64, length: uint64): bytes {
    this.assertNoRekey();
    assert(length <= MAX_EXTRACT, "slice exceeds 1018 bytes");
    const box = this.public(path);
    assert(box.exists, "path not found");
    assert(offset + length <= box.length, "extract out of range");
    return box.extract(offset, length);
  }
}
