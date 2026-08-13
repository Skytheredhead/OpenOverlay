#!/usr/bin/env node

const frontendUrl = normalizeUrl(process.env.FRONTEND_URL || "https://openoverlay.skylarenns.com");
const backendUrl = normalizeUrl(process.env.BACKEND_URL || process.env.VITE_API_BASE_URL || "https://openoverlayapi.skylarenns.com");
const requestTimeoutMs = positiveNumber(process.env.DEPLOYMENT_CHECK_TIMEOUT_MS, 10_000);

try {
  const [frontend, backend, gateway] = await Promise.all([
    fetchJson(`${frontendUrl}/build-info.json`),
    fetchJson(`${backendUrl}/health`),
    fetchJson(`${backendUrl}/_openoverlay/gateway`)
  ]);

  const frontendBuild = frontend.build || {};
  const backendBuild = backend.build || {};
  const gatewayBuild = gateway.gatewayBuild || {};
  const activeBuild = gateway.activeBuild || {};
  const frontendCommit = normalizeCommit(frontendBuild.commit);
  const backendCommit = normalizeCommit(backendBuild.commit);
  const gatewayCommit = normalizeCommit(gatewayBuild.commit);
  const activeCommit = normalizeCommit(activeBuild.commit);
  const requiredApiVersion = stringOrNull(frontendBuild.requiredApiVersion);
  const requiredRealtimeVersion = stringOrNull(frontendBuild.requiredRealtimeVersion);
  const backendApiVersions = Array.isArray(backend.compatibility?.api?.supported) ? backend.compatibility.api.supported : [];
  const backendRealtimeVersions = Array.isArray(backend.compatibility?.realtime?.supported) ? backend.compatibility.realtime.supported : [];

  if (backend.ok !== true) {
    console.error("Backend health did not report ok=true.");
    process.exit(1);
  }
  if (gateway.ok !== true) {
    console.error("Backend gateway status did not report ok=true.");
    process.exit(1);
  }

  if (
    (requiredApiVersion && !backendApiVersions.includes(requiredApiVersion)) ||
    (requiredRealtimeVersion && !backendRealtimeVersions.includes(requiredRealtimeVersion))
  ) {
    console.error("Frontend and backend API/realtime versions are incompatible.");
    console.error(`Frontend requires: api=${requiredApiVersion || "unknown"} realtime=${requiredRealtimeVersion || "unknown"}`);
    console.error(`Backend supports:  api=${backendApiVersions.join(",") || "unknown"} realtime=${backendRealtimeVersions.join(",") || "unknown"}`);
    process.exit(1);
  }

  if (!frontendCommit || !backendCommit || !gatewayCommit || !activeCommit) {
    console.error("Deployment sync check could not verify every build layer.");
    console.error(`Frontend: ${formatBuild(frontendBuild)}`);
    console.error(`Backend:  ${formatBuild(backendBuild)}`);
    console.error(`Gateway:  ${formatBuild(gatewayBuild)}`);
    console.error(`Active:   ${formatBuild(activeBuild)}`);
    process.exit(2);
  }

  if (frontendCommit !== backendCommit || backendCommit !== gatewayCommit || backendCommit !== activeCommit) {
    console.error("Frontend, gateway, and backend deployments are out of sync.");
    console.error(`Frontend: ${formatBuild(frontendBuild)}`);
    console.error(`Backend:  ${formatBuild(backendBuild)}`);
    console.error(`Gateway:  ${formatBuild(gatewayBuild)}`);
    console.error(`Active:   ${formatBuild(activeBuild)}`);
    process.exit(1);
  }

  console.log(`Frontend, gateway, and backend are in sync at ${frontendCommit.slice(0, 7)}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Deployment sync check failed.");
  process.exit(2);
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, "");
}

function normalizeCommit(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(`${url}${url.includes("?") ? "&" : "?"}check=${Date.now()}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
  } catch (error) {
    throw new Error(`Request failed for ${url}: ${error instanceof Error ? error.message : "network error"}`, { cause: error });
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function formatBuild(build) {
  const commit = normalizeCommit(build.commit);
  const version = typeof build.version === "string" && build.version.trim() ? build.version.trim() : "unknown version";
  return commit ? `${commit.slice(0, 7)} (${version})` : `unknown commit (${version})`;
}
