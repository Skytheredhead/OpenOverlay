#!/usr/bin/env node

const frontendUrl = normalizeUrl(process.env.FRONTEND_URL || "https://openoverlay.skylarenns.com");
const backendUrl = normalizeUrl(process.env.BACKEND_URL || process.env.VITE_API_BASE_URL || "https://api.openoverlay.skylarenns.com");

try {
  const [frontend, backend] = await Promise.all([
    fetchJson(`${frontendUrl}/build-info.json`),
    fetchJson(`${backendUrl}/health`)
  ]);

  const frontendBuild = frontend.build || {};
  const backendBuild = backend.build || {};
  const frontendCommit = normalizeCommit(frontendBuild.commit);
  const backendCommit = normalizeCommit(backendBuild.commit);
  const requiredApiVersion = stringOrNull(frontendBuild.requiredApiVersion);
  const requiredRealtimeVersion = stringOrNull(frontendBuild.requiredRealtimeVersion);
  const backendApiVersions = Array.isArray(backend.compatibility?.api?.supported) ? backend.compatibility.api.supported : [];
  const backendRealtimeVersions = Array.isArray(backend.compatibility?.realtime?.supported) ? backend.compatibility.realtime.supported : [];

  if ((requiredApiVersion && !backendApiVersions.includes(requiredApiVersion)) ||
      (requiredRealtimeVersion && !backendRealtimeVersions.includes(requiredRealtimeVersion))) {
    console.error("Frontend and backend API/realtime versions are incompatible.");
    console.error(`Frontend requires: api=${requiredApiVersion || "unknown"} realtime=${requiredRealtimeVersion || "unknown"}`);
    console.error(`Backend supports:  api=${backendApiVersions.join(",") || "unknown"} realtime=${backendRealtimeVersions.join(",") || "unknown"}`);
    process.exit(1);
  }

  if (!frontendCommit || !backendCommit) {
    console.error("Deployment sync check could not verify both builds.");
    console.error(`Frontend: ${formatBuild(frontendBuild)}`);
    console.error(`Backend:  ${formatBuild(backendBuild)}`);
    process.exit(2);
  }

  if (frontendCommit !== backendCommit) {
    console.error("Frontend and backend deployments are out of sync.");
    console.error(`Frontend: ${formatBuild(frontendBuild)}`);
    console.error(`Backend:  ${formatBuild(backendBuild)}`);
    process.exit(1);
  }

  console.log(`Frontend and backend are in sync at ${frontendCommit.slice(0, 7)}.`);
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

async function fetchJson(url) {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}check=${Date.now()}`, {
    headers: { accept: "application/json" }
  });

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
