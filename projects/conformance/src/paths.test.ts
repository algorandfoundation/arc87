import { describe, expect, it } from "vitest";
import { PREFIX, RESERVED_CHARACTERS } from "./constants.js";
import {
  escapeSegment,
  isReserved,
  normalizePath,
  stripPrefix,
  toPaths,
  toSegments,
  unescapeSegment,
} from "./paths.js";
import {
  type EscapeVectors,
  loadVectors,
  type NormalizeVectors,
  type PathsVectors,
} from "./vectors.test-util.js";

const paths = loadVectors<PathsVectors>("paths");
const normalize = loadVectors<NormalizeVectors>("normalize");
const escapes = loadVectors<EscapeVectors>("escape");

describe("vectors/paths.json", () => {
  it("uses the standard prefix", () => {
    expect(paths.prefix).toBe(PREFIX);
  });
  for (const c of paths.cases) {
    it(c.name, () => {
      const result = toPaths(c.object);
      expect(result).toEqual(c.paths);
      expect(result.map((p) => `${PREFIX}${p}`)).toEqual(c.keys);
      expect(c.keys.map(stripPrefix)).toEqual(c.paths);
    });
  }
});

describe("vectors/normalize.json", () => {
  for (const c of normalize.cases) {
    it(c.name, () => {
      expect(c.inputs.map(normalizePath)).toEqual(c.normalized);
      // idempotent
      expect(c.normalized.map(normalizePath)).toEqual(c.normalized);
      // an input and its normalized form split into the same segments
      c.inputs.forEach((input, idx) => {
        expect(toSegments(stripPrefix(input))).toEqual(
          toSegments(stripPrefix(c.normalized[idx])),
        );
      });
    });
  }
});

describe("vectors/escape.json", () => {
  it("lists the reserved characters", () => {
    expect(escapes.reserved).toEqual([...RESERVED_CHARACTERS]);
  });
  for (const c of escapes.cases) {
    it(c.name, () => {
      expect(isReserved(c.segment)).toBe(c.isEscaped);
      expect(escapeSegment(c.segment)).toBe(c.escaped);
      expect(unescapeSegment(c.escaped)).toBe(c.segment);
      // an escaped segment is a single segment when parsed as a path
      expect(toSegments(c.escaped)).toEqual([c.segment]);
    });
  }
});

describe("toSegments", () => {
  it("splits dotted, indexed and escaped segments", () => {
    expect(toSegments("a[1].b")).toEqual(["a", "1", "b"]);
    expect(toSegments("a.1.b")).toEqual(["a", "1", "b"]);
    expect(toSegments("${a.b}.c[0]")).toEqual(["a.b", "c", "0"]);
    expect(toSegments("x.${c[0]}")).toEqual(["x", "c[0]"]);
    expect(toSegments("${${x}}.y")).toEqual(["${x}", "y"]);
  });
});
