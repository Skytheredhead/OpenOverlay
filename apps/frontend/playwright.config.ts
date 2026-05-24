import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const dbPath = path.join(process.cwd(), "../../data/e2e/openoverlay-e2e.sqlite");

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: {
    timeout: 8_000
  },
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 920 } }
    }
  ],
  webServer: [
    {
      command: `cd ../.. && mkdir -p data/e2e data/e2e/uploads data/e2e/logs && rm -f ${dbPath} ${dbPath}-wal ${dbPath}-shm && NODE_ENV=test DATABASE_PATH=${dbPath} UPLOAD_DIR=data/e2e/uploads LOG_FILE=data/e2e/logs/backend.log JWT_SECRET=e2e-secret CORS_ORIGINS=http://127.0.0.1:5173,http://localhost:5173 npm run dev --workspace @openoverlay/backend`,
      url: "http://127.0.0.1:8734/health",
      reuseExistingServer: false,
      timeout: 20_000
    },
    {
      command: "cd ../.. && VITE_API_BASE_URL=http://127.0.0.1:8734 VITE_WS_URL=ws://127.0.0.1:8734 npm run dev --workspace @openoverlay/frontend",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 20_000
    }
  ]
});
