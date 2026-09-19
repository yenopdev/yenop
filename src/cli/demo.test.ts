import { describe, it, expect } from "vitest";
import { runDemo } from "./demo.js";

describe("yenop demo", () => {
  it("runs end to end and shows the key verdicts in order", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      chunks.push(s);
      return true;
    };
    let code: number;
    try {
      code = await runDemo({ color: false });
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    const text = chunks.join("");
    expect(code).toBe(0);
    // the load-bearing beats of the story
    expect(text).toContain("Act 1.");
    expect(text).toContain("Act 5.");
    expect(text).toMatch(/upload the .env file[\s\S]*BLOCKED/);
    expect(text).toMatch(/no-secret-files/);
    expect(text).toMatch(/send a request to an outside server[\s\S]*ASK/);
    expect(text).toMatch(/lethal-trifecta/);
    expect(text).toMatch(/dumps the customers table[\s\S]*ASK/);
    expect(text).toMatch(/Yenop's own policy file[\s\S]*ASK/);
    expect(text).toContain("The record");
    // no ANSI escapes when color is off
    expect(text).not.toContain("\x1b[");
  });
});
