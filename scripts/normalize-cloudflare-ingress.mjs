#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const targetHostnames = new Set(["openoverlayapi.skylarenns.com", "openoverlay-api.skylarenns.com"]);

try {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("Usage: normalize-cloudflare-ingress.mjs <input.yml> <output.yml>");
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error("Input and output paths must differ for atomic validation");
  const source = fs.readFileSync(inputPath, "utf8");
  const lines = source.split(/(?<=\n)/);
  const blocks = splitIngressBlocks(lines);
  const removed = [];
  const kept = [];
  for (const block of blocks) {
    const hostname = block.text.match(/^\s*-\s+hostname:\s*([^\s#]+)\s*$/m)?.[1];
    if (!hostname || !targetHostnames.has(hostname)) {
      kept.push(block.text);
      continue;
    }
    const service = block.text.match(/^\s+service:\s*([^\s#]+)\s*$/m)?.[1];
    if (service !== "http://127.0.0.1:8734") {
      throw new Error(`Refusing to remove ${hostname}: unexpected service ${service || "missing"}`);
    }
    removed.push(hostname);
  }
  if (removed.length !== targetHostnames.size || ![...targetHostnames].every((hostname) => removed.includes(hostname))) {
    throw new Error("Unified tunnel must contain exactly one canonical block for each OpenOverlay API hostname");
  }
  const output = kept.join("");
  if (!output.includes("ingress:") || !/^\s*-\s+service:\s*http_status:404\s*$/m.test(output)) {
    throw new Error("Normalized unified tunnel lost its ingress list or catch-all rule");
  }
  fs.writeFileSync(outputPath, output, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ ok: true, removed, output: path.resolve(outputPath) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to normalize Cloudflare ingress");
  process.exitCode = 1;
}

function splitIngressBlocks(lines) {
  const blocks = [];
  let current = "";
  for (const line of lines) {
    if (/^\s{2}-\s+/.test(line) && current) {
      blocks.push({ text: current });
      current = line;
    } else {
      current += line;
    }
  }
  if (current) blocks.push({ text: current });
  return blocks;
}
