import { expect, test, type Page } from "@playwright/test";

async function scrollJourney(page: Page, offset: number) {
  await page.evaluate((offset) => {
    const world = document.querySelector<HTMLElement>("#world")!;
    const entry = world.getBoundingClientRect().top + scrollY - innerHeight;
    window.scrollTo({ top: entry + offset, behavior: "instant" });
  }, offset);
}

async function flightPixels(page: Page) {
  return page.locator(".landing-component-journey").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 35) visible++;
    return visible;
  });
}

test("landing reveals the product, explores the globe, and opens the demo", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/home");
  await expect(page).toHaveTitle("Magellan — A world within every product");
  await expect(page.locator(".landing-nav a")).toHaveText([
    "Discover",
    "The Bigger Picture",
    "Our Approach",
  ]);
  await expect(page.getByText("Scroll to uncover", { exact: true })).toHaveCount(0);
  await expect(page.getByText("One familiar product.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Every product.A world ofsupply chains.",
  );
  await expect(page.locator(".product-canvas canvas")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pause animations|Resume animations/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("home-01-hero.png") });

  // Scrolling drives the same model without changing the exploration store.
  await page.evaluate(() => {
    const story = document.querySelector<HTMLElement>(".landing-story")!;
    const hero = document.querySelector<HTMLElement>(".landing-hero")!;
    const header = document.querySelector<HTMLElement>(".landing-header")!;
    scrollTo({
      top: (story.offsetTop + story.offsetHeight - hero.offsetHeight - header.offsetHeight) * 0.8,
      behavior: "instant",
    });
  });
  await expect(page.getByRole("button", { name: "Reassemble iPhone" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.waitForTimeout(1400);
  await page.screenshot({ path: testInfo.outputPath("home-02-layers.png") });
  await page.getByRole("button", { name: "Reassemble iPhone" }).click();
  await expect(page.getByRole("button", { name: "Take a closer look" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.locator(".landing-wave-transition").scrollIntoViewIfNeeded();
  await expect(page.locator(".landing-wave-layer").first()).toHaveCSS(
    "animation-play-state",
    "running",
  );
  await page.screenshot({ path: testInfo.outputPath("home-03a-waves.png") });
  await page.locator("#world").scrollIntoViewIfNeeded();
  await expect(page.locator(".globe-canvas canvas")).toBeVisible();
  await expect(page.locator(".globe-location-card:visible")).not.toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("home-03-world.png") });
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Reset globe view" }).click();

  await page.locator("#evidence").scrollIntoViewIfNeeded();
  await expect(page.locator(".landing-source-stack a")).toHaveCount(3);
  await expect(page.locator(".landing-source-stack a").nth(1)).toHaveAttribute(
    "href",
    /ifixit\.com/,
  );
  await page.screenshot({ path: testInfo.outputPath("home-04-evidence.png") });
  await page.locator(".landing-outro").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("home-05-outro.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.getByRole("link", { name: "Explore your first product" }).click();
  await expect(page.getByLabel("Product name")).toHaveValue("iPhone 17 Pro");
  await page.getByRole("button", { name: "Deconstruct product", exact: true }).click();
  await expect(page.locator(".component-select")).toHaveCount(6);
  expect(errors).toEqual([]);
});

test("landing respects reduced motion and links directly to the supply network", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/home");
  await expect(page.locator(".landing-hero")).toHaveCSS("position", "relative");
  await expect(page.locator(".landing-wave-layer").first()).toHaveCSS("animation-name", "none");
  await expect(page.locator(".landing-component-journey")).toHaveAttribute("data-phase", "idle");
  await page.getByRole("button", { name: "Take a closer look" }).click();
  await expect(page.getByRole("button", { name: "Reassemble iPhone" })).toBeVisible();
  await page.getByRole("link", { name: "Explore the network", exact: true }).click();
  await expect(page.locator(".supplier-row")).toHaveCount(6);
  await page.getByRole("link", { name: "Magellan home", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  // Next.js can preserve the landing page's local view on client navigation.
  const toggle = page.getByRole("button", { name: /Take a closer look|Reassemble iPhone/ });
  await expect(toggle).toBeVisible();
  const wasExpanded = (await toggle.getAttribute("aria-pressed")) === "true";
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(!wasExpanded));
});

test("section entry triggers one component-to-dot flight", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/home");
  await expect(page.locator(".landing-loader")).toHaveCount(0);
  const journey = page.locator(".landing-component-journey");
  await expect(journey).toHaveAttribute("aria-hidden", "true");
  await expect(journey).toHaveCSS("pointer-events", "none");
  await scrollJourney(page, -4);
  await page.waitForTimeout(1400);
  await expect(journey).toHaveAttribute("data-phase", "idle");
  await scrollJourney(page, 4);
  await expect(journey).toHaveAttribute("data-phase", "playing");
  const triggerScroll = await page.evaluate(() => scrollY);
  await expect.poll(() => flightPixels(page)).toBeGreaterThan(250);
  await expect(journey).toHaveAttribute("data-stage", "dots");
  await expect(journey).toHaveAttribute("data-dot-count", "6");
  await page.screenshot({ path: testInfo.outputPath("home-six-glowing-dots.png") });
  await expect
    .poll(async () => Number(await journey.getAttribute("data-progress")))
    .toBeGreaterThan(0.25);
  expect(await page.evaluate(() => scrollY)).toBe(triggerScroll);
  await expect(journey).toHaveAttribute("data-phase", "complete");
  await expect(journey).toHaveAttribute("data-progress", "1.000");
  await expect.poll(() => flightPixels(page)).toBe(0);

  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await expect(page.getByRole("button", { name: "Take a closer look" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await scrollJourney(page, 12);
  await page.waitForTimeout(350);
  await expect(journey).toHaveAttribute("data-phase", "complete");
  await page.locator(".landing-world-scene").scrollIntoViewIfNeeded();
  await expect(page.locator(".globe-pin:visible")).not.toHaveCount(0);
  expect(errors).toEqual([]);
});

test("compass screen covers pending assets and fades into the ready page", async ({ page }) => {
  let release!: () => void;
  const assets = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/models/world-points.json", async (route) => {
    await assets;
    await route.continue();
  });
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector(".landing-loader.is-leaving")) {
        document.documentElement.dataset.loadingFade = "true";
        observer.disconnect();
      }
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  });
  await page.goto("/home");
  const loader = page.getByRole("status", { name: "Loading Magellan" });
  await expect(loader).toBeVisible();
  await expect(page.locator(".landing-page")).toHaveAttribute("inert", "");
  await expect(page.locator(".landing-loader .magellan-compass-needle")).toHaveCSS(
    "animation-name",
    "landing-compass-bearing",
  );
  await page.waitForTimeout(1200);
  await expect(loader).toBeVisible();
  release();
  await expect(loader).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-loading-fade", "true");
  await expect(page.locator(".landing-page")).not.toHaveAttribute("inert");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".globe-fallback")).toHaveCount(0);
});

test("failed map assets reveal a usable page with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/assets/models/*.json", (route) => route.abort());
  await page.goto("/home");
  await expect(page.locator(".landing-loader")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Explore Magellan", exact: true })).toBeVisible();
  await page.locator(".landing-world-scene").scrollIntoViewIfNeeded();
  await expect(page.locator(".globe-fallback")).toBeVisible();
  await expect(page.locator(".landing-component-journey")).toHaveAttribute("data-phase", "idle");
});
