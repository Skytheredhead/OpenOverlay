#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const primary = "openoverlayapi.skylarenns.com";
const alias = "openoverlay-api.skylarenns.com";
const origin = "http://127.0.0.1:8734";

try {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("Usage: ensure-cloudflare-dedicated-ingress.mjs <input.yml> <output.yml>");
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error("Input and output paths must differ");
  let source = fs.readFileSync(inputPath, "utf8");
  assertCanonicalHost(source, primary);
  const aliasCount = hostnameCount(source, alias);
  if (aliasCount > 1) throw new Error(`Dedicated tunnel has duplicate ${alias} entries`);
  if (aliasCount === 1) assertCanonicalHost(source, alias);
  else {
    const catchAll = /^\s{2}-\s+service:\s*http_status:404\s*$/m;
    if (!catchAll.test(source)) throw new Error("Dedicated tunnel is missing its 404 catch-all");
    source = source.replace(catchAll, `  - hostname: ${alias}\n    service: ${origin}\n  - service: http_status:404`);
  }
  fs.writeFileSync(outputPath, source, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ ok: true, hostnames: [primary, alias], origin, output: path.resolve(outputPath) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to normalize dedicated tunnel ingress");
  process.exitCode = 1;
}

function assertCanonicalHost(source, hostname) {
  if (hostnameCount(source, hostname) !== 1) throw new Error(`Dedicated tunnel must contain exactly one ${hostname} entry`);
  const escaped = hostname.replaceAll(".", "\\.");
  const block = new RegExp(`^\\s{2}-\\s+hostname:\\s*${escaped}\\s*$\\n^\\s{4}service:\\s*([^\\s#]+)\\s*$`, "m").exec(source);
  if (block?.[1] !== origin) throw new Error(`${hostname} must target ${origin}`);
}

function hostnameCount(source, hostname) {
  const escaped = hostname.replaceAll(".", "\\.");
  return [...source.matchAll(new RegExp(`^\\s{2}-\\s+hostname:\\s*${escaped}\\s*$`, "gm"))].length;
}
