# ARC-87 Reference Implementation

Reference implementation of [ARC-87: Key Name Specification](https://github.com/algorandfoundation/ARCs/blob/main/ARCs/arc-0087.md),
a standard for storing complex data (JSON, blobs, …) in Algorand box storage as flat `key → value` pairs.

This repository is an **AlgoKit workspace** with three projects:

| Project | Contents |
|---------|----------|
| `projects/conformance` | **`@algorandfoundation/arc87`**: JSON test vectors and a pure TypeScript library (`toBoxes`, `toMBR`, `fromBoxes`, …) |
| `projects/arc-87-ts` | Algorand TypeScript store and reader contracts, typed clients, `deploy()` helper, demo and tests |
| `projects/arc-87-py` | Algorand Python store and reader contracts with the same ABI, plus pytest suite |

Object stores, adapters, conflict resolution and schema packing are out of scope. They belong in downstream
libraries such as [StoreKit](https://storekit.io).

## Key names at a glance

Each leaf of a JSON object (a scalar or an empty container) becomes one box:

```text
key   = "o_" + path
path  = segment ( "." segment | "[" N "]" )*
```

| Rule | Example |
|------|---------|
| Keys are prefixed with `o_` | `{"alice": …}` → `o_alice` |
| Nested keys are joined with `.` | `{"metadata":{"rp":…}}` → `o_metadata.rp` |
| Array items use `[N]`; readers also accept `.N` | `o_blobs[1]` ≡ `o_blobs.1` |
| Segments containing `.` `[` `]` `$` `{` are escaped as `${…}` | `{"a.b": 1}` → `o_${a.b}` |
| A full key is at most 64 UTF-8 bytes | longer keys throw `MaxSizeError` |
| A value is at most 32 KiB (or the store's `maxValue`) | larger values throw `MaxSizeError` |
| Minimum balance = `100 000 + Σ (2 500 + 400 × (keyBytes + valueBytes))` | `{"heyzzz":"you"}` → `106 900` µALGO |

The root value must be an object. The vectors in `projects/conformance/vectors/` define every rule and are shared by
both languages.

## Getting started

Requires Node.js ≥ 20 and [AlgoKit](https://dev.algorand.co/getting-started/algokit-quick-start/) ≥ 2.6 (with Docker
for localnet). Python ≥ 3.12 and Poetry are only needed for `projects/arc-87-py`.

```bash
algokit localnet start             # optional: deploy, demo and integration tests
algokit project bootstrap all      # install npm + Poetry dependencies
algokit project run build          # compile contracts, generate clients, build the library
algokit project run test           # offline tests (TS + Python)
algokit project run lint           # Biome
algokit project deploy             # localnet demo
npm run test:integration -w projects/arc-87-ts   # localnet integration tests
```

The npm equivalents at the workspace root are `npm run build`, `npm test`, `npm run typecheck` and `npm run lint`.

## Using a store

```ts
import { fromBoxes } from "@algorandfoundation/arc87";
import { deploy } from "./projects/arc-87-ts/src/deploy.js"; // workspace helper, not published

const appId = await deploy(algorand, deployer, "animal-1", { type: "cat", tags: ["a", "b"] });
const obj = await fromBoxes(algorand, appId); // { type: "cat", tags: ["a", "b"] }
```

`deploy()` funds the minimum balance and writes every leaf, splitting large values across calls automatically. Other
contracts read the boxes directly through AVM 13 foreign box reads. To let them decode leaves as ARC-4 structs, deploy
with `{ maxValue: 4094 }`. See [Working with large values](./docs/avm-limits.md) for chunking, fees and on-chain reads.

## Contract ABI (ARC-56)

The TypeScript and Python store contracts expose the same surface:

| Method | Signature | Access |
|--------|-----------|--------|
| `set` / `setBytes` | `(string,string)void` / `(string,byte[])void` | creator |
| `concat` / `concatBytes` | `(string,string)void` / `(string,byte[])void` | creator |
| `remove` | `(string)void` | creator |
| `reclaim` | `(uint64)void` | creator |
| `length` | `(string)uint64` | public, `readonly` |
| `extract` | `(string,uint64,uint64)byte[]` | public, `readonly`, ≤ 1018 bytes |
| `create` | `(uint64)void` | create with a custom `maxValue` (1 – 32768) |
| bare create | `NoOp` | create with `maxValue = 32768` |
| bare delete / update | `DeleteApplication` / `UpdateApplication` | creator, gated by `DELETABLE` / `UPDATABLE` |

- Global state: `maxValue` (`uint64`). It is fixed at create and enforced on every write.
- Boxes: one `o_` map holds both text and raw-bytes leaves.
- Every method rejects rekeying, and the boxes are always readable by other applications.
- Both projects also ship `ARC87Reader`, a small example consumer that reads a store from another contract.

## Troubleshooting localnet

- Localnet runs in DevMode: blocks are only produced when transactions arrive, so a large "time since last round" is
  normal on an idle node.
- `fetch failed` / `UND_ERR_SOCKET` when running many parallel `AppFactory.deploy({ ignoreCache: true })` calls is an
  indexer connection issue, not a box or AVM issue. Limit concurrency, or look up the creator's apps once and reuse
  them.

## Package

Publishing to npm is **TBD**. Until then, use the library from this workspace: `npm install` at the root links
`projects/conformance` as `@algorandfoundation/arc87`.

See [`projects/conformance/README.md`](./projects/conformance/README.md) for the API.

## License

[CC0 1.0 Universal](./LICENSE) — public domain, in line with the ARC itself.
