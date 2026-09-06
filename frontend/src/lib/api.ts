import type { BOM, EdgeDetail, Graph, Run } from "./types";

export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = "APIError";
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/backend/${path}`, {
      ...init,
      cache: "no-store",
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new APIError(
      "We couldn’t connect. Check your connection and try again.",
      0,
      "connection_failed",
    );
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error;
    throw new APIError(
      error?.message ?? "Something went wrong. Please try again.",
      response.status,
      error?.code ?? "unknown",
      error?.request_id,
    );
  }
  if (!payload)
    throw new APIError(
      "The server returned an empty response. Please try again.",
      502,
      "invalid_response",
    );
  return payload as T;
}

export const api = {
  decompose: (product: string, company: string, key: string, signal?: AbortSignal) =>
    apiRequest<Run>("bom/decompose", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      signal,
      body: JSON.stringify({ product, ...(company.trim() ? { company: company.trim() } : {}) }),
    }),
  run: (id: string, signal?: AbortSignal) => apiRequest<Run>(`runs/${id}`, { signal }),
  bom: (id: string, revision: number, signal?: AbortSignal) =>
    apiRequest<BOM>(`runs/${id}/bom?revision=${revision}`, { signal }),
  graph: (id: string, signal?: AbortSignal) => apiRequest<Graph>(`graphs/${id}`, { signal }),
  edge: (graph: string, edge: string, revision: number, signal?: AbortSignal) =>
    apiRequest<EdgeDetail>(`graphs/${graph}/edges/${edge}?revision=${revision}`, { signal }),
  recent: (signal?: AbortSignal) => apiRequest<{ items: Run[] }>("runs?limit=5", { signal }),
  cancel: (id: string) => apiRequest<Run>(`runs/${id}/cancel`, { method: "POST" }),
  answer: (id: string, question_id: string, choice: string) =>
    apiRequest<Run>(`runs/${id}/answers`, {
      method: "POST",
      body: JSON.stringify({ question_id, choice }),
    }),
};

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Please try again.";
export const safeSourceUrl = (value?: string | null) => {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};
