import type {
  AgentSelection,
  BOM,
  ChatReply,
  ChatTurn,
  EdgeDetail,
  EditResult,
  Graph,
  GraphMeta,
  Run,
  RunLimits,
  Sites,
} from "./types";

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
  if (response.ok && response.status === 204) return undefined as T;
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
  chat: (
    graph: string,
    message: string,
    revision: number,
    selection: AgentSelection,
    history: ChatTurn[],
    signal?: AbortSignal,
  ) =>
    apiRequest<ChatReply>(`graphs/${graph}/chat`, {
      method: "POST",
      signal,
      body: JSON.stringify({ message, revision, selection, history }),
    }),
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
  sites: (id: string, signal?: AbortSignal) => apiRequest<Sites>(`graphs/${id}/sites`, { signal }),
  /** Deepen or refine an existing graph (base or scenario) with a natural-language instruction. */
  followup: (
    graph: string,
    instruction: string,
    target_node_ids?: string[],
    limits?: Partial<RunLimits>,
    key?: string,
  ) =>
    apiRequest<Run>(`graphs/${graph}/research`, {
      method: "POST",
      headers: key ? { "Idempotency-Key": key } : undefined,
      body: JSON.stringify({
        instruction,
        ...(target_node_ids ? { target_node_ids } : {}),
        ...(limits ? { limits } : {}),
      }),
    }),
  /** Fork a base graph into a scenario for hypothetical edits and sandboxed research. */
  createScenario: (graph: string, name?: string) =>
    apiRequest<GraphMeta>(`graphs/${graph}/scenarios`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    }),
  scenarios: (graph: string, signal?: AbortSignal) =>
    apiRequest<{ items: GraphMeta[] }>(`graphs/${graph}/scenarios`, { signal }),
  /** Revert a scenario to the base graph's latest real version (the reset button). */
  resetScenario: (graph: string, scenario: string) =>
    apiRequest<GraphMeta>(`graphs/${graph}/scenarios/${scenario}/reset`, { method: "POST" }),
  deleteScenario: (graph: string, scenario: string) =>
    apiRequest<void>(`graphs/${graph}/scenarios/${scenario}`, { method: "DELETE" }),
  /** Apply a natural-language hypothetical to a scenario graph; the agent proposes the edits. */
  edit: (scenario: string, instruction: string, revision?: number, selection?: AgentSelection) =>
    apiRequest<EditResult>(`graphs/${scenario}/edits`, {
      method: "POST",
      body: JSON.stringify({
        instruction,
        revision,
        target_node_ids: selection?.node_ids,
        target_edge_ids: selection?.edge_ids,
      }),
    }),
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
