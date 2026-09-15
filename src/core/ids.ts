import { randomBytes } from "node:crypto";

/**
 * UUID version 7: 48-bit Unix millisecond timestamp, then random bits.
 * Globally unique with no coordination, and sorts by creation time as plain text.
 * Within one process, ids minted in the same millisecond are kept in order by a small counter.
 */
let lastMs = 0;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
  } else {
    lastMs = now;
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff; // start low so a burst never overflows the 12 bits
  }
  const b = Buffer.alloc(16);
  b.writeUIntBE(now, 0, 6);
  const rnd = randomBytes(10);
  rnd.copy(b, 6);
  b[6] = 0x70 | (seq >> 8); // version 7 in the top nibble, then the high 4 bits of the sequence
  b[7] = seq & 0xff;
  b[8] = ((b[8] as number) & 0x3f) | 0x80; // RFC 9562 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Millisecond timestamp encoded in a v7 id. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}
