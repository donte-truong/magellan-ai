const identifier = "[a-zA-Z0-9_-]+";
const readPaths = [
  /^runs$/,
  new RegExp(`^runs/${identifier}(?:/bom)?$`),
  new RegExp(`^graphs/${identifier}(?:/export|/edges/${identifier})?$`),
];
const writePaths = [/^bom\/decompose$/, new RegExp(`^runs/${identifier}/(?:cancel|answers)$`)];

export function allowedPath(path: string, method: string) {
  return (method === "GET" ? readPaths : method === "POST" ? writePaths : []).some((rule) =>
    rule.test(path),
  );
}

function failure(message: string, status: number, code: string) {
  return Response.json(
    { error: { message, code, details: {}, request_id: crypto.randomUUID() } },
    { status },
  );
}

export async function proxyRequest(request: Request, segments: string[]) {
  const path = segments.join("/");
  if (!allowedPath(path, request.method)) return failure("Resource not found", 404, "not_found");
  const origin = request.headers.get("origin");
  if (request.method === "POST" && origin) {
    // Next may construct request.url with an internal hostname. Host retains the
    // browser-facing authority, including its port, through the local server.
    const host = request.headers.get("host") || new URL(request.url).host;
    let sameOrigin = false;
    try {
      const source = new URL(origin);
      sameOrigin = ["http:", "https:"].includes(source.protocol) && source.host === host;
    } catch {
      /* Invalid or opaque origins are not trusted. */
    }
    if (!sameOrigin) return failure("Request origin is not allowed", 403, "invalid_input");
  }
  const token =
    process.env.MAGELLAN_API_TOKEN || (process.env.NODE_ENV !== "production" ? "dev-token" : "");
  if (!token)
    return failure(
      "The workspace connection is not configured. Contact the workspace owner.",
      503,
      "not_configured",
    );
  try {
    const base = new URL(process.env.MAGELLAN_API_URL || "http://127.0.0.1:3001");
    const target = new URL(`/v1/${path}`, base);
    target.search = new URL(request.url).search;
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const key = request.headers.get("idempotency-key");
    if (key) headers.set("Idempotency-Key", key);
    let body: string | undefined;
    if (request.method === "POST") {
      // Product research requests are small. Never buffer an unbounded request body.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 16_384) {
            await reader.cancel();
            return failure("Request is too large", 413, "invalid_input");
          }
          chunks.push(value);
        }
      }
      body = Buffer.concat(chunks).toString("utf8");
      if (body) headers.set("Content-Type", "application/json");
    }
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: body || undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const key of ["content-type", "content-disposition", "retry-after", "x-request-id"]) {
      const value = upstream.headers.get(key);
      if (value) responseHeaders.set(key, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return failure(
      "The research service is unavailable. Please try again in a moment.",
      502,
      "service_unavailable",
    );
  }
}
