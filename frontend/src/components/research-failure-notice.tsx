"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CloudOff, LoaderCircle, RotateCcw } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { researchFailure } from "@/lib/research-failure";
import { useWorkspace, visibleGraph } from "@/lib/store";
import type { Graph, Run } from "@/lib/types";

export function ResearchFailureNotice({ run, graph }: { run: Run; graph: Graph | null }) {
  const failure = researchFailure(run);
  const agentBusy = useWorkspace((state) => state.agentBusy);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const requestGeneration = useRef<number | null>(null);
  const retryKey = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (busy.current && useWorkspace.getState().generation === requestGeneration.current)
        useWorkspace.setState({ agentBusy: false });
      busy.current = false;
    };
  }, []);

  if (!failure) return null;

  async function retry() {
    const state = useWorkspace.getState();
    if (!graph || busy.current || state.agentBusy || graph.id !== run.graph_id) return;
    const generation = state.generation;
    requestGeneration.current = generation;
    const instruction =
      run.instruction?.trim() ||
      `Research the components, materials, suppliers, and manufacturing locations for ${run.product}${run.company ? ` by ${run.company}` : ""}. Follow public sources and add evidence-supported supply chain relationships to this graph.`;
    // Preserve the key if a transport error leaves the request's outcome uncertain.
    retryKey.current ??= crypto.randomUUID();
    busy.current = true;
    useWorkspace.setState({ agentBusy: true });
    setPending(true);
    setError(null);
    const current = () =>
      mounted.current &&
      useWorkspace.getState().generation === generation &&
      useWorkspace.getState().run?.id === run.id &&
      visibleGraph(useWorkspace.getState())?.id === graph.id;
    try {
      const next = await api.followup(
        graph.id,
        instruction,
        undefined,
        undefined,
        retryKey.current,
      );
      if (!current()) return;
      useWorkspace.setState({ agentBusy: false });
      useWorkspace.getState().continueRun(next);
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      const ownsBusy = busy.current;
      busy.current = false;
      if (ownsBusy && useWorkspace.getState().generation === generation)
        useWorkspace.setState({ agentBusy: false });
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section className="studio-provider-failure" role="alert" aria-label={failure.title}>
      <CloudOff size={20} aria-hidden="true" />
      <div>
        <h2>{failure.title}</h2>
        <p>{failure.message}</p>
        <p className="studio-provider-preserved">
          {!graph
            ? "Your exploration is saved. Retry once the graph is available."
            : graph.edges.length
              ? "Your existing findings are saved. Retrying continues this exploration."
              : "No supply chain connections were added. You can retry this exploration or open the iPhone demo."}
        </p>
        <div className="studio-provider-actions">
          <button
            className="studio-secondary"
            disabled={!graph || graph.id !== run.graph_id || pending || agentBusy}
            onClick={retry}
          >
            {pending ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />}
            {pending ? "Restarting Research…" : "Retry Research"}
          </button>
          <Link href="/demo">
            Open iPhone Demo <ArrowUpRight size={13} />
          </Link>
        </div>
        {error && <p className="studio-provider-retry-error">{error}</p>}
      </div>
    </section>
  );
}
