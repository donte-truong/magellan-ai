import { expect, test } from "@playwright/test";

test("iPhone demo reveals assemblies, explores supplier geography, and exports sources", async ({
  page,
}, testInfo) => {
  // Headless software rendering is slower than a browser with hardware WebGL.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Every product.*A world within/ })).toBeVisible();
  await page.locator(".product-canvas").waitFor();
  await expect(page.getByLabel("Product name")).toHaveValue("iPhone 17 Pro");
  await expect(
    page
      .getByRole("navigation", { name: "Exploration steps" })
      .getByRole("button", { name: "02 Deconstruct" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Pause animations" }).click();
  await page.screenshot({ path: testInfo.outputPath("01-product.png"), fullPage: true });
  await page.getByRole("button", { name: "Deconstruct product", exact: true }).click();
  await expect(page.locator(".component-select")).toHaveCount(6);
  await expect(page.getByRole("status")).toHaveText("Six assemblies, revealed.");
  await page.getByRole("button", { name: /Lithium-ion battery.*Lithium/ }).click();
  await expect(page.locator("#part-battery")).toContainText("95% recycled lithium");
  await expect(page.locator("#part-battery a")).toHaveAttribute(
    "href",
    /^https:\/\/www.apple.com\/environment/,
  );
  await page.getByRole("button", { name: "Reassemble", exact: true }).click();
  await expect(page.getByRole("button", { name: "Explode view", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Explode view", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("02-decomposition.png"), fullPage: true });
  await page.getByRole("button", { name: "Explore the supply network" }).click();
  await expect(page.locator(".supplier-row")).toHaveCount(6);
  await expect(page.locator(".map-legend")).toContainText("not factories or shipping routes");
  await page.getByRole("textbox", { name: "Find a supplier" }).fill("Samsung");
  await expect(page.locator(".supplier-row")).toHaveCount(1);
  await page.locator(".supplier-row").click();
  await expect(page.getByRole("complementary", { name: "Supplier details" })).toContainText(
    "Suwon, South Korea",
  );
  await expect(page.getByRole("link", { name: "Component source", exact: true })).toHaveAttribute(
    "href",
    /ifixit.com/,
  );
  await page.getByRole("button", { name: "Clear supplier search" }).click();
  await page.getByRole("button", { name: "Close supplier details" }).click();
  await page.screenshot({ path: testInfo.outputPath("03-globe.png"), fullPage: true });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export network", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("iphone-17-pro-supply-network.json");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /Made of parts.*Connected by a world/ }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(errors).toEqual([]);
});

test("demo input, keyboard dialog, and reduced motion remain usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByLabel("Product name").fill("Another phone");
  await page.getByRole("button", { name: "Deconstruct product", exact: true }).click();
  await expect(page.locator(".demo-error")).toContainText("iPhone 17 Pro");
  await page.getByRole("button", { name: "iPhone 17 Pro", exact: true }).click();
  await expect(page.locator(".demo-error")).toHaveCount(0);
  await page.getByRole("button", { name: "About this demo" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByLabel("Product name").press("Enter");
  await expect(page.locator(".component-select")).toHaveCount(6);
  await page.getByRole("button", { name: "Explore the supply network" }).click();
  await page.getByRole("textbox", { name: "Find a supplier" }).fill("no such supplier");
  await expect(page.getByText("No matching connections.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Show all suppliers" }).click();
  await expect(page.locator(".supplier-row")).toHaveCount(6);
});
