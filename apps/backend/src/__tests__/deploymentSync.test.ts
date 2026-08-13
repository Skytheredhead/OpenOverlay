import { execFile } from "node:child_process";
import http, { type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const syncScript = path.join(repoRoot, "scripts", "check-deployment-sync.mjs");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("deployment sync check", () => {
  it("requires the frontend, gateway process, and active backend to report the same commit", async () => {
    const frontendUrl = await jsonServer(() => ({ build: frontendBuild("release-sha") }));
    const backendUrl = await jsonServer((url) => {
      if (url.pathname === "/health") return { ok: true, build: build("release-sha"), compatibility: compatibility() };
      if (url.pathname === "/_openoverlay/gateway") {
        return { ok: true, gatewayBuild: build("release-sha"), activeBuild: build("release-sha"), compatibility: compatibility() };
      }
      return undefined;
    });

    const result = await runSync(frontendUrl, backendUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Frontend, gateway, and backend are in sync at release");
  });

  it("fails closed when the gateway identity endpoint is absent", async () => {
    const frontendUrl = await jsonServer(() => ({ build: frontendBuild("release-sha") }));
    const backendUrl = await jsonServer((url) =>
      url.pathname === "/health" ? { ok: true, build: build("release-sha"), compatibility: compatibility() } : undefined
    );

    const result = await runSync(frontendUrl, backendUrl);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("/_openoverlay/gateway");
    expect(result.stderr).toContain("404");
  });

  it("rejects a stale gateway even when the frontend and child backend match", async () => {
    const frontendUrl = await jsonServer(() => ({ build: frontendBuild("release-sha") }));
    const backendUrl = await jsonServer((url) => {
      if (url.pathname === "/health") return { ok: true, build: build("release-sha"), compatibility: compatibility() };
      if (url.pathname === "/_openoverlay/gateway") {
        return { ok: true, gatewayBuild: build("stale-sha"), activeBuild: build("release-sha"), compatibility: compatibility() };
      }
      return undefined;
    });

    const result = await runSync(frontendUrl, backendUrl);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Frontend, gateway, and backend deployments are out of sync");
    expect(result.stderr).toContain("stale-s");
  });
});

async function jsonServer(payload: (url: URL) => unknown | undefined): Promise<string> {
  const server = http.createServer((request, response) => {
    const value = payload(new URL(request.url || "/", "http://localhost"));
    if (value === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function runSync(frontendUrl: string, backendUrl: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [syncScript],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FRONTEND_URL: frontendUrl,
          BACKEND_URL: backendUrl,
          DEPLOYMENT_CHECK_TIMEOUT_MS: "1000"
        }
      },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

function build(commit: string) {
  return { commit, version: "0.1.0" };
}

function frontendBuild(commit: string) {
  return { ...build(commit), requiredApiVersion: "v1", requiredRealtimeVersion: "v1" };
}

function compatibility() {
  return {
    api: { current: "v1", supported: ["v1"] },
    realtime: { current: "v1", supported: ["v1"] }
  };
}
