"use client";

import { useEffect, useState } from "react";
import { GitBranch, LoaderCircle, RotateCcw, RefreshCw } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useWorkspace, visibleGraph } from "@/lib/store";
import { isActive, type GraphMeta } from "@/lib/types";

export function ScenarioControl() {
  const graph = useWorkspace(visibleGraph)!;
  const baseId = graph.parent_graph_id ?? graph.id;
  const [items, setItems] = useState<GraphMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useWorkspace((state) => isActive(state.run?.status) || state.agentBusy);
  useEffect(() => {
    const controller = new AbortController();
    api
      .scenarios(baseId, controller.signal)
      .then(({ items }) => setItems(items))
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [baseId, graph.id]);

  async function change(id: string, reset = false) {
    if (busy || active) return;
    const generation = useWorkspace.getState().generation;
    const viewedId = graph.id;
    setBusy(true);
    setError(null);
    try {
      if (reset) await api.resetScenario(baseId, id);
      const next = await api.graph(id);
      if (
        useWorkspace.getState().generation !== generation ||
        visibleGraph(useWorkspace.getState())?.id !== viewedId
      )
        return;
      if (id === baseId) {
        // A scenario may have its own follow-up run. Restore the base run as well.
        if (useWorkspace.getState().graph?.id !== baseId && next.run_id) {
          const baseRun = await api.run(next.run_id);
          if (useWorkspace.getState().generation !== generation) return;
          useWorkspace.getState().begin(baseRun);
        } else useWorkspace.getState().viewScenario(null);
      } else useWorkspace.getState().viewScenario(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  if (!items.length && graph.mode !== "scenario" && !error) return null;
  return (
    <div className={`studio-scenario ${graph.mode === "scenario" ? "is-scenario" : ""}`}>
      <GitBranch size={15} />
      <label>
        <span className="sr-only">Graph version</span>
        <select
          aria-label="Graph version"
          value={graph.id}
          disabled={busy || active}
          onChange={(event) => void change(event.target.value)}
        >
          <option value={baseId}>Original Graph</option>
          {[
            ...items,
            ...(graph.mode === "scenario" && !items.some((s) => s.id === graph.id)
              ? [{ id: graph.id, name: graph.name }]
              : []),
          ].map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <span>
        {graph.mode === "scenario" ? "Hypothetical · Original Preserved" : "Evidence Graph"}
      </span>
      {graph.mode === "scenario" && (
        <button
          disabled={busy || active}
          onClick={() => void change(graph.id)}
          aria-label="Refresh scenario"
        >
          <RefreshCw size={13} />
          Refresh
        </button>
      )}
      {graph.mode === "scenario" && (
        <button
          disabled={busy || active}
          onClick={() => void change(graph.id, true)}
          title="Revert this scenario to the latest original graph"
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}Reset
          Scenario
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
