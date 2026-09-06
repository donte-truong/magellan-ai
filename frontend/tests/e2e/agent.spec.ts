import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Product name").fill("Raspberry Pi 5");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.locator(".studio-run-status")).toContainText(
    /Research Complete|Partial Findings/,
  );
});

test("assistant uses selection, answers with inspectable references, and retries provider failures", async ({
  page,
}, testInfo) => {
  const chip = page.locator(".react-flow__node").filter({ hasText: "BCM2712" });
  await chip.click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Ask Magellan", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Magellan Assistant" });
  await expect(panel).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("agent-welcome.png"), fullPage: true });
  await page.getByRole("button", { name: "Close assistant" }).click();
  await chip.click();
  await page.getByRole("button", { name: "Ask Magellan About This" }).click();
  await expect(panel.locator(".agent-selection")).toContainText("BCM2712");
  const question = page.waitForRequest((request) => request.url().endsWith("/chat"));
  await page
    .getByRole("textbox", { name: "Message Magellan" })
    .fill("Walk me through this supply chain");
  await page.getByRole("button", { name: "Send message" }).click();
  const request = await question;
  expect(request.postDataJSON().revision).toBeGreaterThan(0);
  expect(request.postDataJSON().selection.node_ids).toHaveLength(1);
  await expect(panel.getByText(/Curated preview — live AI/)).toBeVisible();
  await expect(panel.locator(".agent-references button").first()).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("agent-answer.png"), fullPage: true });
  await panel.locator(".agent-references button").first().click();
  await expect(page.locator(".evidence-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Ask Magellan", exact: true }).click();
  await page.route(
    "**/api/backend/graphs/*/chat",
    (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: {
            message: "The AI provider could not answer right now.",
            code: "agent_unavailable",
          },
        },
      }),
    { times: 1 },
  );
  await page.getByRole("textbox", { name: "Message Magellan" }).fill("What evidence is missing?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByRole("alert")).toContainText("could not answer");
  await panel.getByRole("button", { name: "Try Again" }).click();
  await expect(panel.locator(".is-assistant")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});

test("agent edits a scenario, restores it on reload, resets it, and researches the original", async ({
  page,
}, testInfo) => {
  const originalUrl = page.url();
  await page.getByRole("button", { name: "Ask Magellan", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Magellan Assistant" });
  await panel.getByRole("button", { name: "Edit Scenario", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message Magellan" })
    .fill("replace Broadcom BCM2712 with Alternative processor");
  await page.getByRole("button", { name: "Apply scenario edit" }).click();
  await expect(panel.getByText(/Applied 1 change to your scenario/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("agent-edit.png"), fullPage: true });
  await page.getByRole("button", { name: "Close assistant" }).click();
  await expect(
    page.locator(".react-flow__node").filter({ hasText: "Alternative processor" }),
  ).toBeVisible();
  await expect(page.locator(".studio-scenario")).toContainText("Original Preserved");
  await expect(page).toHaveURL(/scenario=gph_/);
  await page.reload();
  await expect(
    page.locator(".react-flow__node").filter({ hasText: "Alternative processor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset Scenario" }).click();
  await expect(page.locator(".react-flow__node").filter({ hasText: "BCM2712" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Graph version" })
    .selectOption({ label: "Original Graph" });
  await expect(page).toHaveURL(originalUrl);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.getByRole("button", { name: "Ask Magellan", exact: true }).click();
  await panel.getByRole("button", { name: "Research", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message Magellan" })
    .fill("Research the processor supply chain further");
  await page.getByRole("button", { name: "Start follow-up research" }).click();
  await expect(panel.getByText(/Research started/)).toBeVisible();
  await expect(panel.locator(".agent-action-result")).toContainText(
    /Research Complete|Research partial/,
  );
  await page.getByRole("button", { name: "Close assistant" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page).not.toHaveURL(originalUrl);
});

test("direct demo route and network deep link survive a hard reload", async ({ page }) => {
  const response = await page.goto("/demo");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Every product.*A world within/ })).toBeVisible();
  const reload = await page.reload();
  expect(reload?.status()).toBe(200);
  // Wait for an interactive page before starting a same-document navigation;
  // Next's initial history setup has not necessarily run at the load event.
  await page.getByRole("button", { name: "Pause animations" }).click();
  await expect(page.getByRole("button", { name: "Resume animations" })).toBeVisible();
  await page.goto("/demo#network");
  await expect(page.locator(".supplier-row")).toHaveCount(6);
  await page.reload();
  await expect(page.locator(".supplier-row")).toHaveCount(6);
});
