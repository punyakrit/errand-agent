import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function allTestText(dir: string): string {
  return readdirSync(dir).map((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? allTestText(path) : readFileSync(path, "utf8");
  }).join("\n");
}

const doc = readFileSync("docs/REQUIREMENTS.md", "utf8");
const rows = doc.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Requirement") && !line.startsWith("| Deliverable"));

describe("docs/REQUIREMENTS.md", () => {
  it("names only code files that exist", () => {
    const paths = [...doc.matchAll(/`((?:src|tests)\/[^`]+)`/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths) expect(existsSync(path), path).toBe(true);
  });

  it("names only tests that exist", () => {
    const tests = allTestText("tests");
    const names = rows.flatMap((row) => [...row.matchAll(/"([^"]+)"/g)].map((match) => match[1]!));
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) expect(tests.includes(name), name).toBe(true);
  });

  it("gives every requirement a test", () => {
    const requirements = rows.filter((row) => row.includes("`src/") || row.includes("`docs/DESIGN.md`"));
    for (const row of requirements.filter((item) => item.split("|").length === 5)) {
      expect(row, row).toMatch(/"[^"]+"/);
    }
  });
});
