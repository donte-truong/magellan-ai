// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allowedPath, proxyRequest } from "@/lib/proxy";

beforeEach(() => {
  vi.stubEnv("MAGELLAN_API_TOKEN", "server-secret");
  vi.stubEnv("MAGELLAN_API_URL", "http://research.internal:8000");
});

describe("workspace API boundary", () => {
  it("forwards credentials only upstream, with revision and idempotency intact", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        { id: "run_1" },
        {
          status: 202,
          headers: {
            "X-Request-ID": "request_1",
            "Set-Cookie": "internal=private",
            Authorization: "server-secret",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await proxyRequest(
      new Request("http://localhost:3000/api/backend/bom/decompose?revision=4", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Idempotency-Key": "retry-key",
          Authorization: "browser-token",
        },
        body: JSON.stringify({ product: "Test product" }),
      }),
      ["bom", "decompose"],
    );
    const [url, options] = fetch.mock.calls[0];
    expect(url.href).toBe("http://research.internal:8000/v1/bom/decompose?revision=4");
    expect(options.headers.get("Authorization")).toBe("Bearer server-secret");
    expect(options.headers.get("Idempotency-Key")).toBe("retry-key");
    expect(JSON.parse(options.body)).toEqual({ product: "Test product" });
    expect(options.redirect).toBe("error");
    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-ID")).toBe("request_1");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("authorization")).toBe(false);
    expect(await response.json()).toEqual({ id: "run_1" });
  });

  it.each([
    "https://elsewhere.test",
    "../sources",
    "runs/run_1/../../sources",
    "graphs/g_1/mutations",
    "sources/src_1",
    "runs/run_1/events",
  ])("does not proxy arbitrary paths: %s", async (path) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await proxyRequest(
      new Request("http://localhost:3000/api/backend/test"),
      path.split("/"),
    );
    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin writes and oversized bodies before contacting the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const foreign = await proxyRequest(
      new Request("http://localhost:3000/api/backend/bom/decompose", {
        method: "POST",
        headers: { origin: "https://foreign.test" },
        body: "{}",
      }),
      ["bom", "decompose"],
    );
    expect(foreign.status).toBe(403);
    const oversized = await proxyRequest(
      new Request("http://localhost:3000/api/backend/bom/decompose", {
        method: "POST",
        body: "x".repeat(16_385),
      }),
      ["bom", "decompose"],
    );
    expect(oversized.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the browser-facing Host when Next normalizes an internal URL", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "run_1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const response = await proxyRequest(
      new Request("http://localhost:3100/api/backend/bom/decompose", {
        method: "POST",
        headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
        body: "{}",
      }),
      ["bom", "decompose"],
    );
    expect(response.status).toBe(202);
  });

  it("requires an explicit production workspace token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAGELLAN_API_TOKEN", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      (await proxyRequest(new Request("http://localhost/api/backend/runs"), ["runs"])).status,
    ).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a useful service error without leaking upstream details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("internal-server server-secret")));
    const response = await proxyRequest(new Request("http://localhost/api/backend/runs"), ["runs"]);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("server-secret");
  });

  it("restricts mutations to MVP commands", () => {
    expect(allowedPath("runs/run_1/answers", "POST")).toBe(true);
    expect(allowedPath("runs/run_1/cancel", "POST")).toBe(true);
    expect(allowedPath("graphs/g_1/export", "GET")).toBe(true);
    expect(allowedPath("graphs/g_1/edges/e_1", "GET")).toBe(true);
    expect(allowedPath("runs/run_1", "DELETE")).toBe(false);
  });
});
