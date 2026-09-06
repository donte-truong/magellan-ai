import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // The initial workspace fetch runs after hydration. Wait before interacting or
  // taking screenshots (which temporarily modify caret styles).
  const ready = page.waitForResponse((response) =>
    response.url().includes("/api/backend/runs?limit="),
  );
  await page.goto("/");
  await ready;
});

test("product → sourced bill of materials → network overlay, export, and resume", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("button", { name: "Deconstruct product" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("product-input.png"), fullPage: true });
  await page.getByRole("button", { name: "Raspberry Pi 5", exact: true }).click();
  await page.getByRole("button", { name: "Deconstruct product" }).click();
  await expect(page.getByRole("heading", { name: "Raspberry Pi 5", exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.locator("tbody").getByText("Unknown", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Curated example", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("bill-of-materials.png"), fullPage: true });

  await page.getByRole("button", { name: /Inspect.*BCM2712/ }).click();
  await expect(page.getByRole("heading", { name: "Connection details" })).toBeVisible();
  await expect(page.locator(".source-card blockquote").first()).not.toBeEmpty();
  await expect(page.getByRole("link", { name: "Open original source" }).first()).toHaveAttribute(
    "href",
    /^https:\/\//,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Connection details" })).toHaveCount(0);

  await page.getByRole("button", { name: "Explore network", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The supply network" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await page.getByRole("button", { name: "Fit network to view" }).click();
  await page.screenshot({ path: testInfo.outputPath("network-overlay.png"), fullPage: true });
  await page.locator(".react-flow__node").filter({ hasText: "BCM2712" }).click();
  await expect(page.getByRole("heading", { name: "Connection details" })).toBeVisible();
  await expect(page.locator(".source-card blockquote").first()).not.toBeEmpty();
  await page.screenshot({ path: testInfo.outputPath("network-evidence.png"), fullPage: true });
  await page.getByRole("button", { name: "Close evidence panel" }).click();
  const componentNode = page.locator(".react-flow__node").filter({ hasText: "BCM2712" });
  await componentNode.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Connection details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Find a network node" }).fill("BCM2712");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Find a network node" }).clear();

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("Raspberry-Pi-5.json");
  const url = page.url();
  expect(url).toContain("?run=run_");
  await page.reload();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(errors).toEqual([]);
});

test("an unfamiliar product leaves an explicit evidence gap", async ({ page }) => {
  await page.getByRole("textbox", { name: /Product name/ }).fill("Unlisted test product 314159");
  await page.getByRole("button", { name: "Deconstruct product" }).click();
  await expect(page.getByText("No verified components yet", { exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.locator(".questions-card summary").click();
  await expect(page.locator(".questions-card li").first()).toBeVisible();
  await page.getByRole("button", { name: "Explore network", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.getByText("No verified connections yet.", { exact: false })).toBeVisible();
});

test("ambiguous product names can be clarified without restarting", async ({ page }) => {
  await page.getByRole("textbox", { name: /Product name/ }).fill("Raspberry Pi");
  await page.getByRole("button", { name: "Deconstruct product" }).click();
  await expect(
    page.getByText("A quick clarification before we continue", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".clarification-card")
    .getByRole("button", { name: "Raspberry Pi 5", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Raspberry Pi 5", exact: true })).toBeVisible();
});
