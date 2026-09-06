"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronRight, FileSearch, Layers3, Search } from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { isActive } from "@/lib/types";
import { nodeColors } from "@/lib/graph-layout";
import { SupportBadge } from "./ui";

export function BOMView() {
  const { bom, run, selectedEdge, inspect } = useWorkspace();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const rows = useMemo(
    () =>
      (bom?.items ?? []).filter(
        (row) =>
          (kind === "all" || row.kind === kind) &&
          row.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [bom, kind, query],
  );
  const active = isActive(run?.status);
  return (
    <section className="studio-bom" aria-label="Bill of materials">
      <div className="studio-bom-toolbar">
        <div className="studio-bom-filters" aria-label="Filter components">
          {[
            ["all", "All Items"],
            ["component", "Components"],
            ["material", "Materials"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={kind === value}
              className={kind === value ? "is-active" : ""}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="studio-graph-search">
          <Search size={14} />
          <input
            aria-label="Find a component"
            placeholder="Find a component…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="studio-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Component / Material</th>
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
              <tr key={row.edge_id} className={selectedEdge === row.edge_id ? "is-selected" : ""}>
                <td>
                  <button className="studio-bom-entity" onClick={() => inspect(null, row.node_id)}>
                    <span style={{ background: nodeColors[row.kind] }} />
                    <span>
                      <strong>{row.name}</strong>
                      <small>
                        {row.kind} · Tier {row.tier}
                      </small>
                    </span>
                  </button>
                </td>
                <td>
                  {row.quantity === null ? (
                    <span className="studio-unknown">Unknown</span>
                  ) : (
                    `${row.quantity} ${row.unit ?? ""}`
                  )}
                  {row.quantity_support_label === "user_asserted" && (
                    <small className="studio-quantity-note">User provided</small>
                  )}
                </td>
                <td>
                  <SupportBadge label={row.support_label} />
                </td>
                <td>
                  <button
                    className="studio-table-source"
                    onClick={() => inspect(row.edge_id, row.node_id)}
                  >
                    <FileSearch size={13} />
                    {row.evidence[0]?.source?.publisher ?? "View Evidence"}
                    <ArrowUpRight size={12} />
                  </button>
                </td>
                <td>
                  <button
                    className="studio-icon"
                    aria-label={`Inspect ${row.name}`}
                    onClick={() => inspect(row.edge_id, row.node_id)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <div className="studio-table-empty">
          <Layers3 size={28} />
          <h2>
            {query || kind !== "all"
              ? "No matching components"
              : active
                ? "Following the first leads"
                : "No verified components yet"}
          </h2>
          <p>
            {query || kind !== "all"
              ? "Try another search or show all items."
              : active
                ? "Components appear as their sources are verified."
                : "The available evidence has not identified this product’s parts."}
          </p>
        </div>
      )}
      <footer>
        <span>
          {rows.length} {rows.length === 1 ? "item" : "items"}
        </span>
        <span>A research BOM. Quantities stay unknown unless evidenced.</span>
      </footer>
    </section>
  );
}
