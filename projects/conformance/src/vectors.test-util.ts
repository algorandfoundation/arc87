import { readFileSync } from "node:fs";

/**
 * Loads a JSON vector file from `../vectors`.
 */
export function loadVectors<T>(name: string): T {
  const url = new URL(`../vectors/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

export type PathsVectors = {
  prefix: string;
  cases: { name: string; object: unknown; paths: string[]; keys: string[] }[];
};

export type NormalizeVectors = {
  cases: { name: string; inputs: string[]; normalized: string[] }[];
};

export type EscapeVectors = {
  reserved: string[];
  cases: {
    name: string;
    segment: string;
    escaped: string;
    isEscaped: boolean;
  }[];
};

export type MbrVectors = {
  constants: Record<string, number | string>;
  cases: {
    name: string;
    object: unknown;
    boxes: [string, string][];
    mbr: string;
  }[];
  errors: {
    name: string;
    key: string;
    keyBytes: number;
    valueLength: number;
    error: string | null;
  }[];
};
