import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("Cloudflare tunnel normalization", () => {
  it("adds the legacy hostname to the dedicated tunnel with the same origin", () => {
    const source = `tunnel: tunnel-id\ncredentials-file: /credentials.json\ningress:\n  - hostname: openoverlayapi.skylarenns.com\n    service: http://127.0.0.1:8734\n  - service: http_status:404\n`;
    const result = runNormalizer("ensure-cloudflare-dedicated-ingress.mjs", source);
    expect(result.status).toBe(0);
    const output = fs.readFileSync(result.outputPath, "utf8");
    expect(output.match(/service: http:\/\/127\.0\.0\.1:8734/g)).toHaveLength(2);
    expect(output).toContain("hostname: openoverlay-api.skylarenns.com");
  });

  it("removes only the two canonical OpenOverlay blocks from the unified tunnel", () => {
    const source = `tunnel: unified\ningress:\n  - hostname: unrelated.example.com\n    service: http://127.0.0.1:9000\n  - hostname: openoverlay-api.skylarenns.com\n    service: http://127.0.0.1:8734\n  - hostname: openoverlayapi.skylarenns.com\n    service: http://127.0.0.1:8734\n  - service: http_status:404\n`;
    const result = runNormalizer("normalize-cloudflare-ingress.mjs", source);
    expect(result.status).toBe(0);
    const output = fs.readFileSync(result.outputPath, "utf8");
    expect(output).toContain("unrelated.example.com");
    expect(output).toContain("http://127.0.0.1:9000");
    expect(output).not.toContain("openoverlayapi.skylarenns.com");
    expect(output).not.toContain("openoverlay-api.skylarenns.com");
    expect(output).toContain("http_status:404");
  });

  it("refuses to remove a hostname that points to an unexpected origin", () => {
    const source = `tunnel: unified\ningress:\n  - hostname: openoverlay-api.skylarenns.com\n    service: http://127.0.0.1:9999\n  - hostname: openoverlayapi.skylarenns.com\n    service: http://127.0.0.1:8734\n  - service: http_status:404\n`;
    const result = runNormalizer("normalize-cloudflare-ingress.mjs", source);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unexpected service/);
  });
});

function runNormalizer(scriptName: string, source: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-cloudflare-test-"));
  directories.push(directory);
  const inputPath = path.join(directory, "input.yml");
  const outputPath = path.join(directory, "output.yml");
  fs.writeFileSync(inputPath, source);
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", scriptName), inputPath, outputPath], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  return { ...result, outputPath };
}
