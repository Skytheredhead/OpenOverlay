#!/usr/bin/env node

import fs from "node:fs";

const files = ["vercel.json", "apps/frontend/vercel.json"];
const expectedRewrites = [
  "/login",
  "/signup",
  "/dash",
  "/dash/(.*)",
  "/overlay/(.*)",
  "/overlay-test/(.*)"
];
const requiredSecurityHeaders = [
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options"
];

let sharedRouting;
for (const file of files) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];
  const rewriteSources = rewrites.map((rewrite) => rewrite?.source);
  if (JSON.stringify(rewriteSources) !== JSON.stringify(expectedRewrites) || rewrites.some((rewrite) => rewrite?.destination !== "/index.html")) {
    throw new Error(`${file} must rewrite only the known client routes to /index.html; missing static assets must remain 404 responses`);
  }

  const headerRules = Array.isArray(config.headers) ? config.headers : [];
  const assetRule = headerRules.find((rule) => rule?.source === "/assets/(.*)");
  const assetCache = headerValue(assetRule, "cache-control");
  if (!assetCache || !/max-age=31536000/i.test(assetCache) || !/immutable/i.test(assetCache)) {
    throw new Error(`${file} must cache hashed /assets files immutably`);
  }

  const globalRule = headerRules.find((rule) => rule?.source === "/(.*)");
  for (const name of requiredSecurityHeaders) {
    if (!headerValue(globalRule, name)) throw new Error(`${file} is missing the ${name} response header`);
  }

  const routing = JSON.stringify({ framework: config.framework, headers: config.headers, rewrites: config.rewrites });
  if (sharedRouting === undefined) sharedRouting = routing;
  else if (routing !== sharedRouting) throw new Error("The root and frontend Vercel routing/security configurations have drifted apart");

  console.log(`${file}: routing, cache, and security headers validated`);
}

const backendUnitFile = "apps/backend/systemd/Openoverlaybackend.service";
const backendUnit = fs.readFileSync(backendUnitFile, "utf8");
for (const line of [
  "Environment=PATH=/usr/bin:/bin",
  "ExecStart=/usr/bin/node dist/gateway.js",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "UMask=0077"
]) {
  if (!backendUnit.split(/\r?\n/).includes(line)) throw new Error(`${backendUnitFile} is missing required setting: ${line}`);
}

const backendDeployFile = "scripts/deploy-backend.sh";
const backendDeploy = fs.readFileSync(backendDeployFile, "utf8");
for (const fragment of [
  'NODE_BIN="/usr/bin/node"',
  'NPM_CLI="/usr/bin/npm"',
  'sudo "${NODE_BIN}" scripts/validate-production-env.mjs',
  "Environment=PATH=/usr/bin:/bin",
  "ExecStart=${NODE_BIN} dist/gateway.js",
  "UMask=0077"
]) {
  if (!backendDeploy.includes(fragment)) throw new Error(`${backendDeployFile} is missing required deployment invariant: ${fragment}`);
}
if (/^\s*(?:sudo\s+)?node\s/m.test(backendDeploy) || /^\s*npm\s/m.test(backendDeploy)) {
  throw new Error(`${backendDeployFile} must use its validated absolute Node/npm commands`);
}

console.log(`${backendUnitFile}: Node path and systemd hardening validated`);
console.log(`${backendDeployFile}: Node and production environment validation wiring validated`);

function headerValue(rule, name) {
  if (!rule || !Array.isArray(rule.headers)) return undefined;
  return rule.headers.find((header) => typeof header?.key === "string" && header.key.toLowerCase() === name)?.value;
}
