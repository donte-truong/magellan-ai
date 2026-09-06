"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { useWorkspace } from "./store";
import { isActive } from "./types";

/** Sequential polling avoids overlapping calls; graph/BOM reads pin the same revision. */
export function useResearch() {
  const id = useWorkspace((state) => state.run?.id);
  const generation = useWorkspace((state) => state.generation);
  const [issue, setIssue] = useState<{ generation: number; message: string } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function refresh() {
      try {
        const run = await api.run(id!, controller.signal);
        const graph = await api.graph(run.graph_id, controller.signal);
        const bom = await api.bom(run.id, graph.revision, controller.signal);
        if (controller.signal.aborted) return;
        useWorkspace.getState().update(generation, run, graph, bom);
        setIssue(null);
        failures = 0;
        if (isActive(run.status))
          timer = setTimeout(refresh, run.status === "awaiting_input" ? 2000 : 1200);
      } catch (error) {
        if (controller.signal.aborted) return;
        setIssue({ generation, message: errorMessage(error) });
        failures += 1;
        timer = setTimeout(refresh, Math.min(1500 * 2 ** failures, 15_000));
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, generation, retry]);

  return {
    error: issue?.generation === generation ? issue.message : null,
    refresh: () => setRetry((v) => v + 1),
  };
}
