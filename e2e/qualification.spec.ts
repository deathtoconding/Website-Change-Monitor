import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, request, test } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const fixtureOrigin =
  process.env.TEST_FIXTURE_ORIGIN ?? "http://fixture.test:18088";
const fixtureControlUrl =
  process.env.FIXTURE_CONTROL_URL ?? "http://127.0.0.1:18088/__control";
const database = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
});
const createdEmails = new Set<string>();

test.afterAll(async () => {
  for (const email of createdEmails)
    await database.query("DELETE FROM users WHERE email = $1", [email]);
  await database.end();
});

test("registers, logs in, monitors a fixture, records a change, and manages access", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setFixture({
    content: "Qualification fixture baseline v1",
    failuresRemaining: 0,
    unsupportedContentType: false,
  });
  const runId = randomUUID().replaceAll("-", "");
  const email = `browser-qualification-${runId}@example.com`;
  const freshEmail = `browser-enumeration-${runId}@example.com`;
  const password = "GoodPassword!234";
  createdEmails.add(email);
  createdEmails.add(freshEmail);

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Start watching the web" }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "If the address can be registered",
  );

  await page.getByRole("button", { name: "Resend verification email" }).click();
  const verificationLink = page.getByRole("link", {
    name: "Open local verification link",
  });
  await expect(verificationLink).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/api\/auth\/verify-email\?/),
    verificationLink.click(),
  ]);
  await page
    .getByRole("button", { name: "Verify email address", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Email verified" }),
  ).toBeVisible();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Welcome back/ }),
  ).toBeVisible();
  await expect(
    page
      .locator(".stat-grid .stat-label")
      .filter({ hasText: /^Active monitors$/ }),
  ).toBeVisible();

  const enumeration = await page.evaluate(
    async ({ existingEmail, newEmail, passwordValue }) => {
      const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
      const { csrfToken } = (await csrfResponse.json()) as {
        csrfToken: string;
      };
      const register = async (targetEmail: string) => {
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({ email: targetEmail, password: passwordValue }),
        });
        return { status: response.status, body: await response.json() };
      };
      return {
        existing: await register(existingEmail),
        fresh: await register(newEmail),
      };
    },
    { existingEmail: email, newEmail: freshEmail, passwordValue: password },
  );
  expect(enumeration.existing).toEqual(enumeration.fresh);
  expect(enumeration.existing.status).toBe(202);

  await page
    .getByRole("button", { name: "Add monitor", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await page.getByLabel("Page URL").fill("file:///etc/passwd");
  await dialog
    .getByRole("button", { name: "Add monitor", exact: true })
    .click();
  await expect(
    dialog.getByText("Only HTTP and HTTPS URLs can be monitored."),
  ).toBeVisible();

  await page.getByLabel("Page URL").fill(`${fixtureOrigin}/`);
  await page.getByLabel("Monitor name").fill("Qualification fixture");
  const monitorResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/monitors") &&
      response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Add monitor", exact: true })
    .click();
  const monitorResponse = await monitorResponsePromise;
  expect(monitorResponse.status()).toBe(201);
  const { monitor } = (await monitorResponse.json()) as {
    monitor: { id: string };
  };

  const anonymous = await request.newContext({ baseURL });
  try {
    const unauthorized = await anonymous.get(`/api/monitors/${monitor.id}`);
    expect(unauthorized.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  await expect(
    page.getByRole("heading", { name: "Qualification fixture" }),
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const details = await getMonitorDetails(page, monitor.id);
        return details?.currentSnapshot?.content;
      },
      { timeout: 20_000 },
    )
    .toBe("Qualification fixture baseline v1");
  await page
    .getByRole("button", { name: "Qualification fixture", exact: true })
    .click();
  await expect(
    page.getByText("Qualification fixture baseline v1", { exact: true }),
  ).toBeVisible();

  await setFixture({ content: "Qualification fixture changed to v2" });
  await database.query(
    `UPDATE monitors
     SET last_checked_at = NULL, next_check_at = now() + interval '1 hour'
     WHERE id = $1`,
    [monitor.id],
  );

  const checkResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/monitors/${monitor.id}/check`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  const checkResponse = await checkResponsePromise;
  expect(checkResponse.status()).toBe(202);

  await expect
    .poll(
      async () => {
        const details = await getMonitorDetails(page, monitor.id);
        return details?.changes?.length;
      },
      { timeout: 20_000 },
    )
    .toBe(1);
  await expect(
    page.getByRole("heading", { name: /Change history/ }),
  ).toContainText("1");
  await expect(
    page.getByText("Qualification fixture changed to v2"),
  ).toBeVisible();

  await expect
    .poll(async () => {
      const result = await database.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM notification_outbox o
         JOIN changes c ON c.id = o.change_id
         WHERE c.monitor_id = $1`,
        [monitor.id],
      );
      return result.rows[0]?.count;
    })
    .toBe(1);

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Welcome back/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Recent updates/ }),
  ).toBeVisible();
  await expect(
    page
      .locator(".recent-changes-card")
      .getByText("Qualification fixture", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Qualification fixture", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Qualification fixture" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(
      async () => (await getMonitorDetails(page, monitor.id))?.monitor.status,
    )
    .toBe("paused");
  await expect(page.getByText("Paused", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect
    .poll(
      async () => (await getMonitorDetails(page, monitor.id))?.monitor.status,
    )
    .toBe("active");

  page.once("dialog", (dialogEvent) => void dialogEvent.accept());
  await page.getByRole("button", { name: "Delete this monitor" }).click();
  await expect
    .poll(async () => {
      const response = await page.evaluate(
        async (monitorId) =>
          fetch(`/api/monitors/${monitorId}`).then((result) => result.status),
        monitor.id,
      );
      return response;
    })
    .toBe(404);
  await expect(page.getByRole("heading", { name: /Monitors/ })).toBeVisible();
  await expect(page.getByText("No monitors found")).toBeVisible();
});

async function setFixture(settings: {
  content?: string;
  failuresRemaining?: number;
  unsupportedContentType?: boolean;
}): Promise<void> {
  const response = await fetch(fixtureControlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  expect(response.ok).toBe(true);
}

async function getMonitorDetails(
  page: import("@playwright/test").Page,
  monitorId: string,
) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/monitors/${id}`, { cache: "no-store" });
    if (!response.ok) return null;
    return response.json() as Promise<{
      monitor: { status: string };
      currentSnapshot: { content: string } | null;
      changes: unknown[];
    }>;
  }, monitorId);
}
