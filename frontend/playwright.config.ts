import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser tests run against the Next.js backend in curated replay mode. Provider keys are
// blanked so no paid research can start; only the Raspberry Pi 5 example is served.
// Requires a production build of the backend first: `cd ../backend && npm ci && npm run build`.
const runs = mkdtempSync(join(tmpdir(), "magellan-e2e-"));

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
      command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 8100",
      cwd: "../backend",
      url: "http://127.0.0.1:8100/",
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        RESEARCH_API_TOKEN: "e2e-token",
        RESEARCH_RUNS_DIR: runs,
        RESEARCH_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "",
        OPENROUTER_API_KEY: "",
        TAVILY_API_KEY: "",
      },
    },
    {
      command: "bun run dev --port 3100",
      url: "http://127.0.0.1:3100",
      timeout: 90_000,
      reuseExistingServer: false,
      env: {
        MAGELLAN_API_URL: "http://127.0.0.1:8100",
        MAGELLAN_API_TOKEN: "e2e-token",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
