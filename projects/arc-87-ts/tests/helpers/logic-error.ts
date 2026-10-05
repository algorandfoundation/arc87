/**
 * Localnet assertion helper: resolves the `assert` message of a rejected app call
 * from the failing program counter and the ARC-56 source info of the compiled
 * contract, for both the store and the reader suites.
 */
import type { Arc56Contract } from "@algorandfoundation/algokit-utils/types/app-arc56";
import { expect } from "vitest";

/**
 * Byte offset of the first opcode after the leading `intcblock`/`bytecblock` of
 * an AVM program: the base of ARC-56 `pcOffsetMethod: "cblocks"` source info.
 */
function constantBlockOffset(program: Uint8Array): number {
  let pc = 1; // version byte
  const uvarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = program[pc++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };
  for (;;) {
    const opcode = program[pc];
    if (opcode === 0x20) {
      pc++;
      const count = uvarint();
      for (let i = 0; i < count; i++) uvarint();
    } else if (opcode === 0x26) {
      pc++;
      const count = uvarint();
      for (let i = 0; i < count; i++) {
        const length = uvarint();
        pc += length;
      }
    } else {
      return pc;
    }
  }
}

/**
 * Builds an assertion that `promise` is rejected by the AVM at the `assert`
 * carrying `message`, for the contract described by `spec`.
 *
 * The failing PC reported by algod is resolved against the ARC-56 source info
 * of the compiled contract (relative to the constant blocks) rather than relying
 * on the error text: algokit-utils 9.x computes the cblocks offset one byte short
 * for puya output and its update-call error transformer fails outright, so the
 * descriptive message does not reliably reach `error.message`.
 */
export function logicErrorMatcher(
  spec: Arc56Contract,
): (promise: Promise<unknown>, message: string) => Promise<void> {
  const sourceInfo = spec.sourceInfo?.approval?.sourceInfo ?? [];
  const cblockOffset = constantBlockOffset(
    Buffer.from(spec.byteCode?.approval ?? "", "base64"),
  );
  return async (promise, message) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error, `expected rejection: ${message}`).toBeInstanceOf(Error);
    const text = error?.message ?? "";
    if (text.includes(message)) return;
    const pc = /pc=(\d+)/.exec(text);
    expect(pc, `expected a logic error, got: ${text}`).not.toBeNull();
    const relative = Number(pc?.[1]) - cblockOffset;
    const resolved = sourceInfo.find((s) =>
      s.pc.includes(relative),
    )?.errorMessage;
    expect(resolved, text).toBe(message);
  };
}
