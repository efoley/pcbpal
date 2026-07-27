import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ReplayTransport } from "./transport.js";

const RUN_TS = join(import.meta.dir, "run.ts");
const RECORDINGS = join(import.meta.dir, "recordings");

describe("ReplayTransport", () => {
  test("returns hits for a recorded (synthetic) query", async () => {
    const r = await new ReplayTransport(RECORDINGS).fetch("10uf-0402-x5r", "10uF 0402 X5R");
    expect("hits" in r).toBe(true);
    if ("hits" in r) {
      expect(r.synthetic).toBe(true);
      expect(r.hits[0].lcsc).toBe("C15525");
    }
  });

  test("skips-with-reason when no recording exists", async () => {
    const r = await new ReplayTransport(RECORDINGS).fetch("no-such-query", "nope");
    expect("skip" in r).toBe(true);
  });
});

describe("run.ts replay smoke", () => {
  test("scores recorded queries, skips the rest, exits 0", async () => {
    const proc = Bun.spawn(["bun", RUN_TS], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toContain("synthetic");
    expect(stdout).toContain("no recording");
    expect(stdout).toContain("No regressions vs baseline.");
  });
});
