import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const database = join(mkdtempSync(join(tmpdir(), "magellan-e2e-")), "research.db");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: ".venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8100",
      cwd: join(__dirname, "../backend"),
      url: "http://127.0.0.1:8100/healthz",
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: `sqlite:///${database}`,
        ENVIRONMENT: "test",
        RESEARCH_PROVIDER: "fixture",
        WORKSPACE_TOKENS: '{"e2e-token":"browser-tests"}',
        EMBEDDED_WORKER: "true",
        AUTO_CREATE_SCHEMA: "true",
      },
    },
    {
      command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100",
      timeout: 90_000,
      reuseExistingServer: false,
      env: {
        MAGELLAN_E2E: "1",
        MAGELLAN_API_URL: "http://127.0.0.1:8100",
        MAGELLAN_API_TOKEN: "e2e-token",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
