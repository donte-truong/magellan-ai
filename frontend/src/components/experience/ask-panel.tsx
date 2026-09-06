"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { FlaskConical, RotateCcw, Search, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { suppliers as curatedSuppliers } from "@/lib/demo-data";
import { loadDemoGraph, refreshLive } from "@/lib/demo-graph";
import { useDemo } from "@/lib/demo-store";

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);

/** Ask the network: evidence-backed follow-up research on the base graph, or a hypothetical
 * applied to a scenario, both through the local backend. The views reload when done. */
export function AskPanel() {
  const { liveGraphId, scenarioId, busy, setLive, setBusy, setGraph, setFullGraph } = useDemo();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (polling.current) window.clearTimeout(polling.current);
    },
    [],
  );
  if (!liveGraphId) return null;

  const activeGraph = scenarioId ?? liveGraphId;

  async function reload(graphId: string) {
    const data = await loadDemoGraph();
    if (!data) return;
    const live = await refreshLive(graphId, curatedSuppliers[0], data.index);
    setGraph(live.records, live.summary);
    setFullGraph(live.graph);
  }

  async function research(instruction: string) {
    setError(null);
    setBusy("Starting research…");
    const run = await api.followup(activeGraph, instruction, undefined, {
      max_hops: 4,
      max_seconds: 600,
      max_searches: 60,
      max_documents: 80,
      max_nodes: 600,
      max_claims: 3000,
      max_output_tokens: 300000,
      max_input_tokens: 3000000,
    });
    await new Promise<void>((resolve, reject) => {
      const tick = async () => {
        try {
          const current = await api.run(run.id);
          const u = current.usage as { searches?: number; documents?: number };
          setBusy(
            `Researching · ${current.progress.tasks_done}/${current.progress.tasks_total} tasks · ${u.searches ?? 0} searches · ${u.documents ?? 0} pages`,
          );
          if (TERMINAL.has(current.status)) {
            setNote(
              `Research ${current.status}${current.stop_reason ? ` (${current.stop_reason.replace(/_/g, " ")})` : ""}.`,
            );
            resolve();
            return;
          }
          polling.current = window.setTimeout(tick, 4000);
        } catch (cause) {
          reject(cause);
        }
      };
      void tick();
    });
    await reload(activeGraph);
  }

  async function whatIf(instruction: string) {
    setError(null);
    setBusy("Forking a scenario…");
    let scenario = scenarioId;
    if (!scenario) {
      const created = await api.createScenario(liveGraphId!, "What if");
      scenario = created.id;
      setLive(liveGraphId, scenario);
    }
    setBusy("Applying the hypothetical…");
    const result = await api.edit(scenario, instruction);
    const applied = result.applied.map((a) => String(a.op).replace(/_/g, " ")).join(", ");
    setNote(
      result.applied.length
        ? `Scenario updated: ${applied}.${result.skipped.length ? ` ${result.skipped.length} skipped.` : ""}`
        : "Nothing could be expressed as a graph change.",
    );
    await reload(scenario);
  }

  async function reset() {
    if (!scenarioId) return;
    setError(null);
    setBusy("Reverting to the real graph…");
    try {
      await api.deleteScenario(liveGraphId!, scenarioId);
      setLive(liveGraphId, null);
      await reload(liveGraphId!);
      setNote("Back to the latest real version.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reset failed");
    } finally {
      setBusy(null);
    }
  }

  async function submit(event: FormEvent, mode: "research" | "whatif") {
    event.preventDefault();
    const instruction = text.trim();
    if (!instruction || busy) return;
    try {
      if (mode === "research") await research(instruction);
      else await whatIf(instruction);
      setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The backend is not reachable");
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="ask-panel"
      onSubmit={(e) => submit(e, "research")}
      aria-label="Ask the network"
    >
      {scenarioId && (
        <div className="ask-scenario" role="status">
          <FlaskConical size={13} />
          Viewing a scenario. Hypotheticals change this copy, never the real graph.
          <button type="button" onClick={reset} disabled={Boolean(busy)}>
            <RotateCcw size={12} /> Reset
          </button>
        </div>
      )}
      <label className="ask-input">
        <Sparkles size={15} />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask the network: deepen a part, or try a hypothetical"
          aria-label="Instruction"
          disabled={Boolean(busy)}
        />
      </label>
      <div className="ask-actions">
        <button type="submit" className="primary-button" disabled={Boolean(busy) || !text.trim()}>
          <Search size={14} /> Research
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={(e) => submit(e, "whatif")}
          disabled={Boolean(busy) || !text.trim()}
        >
          <FlaskConical size={14} /> What if
        </button>
      </div>
      <p className={`ask-status ${error ? "is-error" : ""}`} role="status">
        {error ??
          busy ??
          note ??
          "Research adds verified evidence from public sources; What if applies a hypothetical to a scenario you can reset."}
      </p>
    </form>
  );
}
