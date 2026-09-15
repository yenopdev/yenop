import { describe, it, expect } from "vitest";
import { uuidv7, uuidv7Time } from "./ids.js";

describe("uuidv7", () => {
  it("looks like a UUID with version 7 and the RFC variant", () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("sorts by time as plain text, even within one millisecond", () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("carries the creation time", () => {
    const t = Date.UTC(2026, 8, 16, 12, 0, 0);
    expect(uuidv7Time(uuidv7(t))).toBe(t);
  });
});
