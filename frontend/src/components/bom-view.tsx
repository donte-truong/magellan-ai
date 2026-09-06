"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Box,
  ChevronRight,
  FileSearch,
  Layers3,
  Network,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { safeSourceUrl } from "@/lib/api";
import { isActive } from "@/lib/types";
import { SupportBadge } from "./ui";

export function BOMView() {
  const bom = useWorkspace((state) => state.bom);
  const graph = useWorkspace((state) => state.graph);
  const run = useWorkspace((state) => state.run);
  const inspect = useWorkspace((state) => state.inspect);
  const selectedEdge = useWorkspace((state) => state.selectedEdge);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const rows = useMemo(
    () =>
      (bom?.items ?? []).filter(
        (row) =>
          row.name.toLowerCase().includes(search.toLowerCase()) &&
          (kind === "all" || row.kind === kind),
      ),
    [bom, search, kind],
  );
  const active = isActive(run?.status);
  const sources = new Set(
    (bom?.items ?? []).flatMap((row) =>
      row.evidence.map((evidence) => safeSourceUrl(evidence.source?.url)).filter(Boolean),
    ),
  );
  const supported =
    bom?.items.filter((row) => row.support_label === "directly_supported").length ?? 0;

  return (
    <section className="bom-view" aria-labelledby="bom-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">01 / THE BUILDING BLOCKS</span>
          <h2 id="bom-title">Bill of materials</h2>
          <p>The components we found, and the sources that connect them.</p>
        </div>
        <button
          className="button button-primary"
          disabled={!graph}
          onClick={() => useWorkspace.getState().setStage("network")}
        >
          <Network size={16} />
          Explore network
          <ArrowRight size={16} />
        </button>
      </div>
      <div className="stats-row">
        <div>
          <span>
            <Layers3 size={16} />
            Components & materials
          </span>
          <strong>{bom?.items.length ?? "—"}</strong>
          <small>Discovered so far</small>
        </div>
        <div>
          <span>
            <FileSearch size={16} />
            Public sources
          </span>
          <strong>{bom ? sources.size : "—"}</strong>
          <small>Linked to returned components</small>
        </div>
        <div>
          <span>
            <ShieldCheck size={16} />
            Source supported
          </span>
          <strong>
            {supported}
            <span> / {bom?.items.length ?? 0}</span>
          </strong>
          <small>Of the rows shown below</small>
        </div>
      </div>
      <div className="bom-table-card">
        <div className="table-toolbar">
          <div className="filter-tabs" aria-label="Filter components">
            {[
              ["all", "All items"],
              ["component", "Components"],
              ["material", "Materials"],
            ].map(([value, label]) => (
              <button
                aria-pressed={kind === value}
                className={kind === value ? "active" : ""}
                key={value}
                onClick={() => setKind(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="table-search">
            <Search size={15} />
            <input
              placeholder="Find a component…"
              aria-label="Find a component"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Component / material</th>
                <th>Quantity</th>
                <th>Evidence</th>
                <th>Source</th>
                <th>
                  <span className="sr-only">Inspect</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.edge_id}
                  className={selectedEdge === row.edge_id ? "selected-row" : ""}
                >
                  <td>
                    <button
                      className="component-button"
                      onClick={() => inspect(row.edge_id, row.node_id)}
                    >
                      <span className={`component-icon kind-${row.kind}`}>
                        <Box size={18} />
                      </span>
                      <span>
                        <strong>{row.name}</strong>
                        <small>
                          {row.kind} <span>·</span> Tier {row.tier}
                        </small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className={row.quantity === null ? "unknown-value" : "quantity"}>
                      {row.quantity === null ? "Unknown" : `${row.quantity} ${row.unit ?? ""}`}
                    </span>
                    {row.quantity_support_label === "user_asserted" && (
                      <small className="quantity-note">User provided</small>
                    )}
                  </td>
                  <td>
                    <SupportBadge label={row.support_label} />
                  </td>
                  <td>
                    <button
                      className="table-source"
                      onClick={() => inspect(row.edge_id, row.node_id)}
                    >
                      <FileSearch size={14} />
                      {row.evidence[0]?.source?.publisher ||
                        (row.support_label === "user_asserted" ? "BOM record" : "View source")}
                      {row.evidence.length > 1 && <span>+{row.evidence.length - 1}</span>}
                    </button>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Inspect ${row.name}`}
                      onClick={() => inspect(row.edge_id, row.node_id)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <div className="table-empty">
            <span className="empty-icon">
              <FileSearch size={27} />
            </span>
            <h3>
              {search || kind !== "all"
                ? "No matching components"
                : active
                  ? "Following the first leads"
                  : "No verified components yet"}
            </h3>
            <p>
              {search || kind !== "all"
                ? "Try a different search or select all items."
                : active
                  ? "We’ll add components here as their evidence is found."
                  : "This product’s components are still unknown. Try a more specific name or the Raspberry Pi 5 example."}
            </p>
          </div>
        )}
        <div className="table-footer">
          <span>
            {rows.length} {rows.length === 1 ? "item" : "items"}
            {search || kind !== "all" ? " matching your filters" : " discovered"}
          </span>
          <span>Quantities remain unknown unless evidenced</span>
        </div>
      </div>
      {bom && (
        <div className="research-note">
          <ShieldCheck size={17} />
          <p>
            <strong>A research BOM, with its gaps in view.</strong> These are the parts we can
            trace. They may not represent the complete manufacturing bill of materials.
          </p>
        </div>
      )}
      {run?.open_questions && run.open_questions.length > 0 && (
        <details className="questions-card">
          <summary>
            <span>
              <span className="status-dot" />
              Open questions <b>{run.open_questions.length}</b>
            </span>
            <ChevronRight size={16} />
          </summary>
          <ul>
            {run.open_questions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
