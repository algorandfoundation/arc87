# @algorandfoundation/arc87

Reference conformance package for [ARC-87: Key Name Specification](https://github.com/algorandfoundation/ARCs/blob/main/ARCs/arc-0087.md).

It contains:

- `vectors/`: language-neutral JSON test vectors (`paths`, `normalize`, `escape`, `mbr`), the source of truth for
  every key-name rule.
- `src/`: a pure TypeScript implementation of those rules, with no dependency on a compiled contract.

Installation: **TBD**, the package is not published to npm yet. Inside this workspace it is linked as
`@algorandfoundation/arc87` by `npm install` at the root.

```ts
import {
  toBoxes,
  toMBR,
  fromBoxes,
  normalizePath,
  MaxSizeError,
  PREFIX,
} from "@algorandfoundation/arc87";

const obj = { metadata: { rp: "algorand.co" }, tags: ["a", "b"] };
const boxes = toBoxes(obj); // [["o_metadata.rp", "algorand.co"], ["o_tags[0]", "a"], …]
const mbr = toMBR(obj);     // minimum balance in microAlgos (bigint)
```

## API

| Export | Description |
| --- | --- |
| `toPaths(obj)`, `toBoxes(obj)`, `toChunks(obj, size?)` | Flatten an object into paths, `[key, value]` boxes or groups of paths. Text is stored as UTF-8; `Uint8Array` leaves are stored unchanged. |
| `assemble(kvs, { binary? })`, `fromBoxes(algorand, appId, { binary? })` | Rebuild the object from boxes. Values are decoded as text unless their path is listed in `binary`. |
| `serialize(value)`, `deserialize(text)` | Convert between a leaf and a box value. |
| `diff(a, b)`, `deepMerge(target, source)` | Find changed leaves, or merge recursively. |
| `normalizePath`, `toSegments`, `escapeSegment`, `unescapeSegment`, `isReserved`, `stripPrefix`, `byteLength` | Key-name helpers. |
| `chunkValue(value, size)`, `chunkKeyValue(key, value)` | Split a value into chunks of at most `size` bytes. Text is split at character boundaries. |
| `toMBR(obj)`, `boxesToMBR(boxes)` | Minimum balance requirement in µALGO. |
| `surchargeFor(encodedArgBytes, minFee?)` | Extra fee for application arguments over 2048 bytes (0.1 µALGO per byte). |
| `assertFits(boxes, maxValue)` | Throw `MaxSizeError` if any value exceeds a store's `maxValue`. |
| `MAX_BOX_SIZE` 32768, `MAX_KEY_SIZE` 64, `MAX_STRUCT_SIZE` 4094, `MAX_ABI_SIZE` 2048, `MAX_ARG_SIZE` 16384, `MAX_AVM_BYTES` 4096, `MIN_FEE`, `MIN_BALANCE`, `PER_BOX`, `PER_UNIT`, `PER_BYTE_SURCHARGE`, `PREFIX`, `GROUP_SIZE`, `RESERVED_CHARACTERS` | Constants. `MAX_STRUCT_SIZE` is the recommended leaf size for decoding ARC-4 structs on-chain (see [Working with large values](../../docs/avm-limits.md)). |
| `MaxSizeError`, `ALGORAND_CLIENT_REQUIRED`, `APPLICATION_ID_REQUIRED` | Errors. |
| `KeyValue`, `Change`, `BinaryFilter`, `AssembleOptions` | Types. `KeyValue` is `[key: string, value: string \| Uint8Array]`. |

## Vector format

Each file in `vectors/` contains a `$comment` describing the rule, shared constants and a list of named cases. The
TypeScript and Python tests both run every case:

```json
{
  "name": "spec: blobs[1] and blobs.1 are the same slot",
  "inputs": ["o_blobs[1]", "o_blobs.1"],
  "normalized": ["o_blobs.1", "o_blobs.1"]
}
```

## Development

```sh
npm run build      # tsc → lib/
npm test           # vitest vector tests
npm run typecheck
npm pack --dry-run # lists lib, vectors, README.md, LICENSE
```

Run from the workspace root with `npm run build -w projects/conformance` /
`npm test -w projects/conformance`, or via `algokit project run build|test` which fans out to all projects.
