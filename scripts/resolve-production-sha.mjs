#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";

try {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  let candidate;
  if (eventName === "workflow_run") {
    if (event.workflow_run?.conclusion !== "success" || event.workflow_run?.event !== "push" || event.workflow_run?.head_branch !== "main") {
      throw new Error("Production deployment requires a successful main-push CI run");
    }
    candidate = event.workflow_run.head_sha;
  } else {
    candidate = execGit(["rev-parse", "origin/main"]);
  }
  validateSha(candidate);
  execGit(["merge-base", "--is-ancestor", candidate, "origin/main"]);

  const successful = await successfulCiShas();
  if (!successful.has(candidate)) throw new Error(`No successful CI run exists for exact SHA ${candidate}`);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is unavailable");
  fs.appendFileSync(output, `sha=${candidate}\n`);
  console.log(`Resolved deployable exact SHA ${candidate}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to resolve deployable SHA");
  process.exitCode = 1;
}

async function successfulCiShas() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "openoverlay-production-deployer"
    }
  });
  if (!response.ok) throw new Error(`GitHub Actions API returned HTTP ${response.status}`);
  const body = await response.json();
  return new Set((body.workflow_runs || []).map((run) => run.head_sha).filter((sha) => typeof sha === "string"));
}

function execGit(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function validateSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error("Candidate is not a full Git SHA");
}
