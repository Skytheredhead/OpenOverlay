import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const parser = path.resolve(import.meta.dirname, "../../../../scripts/read-vercel-deployment-url.mjs");
const parse = (input: string) => spawnSync(process.execPath, [parser], { input, encoding: "utf8" });

describe("frontend deployment URL extraction", () => {
  it("accepts Vercel CLI JSON and legacy text output", () => {
    const url = "https://openoverlay-release.vercel.app";
    for (const input of [JSON.stringify({ status: "ok", deployment: { url } }), `Building…\n${url}\n`]) {
      expect(parse(input)).toMatchObject({ status: 0, stdout: url });
    }
  });
  it("rejects failed responses and untrusted deployment URLs", () => {
    for (const url of [
      undefined,
      "http://release.vercel.app",
      "https://vercel.app.attacker.test",
      "https://user:pass@release.vercel.app",
      "https://release.vercel.app/path"
    ]) {
      const result = parse(JSON.stringify({ deployment: { url } }));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    }
  });
});
