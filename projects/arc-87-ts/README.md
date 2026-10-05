# arc-87-ts

Algorand TypeScript ([puya-ts](https://github.com/algorandfoundation/puya-ts)) implementation of the ARC-87 store
contract. It has the same ABI as the Python contract in `../arc-87-py` and uses
[`@algorandfoundation/arc87`](../conformance) for key names.

## Layout

| Path | Role |
|------|------|
| `smart_contracts/arc87.algo.ts` | Store contract |
| `smart_contracts/arc87-reader.algo.ts` | Example consumer that reads a store from another contract |
| `smart_contracts/*.algo.test.ts` | Offline unit tests |
| `src/deploy.ts` | `deploy()` helper: create, fund and write an object |
| `examples/demo.ts` | Localnet demo |
| `tests/*.integration.test.ts` | Localnet integration tests |
| `tests/abi-parity.test.ts` | Checks that the TS and Python ARC-56 specs match |

## Commands

```bash
npm run build               # compile → ARC-56 → typed clients → typecheck
npm test                    # offline tests
npm run test:integration    # needs `algokit localnet start`
npm run demo                # examples/demo.ts on localnet
algokit project run audit-teal   # Tealer audit (build first)
```

## Deploying objects

```ts
await deploy(algorand, deployer, "animal-1", { type: "cat" });
await deploy(algorand, deployer, "blob", { blob }, { chunkSize: 16384 });      // fewer, surcharged calls
await deploy(algorand, deployer, "packed", { packed }, { maxValue: 4094 });    // struct-decodable leaves
```

- Text leaves are written with `set` / `concat`, and `Uint8Array` leaves (for example ARC-4 encoded values) with
  `setBytes` / `concatBytes`.
- By default every call pays the flat minimum fee, so a 32 KiB value takes 17 calls. With a larger `chunkSize` the
  same value takes 9 calls, and `deploy()` adds the exact surcharge fee.
- `maxValue` caps every value in the store. The object is checked against the cap before anything is sent.
- Read objects back with `fromBoxes(algorand, appId, { binary: ["packed"] })`. Paths listed in `binary` come back as
  `Uint8Array`.

Limits and fees are covered in [Working with large values](../../docs/avm-limits.md).

## Reader contract

`ARC87Reader` is a stateless example of a contract that consumes a store. Each method takes the store's app id and a
path, and all of them are `readonly`:

| Method | What it shows |
|--------|---------------|
| `readLength(uint64,string)uint64` | box size via `app_box_len` |
| `readBytes(uint64,string,uint64,uint64)byte[]` | a slice via `app_box_extract` (≤ 1018 bytes, since it is returned) |
| `readUint64(uint64,string)uint64` | decoding an 8-byte leaf |
| `maxValue(uint64)uint64` | reading the store's cap via `app_global_get_ex` |
| `readPacked(uint64,string)PackedValue` / `sumPacked(uint64,string)uint64` | decoding a 16-byte struct and using its fields |
| `readRecord(uint64,string)(uint64,uint64,byte[32])` | decoding a dynamic struct of up to 4094 bytes and returning `(id, len(payload), sha256(payload))` |

A real (non-simulated) call needs the store's box in its access list. `accessRefsForBox(key, size, storeId)` from
`src/deploy.ts` builds the entries.
