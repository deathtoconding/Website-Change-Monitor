import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/start-e2e-stack.mjs",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ORIGIN: baseURL,
      APP_BASE_URL: baseURL,
      TEST_FIXTURE_ORIGIN:
        process.env.TEST_FIXTURE_ORIGIN ?? "http://fixture.test:18088",
      TEST_FIXTURE_ADDRESS: process.env.TEST_FIXTURE_ADDRESS ?? "127.0.0.1",
      ALLOW_DEV_VERIFICATION_TOKEN: "true",
      SCHEDULER_INTERVAL_MS: "1000",
      FETCH_TIMEOUT_MS: "1000",
      FETCH_MAX_REDIRECTS: "0",
      FETCH_DOMAIN_COOLDOWN_MS: "250",
    },
  },
});
