import { expect, test } from "@playwright/test";
import { bom, graph, run } from "../fixtures";

test("source failure stays visible and a safe retry populates the graph", async ({
  page,
}, testInfo) => {
  const failed = {
    ...run,
    provider: "live",
    stop_reason: "source_unavailable",
    open_questions: ["Tavily could not complete the request."],
  };
  const continued = { ...run, id: "run_recovered", mode: "followup", provider: "live" };
  let recovered = false;
  const keys: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Intercept every research API call: this test never contacts a live provider.
  await page.route("**/api/backend/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/backend/", "");
    if (path === `graphs/${graph.id}/research`) {
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON().instruction).toContain(run.product);
      keys.push(request.headers()["idempotency-key"]);
      if (keys.length === 1) {
        await route.fulfill({
          status: 503,
          json: {
            error: { code: "connection_failed", message: "Connection interrupted. Please retry." },
          },
        });
        return;
      }
      recovered = true;
      await route.fulfill({ json: continued });
      return;
    }
    if (path === "runs") {
      await route.fulfill({ json: { items: [recovered ? continued : failed] } });
      return;
    }
    if (path === `runs/${run.id}` || path === `runs/${continued.id}`) {
      await route.fulfill({ json: recovered ? continued : failed });
      return;
    }
    if (path === `graphs/${graph.id}`) {
      await route.fulfill({
        json: recovered
          ? { ...graph, revision: 4 }
          : {
              ...graph,
              nodes: [graph.nodes[0]],
              edges: [],
              stats: { node_count: 1, edge_count: 0, max_tier: 0 },
            },
      });
      return;
    }
    if (path === `graphs/${graph.id}/scenarios`) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (path.endsWith("/bom")) {
      await route.fulfill({
        json: recovered ? { ...bom, run_id: continued.id, revision: 4 } : { ...bom, items: [] },
      });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: { message: "Unexpected test request", code: "not_found" } },
    });
  });
  await page.goto(`/?run=${run.id}`);
  const banner = page.getByRole("alert", { name: "Research Sources Unavailable" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("No supply chain connections were added");
  await expect(page.locator(".studio-run-status")).toHaveText("Research Interrupted");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(banner.getByRole("link", { name: "Open iPhone Demo" })).toHaveAttribute(
    "href",
    "/demo",
  );
  await page.screenshot({
    path: testInfo.outputPath("research-source-failure.png"),
    fullPage: true,
  });
  await banner.getByRole("button", { name: "Retry Research" }).click();
  await expect(banner).toContainText("Connection interrupted. Please retry.");
  await banner.getByRole("button", { name: "Retry Research" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`run=${continued.id}`));
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("research-recovered.png"), fullPage: true });
});
