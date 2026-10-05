import { describe, expect, it } from "vitest";
import {
  MAX_ABI_SIZE,
  MAX_ARG_SIZE,
  MAX_AVM_BYTES,
  MAX_BOX_SIZE,
  MAX_KEY_SIZE,
  MAX_STRUCT_SIZE,
  MIN_BALANCE,
  PER_BOX,
  PER_UNIT,
  PREFIX,
} from "./constants.js";
import { MaxSizeError } from "./errors.js";
import { byteLength } from "./paths.js";
import { assertFits, boxesToMBR, surchargeFor, toMBR } from "./payments.js";
import { toBoxes } from "./state.js";
import { loadVectors, type MbrVectors } from "./vectors.test-util.js";

const vectors = loadVectors<MbrVectors>("mbr");

describe("vectors/mbr.json", () => {
  it("matches the constants", () => {
    expect(vectors.constants).toEqual({
      MIN_BALANCE: Number(MIN_BALANCE),
      PER_BOX: Number(PER_BOX),
      PER_UNIT: Number(PER_UNIT),
      MAX_KEY_SIZE: Number(MAX_KEY_SIZE),
      MAX_BOX_SIZE: Number(MAX_BOX_SIZE),
      PREFIX,
    });
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(toMBR(c.object)).toBe(BigInt(c.mbr));
      expect(boxesToMBR(c.boxes)).toBe(BigInt(c.mbr));
    });
  }

  for (const c of vectors.errors) {
    it(c.name, () => {
      expect(byteLength(`${PREFIX}${c.key}`)).toBe(c.keyBytes);
      const obj = { [c.key]: "a".repeat(c.valueLength) };
      if (c.error === null) {
        expect(() => toMBR(obj)).not.toThrow();
      } else {
        expect(() => toMBR(obj)).toThrow(MaxSizeError);
        expect(() => toMBR(obj)).toThrow(
          expect.objectContaining({ name: c.error }),
        );
      }
    });
  }
});

describe("toMBR", () => {
  it("requires an object", () => {
    expect(() => toMBR(undefined)).toThrow(TypeError);
  });
  it("rejects a key longer than the maximum (no templating)", () => {
    expect(() => toMBR({ ["k".repeat(200)]: "v" })).toThrow(MaxSizeError);
    expect(() => toMBR({ nested: { ["k".repeat(63)]: "v" } })).toThrow(
      MaxSizeError,
    );
  });
  it("rejects raw boxes with keys over the maximum", () => {
    expect(() => boxesToMBR([["k".repeat(65), "v"]])).toThrow(MaxSizeError);
  });
  it("sizes Uint8Array leaves in bytes", () => {
    const bytes = new Uint8Array(8);
    const text = "é".repeat(4); // 8 bytes, 4 characters
    expect(toMBR({ count: bytes })).toBe(toMBR({ count: text }));
    expect(boxesToMBR([[`${PREFIX}count`, bytes]])).toBe(
      MIN_BALANCE + PER_BOX + PER_UNIT * BigInt(PREFIX.length + 5 + 8),
    );
    expect(() =>
      boxesToMBR([["k", new Uint8Array(Number(MAX_BOX_SIZE) + 1)]]),
    ).toThrow(MaxSizeError);
  });
});

describe("assertFits", () => {
  it("recommends 4094 bytes for a stack-decodable struct leaf", () => {
    expect(MAX_STRUCT_SIZE).toBe(4094n);
    expect(MAX_STRUCT_SIZE).toBe(MAX_AVM_BYTES - 2n);
  });
  it("passes at the boundary and throws one byte over", () => {
    const at = new Uint8Array(Number(MAX_STRUCT_SIZE));
    const over = new Uint8Array(Number(MAX_STRUCT_SIZE) + 1);
    expect(() => assertFits([["o_a", at]], MAX_STRUCT_SIZE)).not.toThrow();
    expect(() => assertFits([["o_a", over]], MAX_STRUCT_SIZE)).toThrow(
      MaxSizeError,
    );
    expect(() => assertFits([["o_a", over]], MAX_STRUCT_SIZE)).toThrow(
      /maxValue of 4094 bytes for key o_a: 4095/,
    );
    // Text leaves are measured in UTF-8 bytes, not characters.
    expect(() => assertFits([["o_t", "\u00e9".repeat(50)]], 100)).not.toThrow();
    expect(() => assertFits([["o_t", "\u00e9".repeat(51)]], 100)).toThrow(
      MaxSizeError,
    );
    expect(() =>
      assertFits(toBoxes({ a: "x", b: { c: "yz" } }), 2),
    ).not.toThrow();
    expect(() => assertFits(toBoxes({ a: "x", b: { c: "yz" } }), 1)).toThrow(
      /key o_b\.c/,
    );
  });
  it("accepts the whole 32 KiB ceiling and an empty box list", () => {
    expect(() => assertFits([], 1)).not.toThrow();
    expect(() =>
      assertFits([["o_a", new Uint8Array(Number(MAX_BOX_SIZE))]], MAX_BOX_SIZE),
    ).not.toThrow();
  });
  it("rejects a cap outside [1, MAX_BOX_SIZE]", () => {
    for (const bad of [0, -1, MAX_BOX_SIZE + 1n, 2n ** 64n]) {
      expect(() => assertFits([], bad)).toThrow(RangeError);
    }
  });
});

describe("surchargeFor", () => {
  it("is free up to MAX_ABI_SIZE", () => {
    expect(surchargeFor(0)).toBe(0n);
    expect(surchargeFor(MAX_ABI_SIZE)).toBe(0n);
    expect(surchargeFor(2048n)).toBe(0n);
  });
  it("charges 0.1 µALGO per byte over, rounded up", () => {
    expect(surchargeFor(2049)).toBe(1n);
    expect(surchargeFor(2058)).toBe(1n);
    expect(surchargeFor(2059)).toBe(2n);
    expect(surchargeFor(2111)).toBe(7n);
    expect(surchargeFor(MAX_ARG_SIZE)).toBe(1434n);
    expect(surchargeFor(16384)).toBe(1434n);
  });
  it("scales with the minimum fee", () => {
    expect(surchargeFor(2111, 2_000n)).toBe(13n);
    expect(surchargeFor(16384, 1_000n)).toBe(surchargeFor(16384));
  });
  it("rejects arguments over MAX_ARG_SIZE", () => {
    expect(() => surchargeFor(MAX_ARG_SIZE + 1n)).toThrow(MaxSizeError);
    expect(() => surchargeFor(16385)).toThrow(MaxSizeError);
  });
});
