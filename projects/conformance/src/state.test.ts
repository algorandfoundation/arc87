import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { describe, expect, it } from "vitest";
import { MAX_KEY_SIZE, PREFIX } from "./constants.js";
import {
  ALGORAND_CLIENT_REQUIRED,
  APPLICATION_ID_REQUIRED,
  MaxSizeError,
} from "./errors.js";
import {
  assemble,
  deepMerge,
  deserialize,
  diff,
  fromBoxes,
  serialize,
  toBoxes,
} from "./state.js";
import type { KeyValue } from "./type.js";
import {
  loadVectors,
  type MbrVectors,
  type PathsVectors,
} from "./vectors.test-util.js";

const paths = loadVectors<PathsVectors>("paths");
const mbr = loadVectors<MbrVectors>("mbr");

/**
 * Cases where `assemble(toBoxes(obj))` cannot reproduce the input exactly
 * because the key form is ambiguous on read (documented in the spec).
 */
const NOT_ROUND_TRIPPABLE = new Set([
  "numeric object keys are emitted as dotted (not indexed)",
]);

describe("toBoxes", () => {
  for (const c of mbr.cases) {
    it(c.name, () => {
      expect(toBoxes(c.object)).toEqual(c.boxes);
    });
  }
  it("requires an object", () => {
    expect(() => toBoxes(undefined)).toThrow(TypeError);
  });
  for (const c of mbr.errors.filter((c) => c.keyBytes > Number(MAX_KEY_SIZE))) {
    it(`rejects long keys instead of templating them: ${c.name}`, () => {
      const obj = { [c.key]: "a".repeat(c.valueLength) };
      expect(() => toBoxes(obj)).toThrow(MaxSizeError);
    });
  }
  it("accepts a key of exactly the maximum size (bytes, not characters)", () => {
    const ascii = "x".repeat(Number(MAX_KEY_SIZE) - PREFIX.length);
    const unicode = "é".repeat((Number(MAX_KEY_SIZE) - PREFIX.length) / 2);
    expect(toBoxes({ [ascii]: "v" })).toEqual([[`${PREFIX}${ascii}`, "v"]]);
    expect(toBoxes({ [unicode]: "v" })).toEqual([[`${PREFIX}${unicode}`, "v"]]);
    expect(() => toBoxes({ [`${ascii}x`]: "v" })).toThrow(MaxSizeError);
    expect(() => toBoxes({ [`${unicode}é`]: "v" })).toThrow(MaxSizeError);
  });
  it("passes Uint8Array leaves through untouched", () => {
    const count = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 42]);
    const boxes = toBoxes({ count, tags: [new Uint8Array([1]), "t"], n: 1 });
    expect(boxes).toEqual([
      [`${PREFIX}count`, count],
      [`${PREFIX}tags[0]`, new Uint8Array([1])],
      [`${PREFIX}tags[1]`, "t"],
      [`${PREFIX}n`, "1"],
    ]);
    expect(boxes[0][1]).toBe(count);
    // An empty Uint8Array is a leaf too (not an empty container).
    expect(toBoxes({ e: new Uint8Array(0) })).toEqual([
      [`${PREFIX}e`, new Uint8Array(0)],
    ]);
  });
});

describe("assemble", () => {
  describe("round-trips vectors/paths.json objects", () => {
    for (const c of paths.cases) {
      if (NOT_ROUND_TRIPPABLE.has(c.name)) continue;
      it(c.name, () => {
        expect(assemble(toBoxes(c.object))).toEqual(c.object);
      });
    }
    it("numeric object keys assemble as a (sparse) array", () => {
      const c = paths.cases.find((c) => NOT_ROUND_TRIPPABLE.has(c.name));
      expect(c).toBeDefined();
      const result = assemble<{ a: unknown[] }>(toBoxes(c?.object));
      expect(Array.isArray(result.a)).toBe(true);
      expect(result.a[1]).toBe("one");
    });
  });

  describe("round-trips vectors/mbr.json objects", () => {
    for (const c of mbr.cases) {
      it(c.name, () => {
        expect(assemble(c.boxes)).toEqual(c.object);
      });
    }
  });

  it("accepts [N] and .N for the same slot", () => {
    const canonical = assemble([
      [`${PREFIX}blobs[0]`, "x"],
      [`${PREFIX}blobs[1]`, "y"],
    ]);
    const dotted = assemble([
      [`${PREFIX}blobs.0`, "x"],
      [`${PREFIX}blobs.1`, "y"],
    ]);
    const mixed = assemble([
      [`${PREFIX}blobs[0]`, "x"],
      [`${PREFIX}blobs.1`, "y"],
    ]);
    expect(canonical).toEqual({ blobs: ["x", "y"] });
    expect(dotted).toEqual(canonical);
    expect(mixed).toEqual(canonical);
  });

  it("unescapes segments and does not normalize inside ${...}", () => {
    expect(
      assemble([
        [`${PREFIX}\${a.b}`, "1"],
        [`${PREFIX}x.\${c[0]}`, "y"],
        [`${PREFIX}\${a[1]}[2].c`, "z"],
      ]),
    ).toEqual({
      "a.b": 1,
      x: { "c[0]": "y" },
      "a[1]": [undefined, undefined, { c: "z" }],
    });
  });

  it("sorts top-level keys", () => {
    const result = assemble<Record<string, unknown>>([
      [`${PREFIX}b`, "1"],
      [`${PREFIX}a`, "2"],
    ]);
    expect(Object.keys(result)).toEqual(["a", "b"]);
  });

  it("treats a tilde span as an opaque escaped literal (no templating)", () => {
    // `${~...}` has no special meaning in ARC-87; a future specification may
    // define template selectors, until then the span is unwrapped like any other.
    expect(assemble([[`${PREFIX}\${~a.b}`, "v"]])).toEqual({ "~a.b": "v" });
  });

  describe("binary leaves", () => {
    const encoder = new TextEncoder();
    const count = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 42]);
    const kvs = [
      [`${PREFIX}count`, count],
      [`${PREFIX}name`, encoder.encode("cat")],
      [`${PREFIX}n`, encoder.encode("7")],
      [`${PREFIX}raw[0]`, new Uint8Array([0xff, 0x00])],
    ] satisfies KeyValue[];

    it("decodes every value as text by default", () => {
      expect(assemble(kvs)).toEqual({
        count: "\u0000\u0000\u0000\u0000\u0000\u0000\u0000*",
        name: "cat",
        n: 7,
        raw: ["\ufffd\u0000"],
      });
    });
    it("returns Uint8Array for the paths listed in `binary`", () => {
      const result = assemble<{ count: Uint8Array; name: string; n: number }>(
        kvs,
        { binary: ["count", "raw.0"] },
      );
      expect(result.count).toBeInstanceOf(Uint8Array);
      expect(result.count).toEqual(count);
      expect(result.name).toBe("cat");
      expect(result.n).toBe(7);
      // `[N]` and `.N` select the same slot
      expect(result).toEqual({
        count,
        name: "cat",
        n: 7,
        raw: [new Uint8Array([0xff, 0x00])],
      });
    });
    it("accepts a predicate over the un-prefixed path", () => {
      const result = assemble<Record<string, unknown>>(kvs, {
        binary: (path) => path.startsWith("raw"),
      });
      expect(result.raw).toEqual([new Uint8Array([0xff, 0x00])]);
      expect(result.name).toBe("cat");
    });
    it("encodes text values selected as binary", () => {
      expect(
        assemble([[`${PREFIX}name`, "cat"]], { binary: ["name"] }),
      ).toEqual({ name: encoder.encode("cat") });
    });
    it("round-trips toBoxes with Uint8Array leaves", () => {
      const obj = { count, meta: { rp: "x" }, list: [1, 2] };
      expect(assemble(toBoxes(obj), { binary: ["count"] })).toEqual(obj);
    });
  });
});

describe("serialize / deserialize", () => {
  it("round-trips scalars and empty containers", () => {
    for (const value of [1, -2, 0, "text", "", null, true, false, [], {}]) {
      expect(deserialize(serialize(value) as string)).toEqual(value);
    }
  });
  it("passes Uint8Array through serialize", () => {
    const bytes = new Uint8Array([1, 2]);
    expect(serialize(bytes)).toBe(bytes);
  });
  it("keeps non-numeric text as string", () => {
    expect(deserialize("12abc")).toBe("12abc");
    expect(deserialize("1.5")).toBe("1.5");
  });
  it("returns bigint beyond the safe integer range", () => {
    expect(deserialize("9007199254740993")).toBe(9007199254740993n);
  });
});

describe("diff", () => {
  it("returns changed leaves with prefixed keys", () => {
    const a = { alice: "A", metadata: { rp: "x" }, blobs: ["1", "2"] };
    const b = { alice: "A", metadata: { rp: "y" }, blobs: ["1", "2", "3"] };
    expect(diff(a, b)).toEqual([
      [`${PREFIX}metadata.rp`, "y"],
      [`${PREFIX}blobs[2]`, "3"],
    ]);
  });
  it("reports removed leaves as undefined", () => {
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toEqual([[`${PREFIX}b`, undefined]]);
  });
  it("returns nothing for equal objects", () => {
    const obj = { a: { "b.c": [1, { d: null }] } };
    expect(diff(obj, structuredClone(obj))).toEqual([]);
  });
  it("uses escaped keys", () => {
    expect(diff({}, { "a.b": 1 })).toEqual([[`${PREFIX}\${a.b}`, 1]]);
  });
  it("compares Uint8Array leaves byte-wise as scalars", () => {
    const a = { count: new Uint8Array([1, 2]), e: new Uint8Array(0) };
    const same = { count: new Uint8Array([1, 2]), e: new Uint8Array(0) };
    expect(diff(a, same)).toEqual([]);
    expect(
      diff(a, { count: new Uint8Array([1, 3]), e: new Uint8Array(0) }),
    ).toEqual([[`${PREFIX}count`, new Uint8Array([1, 3])]]);
    // An empty Uint8Array is not an empty object
    expect(diff<unknown>(a, { count: new Uint8Array([1, 2]), e: {} })).toEqual([
      [`${PREFIX}e`, {}],
    ]);
    expect(diff<unknown>({ v: "1,2" }, { v: new Uint8Array([1, 2]) })).toEqual([
      [`${PREFIX}v`, new Uint8Array([1, 2])],
    ]);
  });
});

describe("fromBoxes", () => {
  it("requires an AlgorandClient", async () => {
    await expect(
      fromBoxes({} as unknown as AlgorandClient, 1n),
    ).rejects.toThrow(ALGORAND_CLIENT_REQUIRED);
  });
  it("requires a bigint application id", async () => {
    const algorand = AlgorandClient.defaultLocalNet();
    await expect(fromBoxes(algorand, 1 as unknown as bigint)).rejects.toThrow(
      APPLICATION_ID_REQUIRED,
    );
  });
});

describe("deepMerge", () => {
  it("merges nested objects without mutating inputs", () => {
    const target = { a: { b: 1, c: 2 }, d: [1] };
    const source = { a: { c: 3 }, d: [2] };
    const result = deepMerge<unknown>(target, source);
    expect(result).toEqual({ a: { b: 1, c: 3 }, d: [2] });
    expect(target).toEqual({ a: { b: 1, c: 2 }, d: [1] });
  });
  it("replaces Uint8Array leaves instead of merging them", () => {
    const target = { bin: new Uint8Array([1, 2, 3]), o: { k: 1 } };
    const source = { bin: new Uint8Array([9]), o: { j: 2 } };
    const result = deepMerge<unknown>(target, source) as typeof target;
    expect(result.bin).toBe(source.bin);
    expect(result.bin).toEqual(new Uint8Array([9]));
    expect(result.o).toEqual({ k: 1, j: 2 });
    // A Uint8Array source replaces an object target and vice versa
    expect(
      deepMerge<unknown>({ x: { a: 1 } }, { x: new Uint8Array([1]) }),
    ).toEqual({ x: new Uint8Array([1]) });
    expect(
      deepMerge<unknown>({ x: new Uint8Array([1]) }, { x: { a: 1 } }),
    ).toEqual({ x: { a: 1 } });
  });
});
