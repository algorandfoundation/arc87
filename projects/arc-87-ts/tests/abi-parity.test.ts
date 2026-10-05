/**
 * Both reference implementations of the store (`arc87.algo.ts` / `arc87.py`) and of
 * the reader (`arc87-reader.algo.ts` / `arc87_reader.py`) must expose the same ARC-56
 * surface so their typed clients are interchangeable. Skipped when either artifact has
 * not been built (`npm run build:compile` here / `algokit project run build` in
 * `projects/arc-87-py`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Arc56 = {
  name: string;
  methods: {
    name: string;
    args: { type: string; name?: string }[];
    returns: { type: string; struct?: string };
    actions: { create: string[]; call: string[] };
    readonly?: boolean;
  }[];
  bareActions: { create: string[]; call: string[] };
  templateVariables?: Record<string, { type: string }>;
  structs?: Record<string, { name: string; type: string }[]>;
  state: {
    schema: {
      global: { ints: number; bytes: number };
      local: { ints: number; bytes: number };
    };
    keys: {
      global: Record<
        string,
        { key: string; keyType: string; valueType: string }
      >;
      box: Record<string, { key: string; keyType: string; valueType: string }>;
    };
    maps: {
      box: Record<
        string,
        { prefix?: string; keyType: string; valueType: string }
      >;
    };
  };
};

function artifacts(contract: string): { ts: string; py: string } {
  return {
    ts: fileURLToPath(
      new URL(
        `../smart_contracts/artifacts/${contract}.arc56.json`,
        import.meta.url,
      ),
    ),
    py: fileURLToPath(
      new URL(
        `../../arc-87-py/smart_contracts/artifacts/${contract}.arc56.json`,
        import.meta.url,
      ),
    ),
  };
}

function load(path: string): Arc56 {
  return JSON.parse(readFileSync(path, "utf8")) as Arc56;
}

function signature(method: Arc56["methods"][number]): string {
  return `${method.name}(${method.args.map((a) => a.type).join(",")})${method.returns.type}`;
}

/** The fixed ARC-56 surface of the store: `true` marks the public `readonly` reads. */
const STORE_METHODS: Record<string, boolean> = {
  "create(uint64)void": false,
  "set(string,string)void": false,
  "setBytes(string,byte[])void": false,
  "concat(string,string)void": false,
  "concatBytes(string,byte[])void": false,
  "remove(string)void": false,
  "reclaim(uint64)void": false,
  "length(string)uint64": true,
  "extract(string,uint64,uint64)byte[]": true,
};

/** The fixed ARC-56 surface of the reader: every direct `app_box_*` read is `readonly`. */
const READER_METHODS: Record<string, boolean> = {
  "readLength(uint64,string)uint64": true,
  "readBytes(uint64,string,uint64,uint64)byte[]": true,
  "readUint64(uint64,string)uint64": true,
  "maxValue(uint64)uint64": true,
  "readPacked(uint64,string)(uint64,uint64)": true,
  "sumPacked(uint64,string)uint64": true,
  "readRecord(uint64,string)(uint64,uint64,byte[32])": true,
};

/**
 * ARC-4 structs the reader exposes through its ABI (`Record` is decode-only and
 * therefore not part of the ARC-56 `structs` section).
 */
const READER_STRUCTS: Record<string, { name: string; type: string }[]> = {
  PackedValue: [
    { name: "a", type: "uint64" },
    { name: "b", type: "uint64" },
  ],
};

type ContractSpec = {
  name: string;
  sources: string;
  methods: Record<string, boolean>;
  createMethods: string[];
  bareCalls: string[];
  templateVariables: string[];
  globalInts: number;
  structs: Record<string, { name: string; type: string }[]>;
};

const CONTRACTS: ContractSpec[] = [
  {
    name: "ARC87",
    sources: "arc87.algo.ts and arc87.py",
    methods: STORE_METHODS,
    createMethods: ["create(uint64)void"],
    bareCalls: ["DeleteApplication", "UpdateApplication"],
    templateVariables: ["DELETABLE", "UPDATABLE"],
    globalInts: 1,
    structs: {},
  },
  {
    name: "ARC87Reader",
    sources: "arc87-reader.algo.ts and arc87_reader.py",
    methods: READER_METHODS,
    createMethods: [],
    bareCalls: [],
    templateVariables: [],
    globalInts: 0,
    structs: READER_STRUCTS,
  },
];

describe.each(CONTRACTS)(
  "ARC-56 parity of $name between $sources",
  ({
    name,
    methods: expected,
    createMethods,
    bareCalls,
    templateVariables,
    globalInts,
    structs,
  }) => {
    const paths = artifacts(name);
    const bothBuilt = existsSync(paths.ts) && existsSync(paths.py);
    // `describe.skipIf` would leave the file with zero registered tests, which vitest
    // treats as a failure; skipping each test keeps the parity check visible as
    // "skipped" instead.
    const test = it.skipIf(!bothBuilt);
    const specs = () => ({ ts: load(paths.ts), py: load(paths.py) });

    test("exposes the same methods", () => {
      const { ts, py } = specs();
      const tsMethods = ts.methods.map(signature).sort();
      const pyMethods = py.methods.map(signature).sort();
      expect(tsMethods).toEqual(pyMethods);
      expect(tsMethods).toEqual(Object.keys(expected).sort());
    });

    test("marks the same methods readonly", () => {
      const { ts, py } = specs();
      const readonly = (spec: Arc56) =>
        Object.fromEntries(
          spec.methods.map((m) => [signature(m), m.readonly === true]),
        );
      expect(readonly(ts)).toEqual(readonly(py));
      expect(readonly(ts)).toEqual(expected);
    });

    test("allows the same actions per method", () => {
      const { ts, py } = specs();
      const actions = (spec: Arc56) =>
        Object.fromEntries(spec.methods.map((m) => [signature(m), m.actions]));
      expect(actions(ts)).toEqual(actions(py));
      for (const m of ts.methods) {
        // The ABI `create` is create-only; everything else is a plain NoOp call.
        expect(m.actions).toEqual(
          createMethods.includes(signature(m))
            ? { create: ["NoOp"], call: [] }
            : { create: [], call: ["NoOp"] },
        );
      }
    });

    test("uses the same global state", () => {
      const { ts, py } = specs();
      expect(ts.state.schema).toEqual(py.state.schema);
      expect(ts.state.schema.global).toEqual({ ints: globalInts, bytes: 0 });
      expect(ts.state.schema.local).toEqual({ ints: 0, bytes: 0 });
      // ARC-56 names global keys after the source attribute (`maxValue` vs
      // `max_value`); the on-chain key bytes and types must match exactly.
      const shape = (spec: Arc56) =>
        Object.values(spec.state.keys.global)
          .map((k) => ({
            key: k.key,
            keyType: k.keyType,
            valueType: k.valueType,
          }))
          .sort((a, b) => a.key.localeCompare(b.key));
      expect(shape(ts)).toEqual(shape(py));
      if (name === "ARC87") {
        expect(ts.state.keys.global.maxValue).toMatchObject({
          key: Buffer.from("maxValue").toString("base64"),
          keyType: "AVMString",
          valueType: "AVMUint64",
        });
      } else {
        expect(ts.state.keys.global).toEqual({});
      }
    });

    test("exposes the same bare actions", () => {
      const { ts, py } = specs();
      expect(ts.bareActions).toEqual(py.bareActions);
      expect([...ts.bareActions.call].sort()).toEqual(bareCalls);
      expect(ts.bareActions.create).toEqual(["NoOp"]);
    });

    test("declares the same ARC-4 structs", () => {
      const { ts, py } = specs();
      expect(ts.structs ?? {}).toEqual(py.structs ?? {});
      expect(ts.structs ?? {}).toEqual(structs);
      // Methods returning a struct name it identically in both artifacts.
      const returned = (spec: Arc56) =>
        Object.fromEntries(
          spec.methods.map((m) => [signature(m), m.returns.struct ?? null]),
        );
      expect(returned(ts)).toEqual(returned(py));
      if (name === "ARC87Reader") {
        expect(returned(ts)["readPacked(uint64,string)(uint64,uint64)"]).toBe(
          "PackedValue",
        );
      }
    });

    test("exposes the same template variables", () => {
      const { ts, py } = specs();
      expect(ts.templateVariables ?? {}).toEqual(py.templateVariables ?? {});
      expect(Object.keys(ts.templateVariables ?? {}).sort()).toEqual(
        templateVariables,
      );
    });

    test("uses the same box map", () => {
      const { ts, py } = specs();
      // puya-ts also emits the JSDoc `desc`; only the storage shape must match.
      const shape = (spec: Arc56) =>
        Object.fromEntries(
          Object.entries(spec.state.maps.box).map(([name, m]) => [
            name,
            { prefix: m.prefix, keyType: m.keyType, valueType: m.valueType },
          ]),
        );
      expect(shape(ts)).toEqual(shape(py));
      expect(ts.state.keys.box).toEqual(py.state.keys.box);
      if (name === "ARC87") {
        expect(ts.state.maps.box.public?.prefix).toBe(
          Buffer.from("o_").toString("base64"),
        );
        // One map holds both text and ARC-4 leaves, so values are untyped bytes.
        expect(ts.state.maps.box.public?.valueType).toBe("AVMBytes");
      } else {
        // The reader owns no state at all: it only reads the store's boxes.
        expect(ts.state.maps.box).toEqual({});
        expect(ts.state.keys.box).toEqual({});
      }
    });
  },
);
