import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const ready = page.waitForResponse((response) =>
    response.url().includes("/api/backend/runs?limit="),
  );
  await page.goto("/");
  await ready;
});

test("product → interactive graph → node details, evidence, BOM, export, and resume", async ({
  page,
  isMobile,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("button", { name: "Explore", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("01-explorer.png"), fullPage: true });
  await page.getByRole("button", { name: "Raspberry Pi 5", exact: true }).click();
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Raspberry Pi 5", exact: true })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(page.getByText("Curated Example", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fit network to view" }).click();
  await page.screenshot({ path: testInfo.outputPath("02-network.png"), fullPage: true });
  const chip = page.locator(".react-flow__node").filter({ hasText: "BCM2712" });
  await chip.click();
  await expect(page.getByRole("heading", { name: "Entity Details" })).toBeVisible();
  await expect(page.locator(".studio-entity-heading")).toContainText("BCM2712");
  await expect(page.locator(".studio-connections article")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("03-node-details.png"), fullPage: true });
  await page.locator(".studio-connection-evidence").click();
  await expect(page.getByRole("heading", { name: "Connection details" })).toBeVisible();
  await expect(page.locator(".source-card blockquote").first()).not.toBeEmpty();
  await expect(page.getByRole("link", { name: "Open original source" }).first()).toHaveAttribute(
    "href",
    /^https:\/\//,
  );
  await page.screenshot({ path: testInfo.outputPath("04-source-evidence.png"), fullPage: true });
  await page.locator(".relationship-card").getByRole("button", { name: "Raspberry Pi 5" }).click();
  await expect(page.locator(".studio-connections article")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(page.locator(".evidence-panel")).toHaveCount(0);
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Entity Details" })).toBeVisible();
  await page.keyboard.press("Escape");

  if (!isMobile) {
    await chip.click();
    await page.getByRole("button", { name: "Show selected node and neighbors only" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await page.getByRole("button", { name: "Show selected node and neighbors only" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    const box = await chip.boundingBox();
    const before = await chip.getAttribute("style");
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + 70, box!.y + 60, { steps: 8 });
    await page.mouse.up();
    await expect(chip).not.toHaveAttribute("style", before!);
  }
  await page.getByRole("textbox", { name: "Find a network node" }).fill("BCM2712");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Find a network node" }).fill("not-a-real-entity");
  await expect(page.getByText(/No entities match/)).toBeVisible();
  await page.getByRole("button", { name: "Clear node search" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  const transform = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator(".react-flow__viewport")).not.toHaveAttribute("style", transform!);
  await page.getByRole("button", { name: /Bill of Materials/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.locator("tbody").getByText("Unknown", { exact: true })).toHaveCount(3);
  await page.getByRole("button", { name: /Inspect.*BCM2712/ }).click();
  await expect(page.locator(".source-card blockquote").first()).not.toBeEmpty();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("05-bill-of-materials.png"), fullPage: true });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  expect((await downloaded).suggestedFilename()).toBe("Raspberry-Pi-5.json");
  const url = page.url();
  expect(url).toContain("?run=run_");
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(errors).toEqual([]);
});

test("an unfamiliar product keeps the evidence gap visible", async ({ page }) => {
  await page.getByRole("textbox", { name: "Product name" }).fill("Unlisted test product 314159");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.getByText("No verified connections yet.", { exact: false })).toBeVisible();
  await page.locator(".studio-questions summary").click();
  await expect(page.locator(".studio-questions li").first()).toBeVisible();
  await page.getByRole("button", { name: /Bill of Materials/ }).click();
  await expect(page.getByText("No verified components yet", { exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});

test("ambiguous product names can be clarified without restarting", async ({ page }) => {
  await page.getByRole("textbox", { name: "Product name" }).fill("Raspberry Pi");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(
    page.getByText("A quick clarification before we continue", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".studio-clarification")
    .getByRole("button", { name: "Raspberry Pi 5", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.getByRole("heading", { name: "Raspberry Pi 5", exact: true })).toBeVisible();
});

test("the research alias and legacy demo link open the right experiences", async ({ page }) => {
  await page.goto("/research");
  await expect(page.getByRole("textbox", { name: "Product name" })).toHaveValue("");
  await page.goto("/#network");
  await expect(page).toHaveURL(/\/demo#network$/);
  await expect(page.locator(".experience.stage-network")).toBeVisible();
});
