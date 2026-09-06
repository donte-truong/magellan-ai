"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ExternalLink, FileText, ShieldCheck, X } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/store";
import type { EdgeDetail } from "@/lib/types";
import { ErrorNotice, SourceLink, Spinner, SupportBadge } from "./ui";

export function EvidencePanel() {
  const graph = useWorkspace((state) => state.graph);
  const selectedEdge = useWorkspace((state) => state.selectedEdge);
  const selectedNode = useWorkspace((state) => state.selectedNode);
  const inspect = useWorkspace((state) => state.inspect);
  const [result, setResult] = useState<{ key: string; detail?: EdgeDetail; error?: string } | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const key = `${graph?.id}:${graph?.revision}:${selectedEdge}`;
  const detail = result?.key === key ? result.detail : undefined;
  const error = result?.key === key ? result.error : undefined;
  const node = graph?.nodes.find((node) => node.id === selectedNode);

  useEffect(() => {
    if (!selectedEdge || !graph) return;
    const controller = new AbortController();
    api
      .edge(graph.id, selectedEdge, graph.revision, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setResult({ key, detail });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResult({ key, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [selectedEdge, graph, key, retry]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") inspect(null);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      previous?.focus();
    };
  }, [inspect]);

  const label = (id?: string) =>
    graph?.nodes.find((node) => node.id === id)?.label ?? "Unknown entity";
  return (
    <aside className="evidence-panel" aria-labelledby="evidence-title">
      <header>
        <div>
          <span className="eyebrow">FOLLOW THE EVIDENCE</span>
          <h2 id="evidence-title">{selectedEdge ? "Connection details" : "Product details"}</h2>
        </div>
        <button
          ref={closeRef}
          className="icon-button"
          aria-label="Close evidence panel"
          onClick={() => inspect(null)}
        >
          <X size={19} />
        </button>
      </header>
      <div className="evidence-content">
        {!selectedEdge && node && (
          <>
            <span className="entity-kind">{node.kind}</span>
            <h3 className="entity-heading">{node.label}</h3>
            <p className="muted">
              {node.kind === "product"
                ? "The starting point for this exploration. Select a connection to see the claims and sources behind it."
                : "No incoming supply connection is available for this entity yet. Missing evidence means the relationship is unknown."}
            </p>
          </>
        )}
        {selectedEdge && !detail && !error && <Spinner label="Loading source evidence" />}
        {error && <ErrorNotice message={error} retry={() => setRetry((v) => v + 1)} />}
        {detail && (
          <>
            <div className="relationship-card">
              <strong>{label(detail.source_node_id)}</strong>
              <span>
                <ArrowRight size={14} />
                {detail.predicate.toLowerCase().replaceAll("_", " ")}
              </span>
              <strong>{label(detail.target_node_id)}</strong>
            </div>
            <div className="detail-meta">
              <SupportBadge label={detail.support_label} />
              <span className="scope-badge">{detail.scope.type} scope</span>
            </div>
            {detail.rationale && <p className="rationale">{detail.rationale}</p>}
            {detail.caveats.length > 0 && (
              <ul className="evidence-caveats">
                {detail.caveats.map((caveat, index) => (
                  <li key={index}>{caveat}</li>
                ))}
              </ul>
            )}
            <h3 className="evidence-section-title">
              <FileText size={15} />
              Source evidence{" "}
              <span>{detail.claims.reduce((n, c) => n + c.evidence.length, 0)}</span>
            </h3>
            {detail.claims.map((claim) => (
              <div className="claim-block" key={claim.id}>
                {claim.status !== "accepted" && (
                  <div className="claim-status">
                    Review status: {claim.status.replaceAll("_", " ")}
                  </div>
                )}
                {claim.evidence.map((evidence) => (
                  <article className="source-card" key={evidence.id}>
                    <div className="source-card-heading">
                      <span className="source-icon">
                        <FileText size={15} />
                      </span>
                      <div>
                        <strong>{evidence.source?.publisher || "Source record"}</strong>
                        <span>{evidence.source?.title || "Stored evidence"}</span>
                      </div>
                    </div>
                    <blockquote>{evidence.span}</blockquote>
                    <div className="source-location">{evidence.locator}</div>
                    <SourceLink url={evidence.source?.url}>Open original source</SourceLink>
                    {evidence.support_type !== "supports" && (
                      <small className="source-note">Evidence type: {evidence.support_type}</small>
                    )}
                  </article>
                ))}
                {claim.resolution_notes.length > 0 && (
                  <details className="review-notes">
                    <summary>Review notes</summary>
                    {claim.resolution_notes.map((note, i) => (
                      <p key={i}>{note}</p>
                    ))}
                  </details>
                )}
              </div>
            ))}
            {detail.contradictions.length > 0 && (
              <div className="error-notice">
                <ExternalLink size={16} />
                <span>
                  {detail.contradictions.length} contradictory claim(s) recorded. Review the source
                  evidence before relying on this connection.
                </span>
              </div>
            )}
            <div className="evidence-footnote">
              <ShieldCheck size={15} />
              <p>
                Support labels describe what sources state. They are not a probability or a
                guarantee of completeness.
              </p>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
