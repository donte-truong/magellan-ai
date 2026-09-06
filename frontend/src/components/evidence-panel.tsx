"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  FileText,
  GitBranch,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/store";
import { nodeColors } from "@/lib/graph-layout";
import type { Graph, GraphNode } from "@/lib/types";
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
          <span className="eyebrow">A CLOSER LOOK</span>
          <h2 id="evidence-title">{selectedEdge ? "Connection details" : "Entity Details"}</h2>
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
        {!selectedEdge && node && graph && <NodeOverview node={node} graph={graph} />}
        {selectedEdge && node && (
          <button className="studio-inspector-back" onClick={() => inspect(null, node.id)}>
            <ArrowLeft size={14} />
            Back to {node.label}
          </button>
        )}
        {selectedEdge && !detail && !error && <Spinner label="Loading source evidence" />}
        {error && <ErrorNotice message={error} retry={() => setRetry((v) => v + 1)} />}
        {detail && (
          <>
            <div className="relationship-card">
              <button onClick={() => inspect(null, detail.source_node_id)}>
                {label(detail.source_node_id)}
                <ArrowUpRight size={13} />
              </button>
              <span>
                <ArrowRight size={14} />
                {detail.predicate.toLowerCase().replaceAll("_", " ")}
              </span>
              <button onClick={() => inspect(null, detail.target_node_id)}>
                {label(detail.target_node_id)}
                <ArrowUpRight size={13} />
              </button>
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
            {[
              ...detail.claims,
              ...detail.contradictions.filter(
                (claim) => !detail.claims.some((item) => item.id === claim.id),
              ),
            ].map((claim) => (
              <div className="claim-block" key={claim.id}>
                {claim.status !== "accepted" && (
                  <div className="claim-status">
                    Review status: {claim.status.replaceAll("_", " ")}
                  </div>
                )}
                {claim.rationale && <p className="studio-claim-rationale">{claim.rationale}</p>}
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
                    {evidence.source?.retrieved_at && (
                      <span className="studio-source-date">
                        Retrieved {new Date(evidence.source.retrieved_at).toLocaleDateString()}
                      </span>
                    )}
                    <details className="studio-source-record">
                      <summary>Source Record</summary>
                      <div className="source-location">{evidence.locator}</div>
                      {evidence.source?.license_notes && <p>{evidence.source.license_notes}</p>}
                    </details>
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
                <ShieldCheck size={16} />
                <span>
                  {detail.contradictions.length} contradictory claim(s) recorded. Review the source
                  evidence before relying on this connection.
                </span>
              </div>
            )}
            <RecordedDetails data={detail.data} />
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

function NodeOverview({ node, graph }: { node: GraphNode; graph: Graph }) {
  const inspect = useWorkspace((state) => state.inspect);
  const connections = graph.edges.filter(
    (edge) => edge.source_node_id === node.id || edge.target_node_id === node.id,
  );
  return (
    <>
      <div className="studio-entity-heading">
        <span
          className="studio-entity-orb"
          style={{
            background: nodeColors[node.kind],
            boxShadow: `0 0 35px ${nodeColors[node.kind]}55`,
          }}
        />
        <span className="entity-kind">{node.kind}</span>
        <h3>{node.label}</h3>
        <SupportBadge label={node.status} />
      </div>
      <dl className="studio-entity-facts">
        <div>
          <dt>Supply Tier</dt>
          <dd>
            {node.tier === null ? "Context" : node.tier === 0 ? "Product" : `Tier ${node.tier}`}
          </dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd>{connections.length}</dd>
        </div>
        {Object.entries(node.external_ids ?? {}).map(([key, value]) => (
          <div key={key}>
            <dt>{humanize(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {node.canonical_name && node.canonical_name !== node.label && (
        <p className="studio-aliases">
          Recorded as <strong>{node.canonical_name}</strong>
        </p>
      )}
      {Boolean(node.aliases?.length) && (
        <div className="studio-aliases">
          <span>Also Known As</span>
          {node.aliases!.map((alias) => (
            <strong key={alias}>{alias}</strong>
          ))}
        </div>
      )}
      {Boolean(node.flags?.length) && (
        <div className="studio-node-flags">
          {node.flags!.map((flag) => (
            <span key={flag}>{humanize(flag)}</span>
          ))}
        </div>
      )}
      <h3 className="evidence-section-title">
        <GitBranch size={15} />
        Connected Entities<span>{connections.length}</span>
      </h3>
      <div className="studio-connections">
        {connections.map((edge) => {
          const outgoing = edge.source_node_id === node.id;
          const other = graph.nodes.find(
            (item) => item.id === (outgoing ? edge.target_node_id : edge.source_node_id),
          );
          return (
            <article key={edge.id}>
              <span>
                {outgoing ? "This entity" : "Connected entity"} <ArrowRight size={11} />
                {edge.predicate.toLowerCase().replaceAll("_", " ")}
              </span>
              <button
                className="studio-connected-node"
                onClick={() => inspect(null, other?.id ?? null)}
                disabled={!other}
              >
                <i style={{ background: other ? nodeColors[other.kind] : undefined }} />
                {other?.label ?? "Unknown entity"}
                <ArrowUpRight size={13} />
              </button>
              <div>
                <SupportBadge label={edge.support_label} />
                <button
                  className="studio-connection-evidence"
                  aria-label={`Inspect evidence for ${edge.predicate.toLowerCase().replaceAll("_", " ")} ${other?.label ?? "connection"}`}
                  onClick={() => inspect(edge.id, node.id)}
                >
                  Evidence
                  <ArrowRight size={12} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!connections.length && (
        <p className="studio-inspector-empty">
          No relationships have been verified for this entity yet.
        </p>
      )}
      <RecordedDetails data={node.data} />
    </>
  );
}
function humanize(value: string) {
  if (value === "mpn") return "Part Number";
  if (value === "country_iso2") return "Country Code";
  if (value === "lat") return "Latitude";
  if (value === "lon") return "Longitude";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function hasValue(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    (typeof value !== "object" || Object.keys(value).length > 0)
  );
}
function RecordedDetails({ data }: { data: GraphNode["data"] }) {
  return (
    <div className="studio-recorded-details">
      {Object.entries(data)
        .filter(([, value]) => hasValue(value))
        .map(([name, value]) => (
          <details key={name}>
            <summary>
              {name === "custom" ? "Additional Details" : humanize(name)}
              <span>+</span>
            </summary>
            <DetailValue value={value} />
          </details>
        ))}
    </div>
  );
}
function DetailValue({ value }: { value: unknown }) {
  if (Array.isArray(value))
    return (
      <ul>
        {value.map((item, i) => (
          <li key={i}>
            <DetailValue value={item} />
          </li>
        ))}
      </ul>
    );
  if (value && typeof value === "object")
    return (
      <dl>
        {Object.entries(value)
          .filter(([, item]) => hasValue(item))
          .map(([name, item]) => (
            <div key={name}>
              <dt>{humanize(name)}</dt>
              <dd>
                <DetailValue value={item} />
              </dd>
            </div>
          ))}
      </dl>
    );
  return (
    <span>
      {value === null || value === undefined
        ? "Unknown"
        : typeof value === "boolean"
          ? value
            ? "Yes"
            : "No"
          : String(value)}
    </span>
  );
}
