import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const RUN_TS = join(import.meta.dir, "run.ts");

async function runDry(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", RUN_TS, "--dry-run", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("run.ts --dry-run smoke", () => {
  test("single-pass over all goldens scores perfectly, exit 0", async () => {
    const { code, stdout } = await runDry(["--strategy", "single-pass"]);
    expect(code).toBe(0);
    // Every case should be a perfect echo of its golden.
    expect(stdout).toContain("100.0%");
    expect(stdout).not.toContain("FAIL");
    // Circuit facets should report a topology pass.
    expect(stdout).toContain("pass");
  });

  test("circuit facet with self-consistency-3 passes topology", async () => {
    const { code, stdout } = await runDry([
      "--parts",
      "mp2315",
      "--facets",
      "circuit",
      "--strategy",
      "self-consistency-3",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("100.0%");
    expect(stdout).toContain("pass");
    expect(stdout).not.toContain("FAIL");
  });

  test("verifier strategy runs clean in dry-run", async () => {
    const { code, stdout } = await runDry([
      "--parts",
      "ams1117-3.3",
      "--facets",
      "specs",
      "--strategy",
      "verifier",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("100.0%");
  });
});
