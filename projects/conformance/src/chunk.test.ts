import { describe, expect, it } from "vitest";
import { chunkKeyValue, chunkValue, toChunks } from "./chunk.js";
import { GROUP_SIZE, MAX_ABI_SIZE } from "./constants.js";

describe("toChunks", () => {
  it("groups paths by GROUP_SIZE", () => {
    const obj = Object.fromEntries(
      Array.from({ length: GROUP_SIZE * 2 + 1 }, (_, i) => [`k${i}`, i]),
    );
    const chunks = toChunks(obj);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(GROUP_SIZE);
    expect(chunks[2]).toEqual([`k${GROUP_SIZE * 2}`]);
  });
  it("returns no chunks for an empty object", () => {
    expect(toChunks({})).toEqual([]);
  });
  it("rejects invalid sizes", () => {
    expect(() => toChunks({ a: 1 }, 0)).toThrow(TypeError);
  });
});

describe("chunkValue / chunkKeyValue", () => {
  it("splits a string into fixed-size chunks", () => {
    expect(chunkValue("abcdefg", 3)).toEqual(["abc", "def", "g"]);
    expect(chunkValue("", 3)).toEqual([]);
  });
  it("reserves the key length from the ABI budget", () => {
    const key = "o_blob";
    const value = "x".repeat(Number(MAX_ABI_SIZE) * 2);
    const chunks = chunkKeyValue(key, value);
    expect(chunks[0].length).toBe(Number(MAX_ABI_SIZE) - key.length);
    expect(chunks.join("")).toBe(value);
  });
  it("validates argument types", () => {
    expect(() => chunkValue(1 as unknown as string, 2)).toThrow(TypeError);
    expect(() => chunkValue("abc", 0)).toThrow(TypeError);
    expect(() => chunkValue("abc", 1.5)).toThrow(TypeError);
    expect(() => chunkKeyValue("k", 1 as unknown as string)).toThrow(TypeError);
    expect(() => chunkKeyValue(1 as unknown as string, "v")).toThrow(TypeError);
  });
  it("measures chunks in bytes and never splits a code point", () => {
    const encoder = new TextEncoder();
    // "é" is 2 bytes: 3 bytes of budget hold one "é" (a second would make 4).
    expect(chunkValue("ééé", 3)).toEqual(["é", "é", "é"]);
    expect(chunkValue("ééé", 4)).toEqual(["éé", "é"]);
    // Mixed widths: "a" (1) + "é" (2) = 3 fits, "😀" (4) must start a new chunk.
    const mixed = "aé😀bé";
    const chunks = chunkValue(mixed, 4);
    expect(chunks).toEqual(["aé", "😀", "bé"]);
    expect(chunks.join("")).toBe(mixed);
    for (const chunk of chunks) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(4);
    }
    // A code point wider than the budget forms its own chunk rather than being torn.
    expect(chunkValue("😀😀", 2)).toEqual(["😀", "😀"]);
    // Every chunk is valid UTF-8 and the concatenated encodings equal the whole.
    const long = "héllo wörld 😀".repeat(50);
    const parts = chunkValue(long, 7);
    expect(parts.join("")).toBe(long);
    const encoded = Buffer.concat(parts.map((p) => encoder.encode(p)));
    expect(new Uint8Array(encoded)).toEqual(encoder.encode(long));
  });
  it("splits Uint8Array values by exact bytes", () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
    const chunks = chunkValue(bytes, 4);
    expect(chunks.map((c) => Array.from(c))).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ]);
    expect(chunkValue(new Uint8Array(0), 4)).toEqual([]);
    const keyed = chunkKeyValue("o_k", new Uint8Array(Number(MAX_ABI_SIZE)));
    expect(keyed.length).toBe(2);
    expect(keyed[0].length).toBe(Number(MAX_ABI_SIZE) - 3);
  });
});
