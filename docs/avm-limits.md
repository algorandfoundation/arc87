# Working with large values

ARC-87 lets a value be up to 32 KiB. The reference contracts and `deploy()` handle storing values of that size for you.
This page covers the few AVM limits you will run into when you write values, read them, or use them from another
contract, and what to do about each one.

## At a glance

| You want to… | Do this | Limit to know |
|--------------|---------|---------------|
| Store any value up to 32 KiB | `deploy(algorand, deployer, name, obj)` | none, chunking is automatic |
| Read a value off-chain | `fromBoxes(algorand, appId)` or the algod box API | none |
| Read a value from another contract | `app_box_len` / `app_box_extract` / `app_box_get` on the store's `o_` box | ≤ 4096 bytes per opcode |
| Decode a leaf as an ARC-4 struct on-chain | create the store with `maxValue ≤ 4094`, then use `app_box_get` + decode | 4094 bytes per leaf |
| Return bytes from an ABI method | `extract(path, offset, length)` | ≤ 1018 bytes per call |

## Writing values

`deploy()` splits each value into calls that fit the AVM's limits:

- **Stack values are capped at 4096 bytes.** The contracts' `concat` / `concatBytes` grow the box in place
  (`resize` + `replace`), so the full value never has to sit on the stack.
- **Box I/O budget is 2048 bytes per access-list entry, with a maximum of 16 entries.** Every call that touches a box
  is charged for the box's full size. `accessRefsForBox(key, size)` adds the named box plus `ceil(size / 2048) - 1`
  empty entries. A 32 KiB box needs all 16.
- **Application arguments over 2048 bytes cost extra.** Consensus v42 adds 0.1 µALGO for each byte above 2048, and no
  single argument can exceed 4096 bytes.

| `chunkSize` | Calls for a 32 KiB value | Fee |
|-------------|--------------------------|-----|
| default (2048) | 17 | flat minimum fee per call |
| 4106 or more | 9 | `minFee + surchargeFor(encodedBytes)`, i.e. +206 µALGO per full 4094-byte chunk |

`surchargeFor(n)` from `@algorandfoundation/arc87` computes the exact surcharge if you build your own transactions.
If the fee is too low, algod rejects the transaction with `txgroup with 1mA fees is less than …`.

## Reading values

**Off-chain:** `fromBoxes(algorand, appId)` or `algorand.app.getBoxValue(appId, "o_" + path)` returns the whole value
in one request. Pass `{ binary: [...paths] }` to keep ARC-4 leaves as `Uint8Array`.

**On-chain:** every store enables AVM 13 foreign box reads when it is created, and this cannot be turned off. Another
contract reads the `o_<path>` box directly:

```text
(size, exists) = app_box_len(store, "o_" + path)
slice          = app_box_extract(store, "o_" + path, offset, n)   // n ≤ 4096; loop for larger values
```

On a real (non-simulated) call, the consumer's transaction must include the store app, the box and
`ceil(size / 2048) - 1` empty access entries. `accessRefsForBox(key, size, storeId)` builds the box entries.
`readonly` calls made through a typed client run under simulate and need none of this.

**Through the ABI:** an ARC-4 return is a log, and logs are capped at 1024 bytes. The store therefore offers only
`length(path)` and `extract(path, offset, length)` with `length ≤ 1018`. It has no `get` method, because `get` would
only work for values whose size the caller can't know in advance.

## ARC-4 struct leaves

A leaf of up to 4096 bytes fits in a single stack value. A consumer can load it whole with `app_box_get` and decode it
as an ARC-4 struct, with plenty of opcode budget left: on localnet, decoding a 4094-byte
`Record { id, tags, payload }` and hashing its payload used **145 of 700** opcodes.

To make this a guarantee rather than something you check per leaf, create the store with a cap:

```ts
await deploy(algorand, deployer, "packed", obj, { maxValue: Number(MAX_STRUCT_SIZE) }); // 4094
```

- The cap is stored in the store's `maxValue` global, cannot be changed and is enforced on every write
  (`value exceeds maxValue`). `deploy()` checks your object against it before sending anything.
- A consumer reads the cap with `app_global_get_ex(store, "maxValue")`, or off-chain through algod global state. If the
  cap is `≤ 4094`, every leaf can be decoded whole.
- The limit is 4094 rather than 4096 because 4094 is the largest value one `setBytes` call can carry, so a leaf at the
  limit is written in a single call (`chunkSize: 4106 + pathBytes`).
- Check `app_box_len` before `app_box_get`, so an oversized leaf fails with your own assert message instead of an AVM
  error. Return a derived result, not the whole struct, because ABI returns are still capped at 1018 bytes.
- The global costs the creator 28 500 µALGO of extra minimum balance.

| Tier | Max bytes | Write | On-chain read |
|------|-----------|-------|---------------|
| ABI-returnable | 1018 | 1 call | anything, including `extract` |
| Struct leaf | 4094 | 1 surcharged call, or 3 flat-fee calls | `app_box_get` + decode |
| ARC-87 maximum | 32768 | 9 surcharged calls, or 17 flat-fee calls | `app_box_extract` in ≤ 4096-byte slices |

`ARC87Reader` in both projects shows these patterns: `maxValue`, `readPacked`, `sumPacked` and `readRecord`.

## Errors you may see

| Error | Cause | Fix |
|-------|-------|-----|
| `read budget exceeded (N > 2048)` | too few access-list entries for a box of N bytes | `accessRefsForBox(key, N[, appId])` |
| `fees is less than …` | arguments over 2048 bytes paid at the flat fee | `minFee + surchargeFor(bytes)`, or the default `chunkSize` |
| `program logs too large` | an ABI return over 1018 bytes | read with `extract` in slices, or off-chain |
| `box_get produced a too big … byte-array` | `app_box_get` on a box over 4096 bytes | check `app_box_len` first, or use `app_box_extract` |
| `value exceeds maxValue` | the write would exceed the store's cap | use a smaller leaf, or a store with a larger cap |

## Verified on

algod 5.0.2 (consensus v42, AVM 13), puya-ts 1.3.1, puyapy 5.10.1, algorand-python 4.0.0, algokit-utils 9.2.2.
