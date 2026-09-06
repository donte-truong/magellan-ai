"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import {
  Focus,
  GitBranch,
  Minus,
  MousePointer2,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useWorkspace, visibleGraph } from "@/lib/store";
import { kindLabels, layoutGraph, nodeColors, type SupplyNode } from "@/lib/graph-layout";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import type { Graph } from "@/lib/types";

function SupplyPoint({ data, selected }: NodeProps<SupplyNode>) {
  return (
    <div
      className={`supply-point ${data.kind === "product" ? "is-root" : ""} ${selected ? "is-selected" : ""}`}
      style={{ "--node-color": nodeColors[data.kind] } as CSSProperties}
    >
      <Handle type="source" position={Position.Top} isConnectable={false} />
      <span className="supply-point-halo" />
      <span className="supply-point-core" />
      <span className="supply-point-label">
        {data.label}
        {data.kind === "product" && <small>YOUR PRODUCT</small>}
      </span>
      <Handle type="target" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
const nodeTypes = { supply: SupplyPoint };
export interface NetworkSelection {
  selectedNode: string | null;
  selectedEdge: string | null;
  /** Inspect an edge (with its source node) or a node; null clears the selection. */
  inspect: (edge: string | null, node?: string | null) => void;
}

/** The workspace's graph view, bound to the workspace store. */
export function NetworkView() {
  const graph = useWorkspace(visibleGraph);
  const selectedNode = useWorkspace((state) => state.selectedNode);
  const selectedEdge = useWorkspace((state) => state.selectedEdge);
  const inspect = useWorkspace((state) => state.inspect);
  return graph ? (
    <NetworkGraph
      graph={graph}
      selectedNode={selectedNode}
      selectedEdge={selectedEdge}
      inspect={inspect}
    />
  ) : null;
}

/** The same graph view for any graph and any selection owner (the demo page uses it too). */
export function NetworkGraph({ graph, ...selection }: { graph: Graph } & NetworkSelection) {
  return (
    <section className="studio-network" aria-label="The supply network">
      <ReactFlowProvider>
        <NetworkCanvas key={graph.id} graph={graph} {...selection} />
      </ReactFlowProvider>
    </section>
  );
}
function NetworkCanvas({
  graph,
  selectedNode,
  selectedEdge,
  inspect,
}: { graph: Graph } & NetworkSelection) {
  const flow = useMemo(() => layoutGraph(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<SupplyNode>(flow.nodes);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const [neighborsOnly, setNeighborsOnly] = useState(false);
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      setNodes((previous) =>
        flow.nodes.map((node) => {
          const existing = previous.find((item) => item.id === node.id);
          return existing ? { ...node, position: existing.position } : node;
        }),
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [flow, setNodes]);
  useEffect(() => {
    if (!canvas.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView({ padding: 0.38, maxZoom: 1.3 }));
    });
    observer.observe(canvas.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fitView]);

  const focus = hovered ?? selectedNode;
  const connected = new Set<string>(focus ? [focus] : []);
  const neighborhood = new Set<string>(selectedNode ? [selectedNode] : []);
  for (const edge of graph.edges) {
    if (edge.source_node_id === focus) connected.add(edge.target_node_id);
    if (edge.target_node_id === focus) connected.add(edge.source_node_id);
    if (edge.source_node_id === selectedNode) neighborhood.add(edge.target_node_id);
    if (edge.target_node_id === selectedNode) neighborhood.add(edge.source_node_id);
  }
  const search = query.trim().toLowerCase();
  const matches = new Set(
    graph.nodes
      .filter((node) =>
        `${node.label} ${node.aliases?.join(" ") ?? ""} ${Object.values(node.external_ids ?? {}).join(" ")}`
          .toLowerCase()
          .includes(search),
      )
      .map((node) => node.id),
  );
  const visibleIds = new Set(
    nodes
      .filter(
        (node) =>
          (filter === "all" || node.data.kind === filter || node.id === graph.root_node_id) &&
          (!search || matches.has(node.id) || node.id === graph.root_node_id) &&
          (!neighborsOnly || !selectedNode || neighborhood.has(node.id)),
      )
      .map((node) => node.id),
  );
  const visibleNodes = nodes
    .filter((node) => visibleIds.has(node.id))
    .map((node) => ({
      ...node,
      selected: node.id === selectedNode,
      style: { opacity: focus && !connected.has(node.id) ? 0.18 : 1 },
    }));
  const visibleEdges = flow.edges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .map((edge) => {
      const highlighted =
        edge.id === selectedEdge ||
        Boolean(focus && (edge.source === focus || edge.target === focus));
      const relation = graph.edges.find((item) => item.id === edge.id)!;
      return {
        ...edge,
        selected: edge.id === selectedEdge,
        label:
          edge.id === selectedEdge
            ? relation.predicate.toLowerCase().replaceAll("_", " ")
            : undefined,
        labelStyle: { fill: "#c8d9ee", fontSize: 10 },
        labelBgStyle: { fill: "#0b1528", fillOpacity: 0.95 },
        labelBgPadding: [8, 5] as [number, number],
        labelBgBorderRadius: 5,
        style: {
          ...edge.style,
          stroke: highlighted ? "#b2d7ff" : edge.style?.stroke,
          strokeWidth: highlighted ? 1.7 : 1,
          strokeOpacity: focus && !highlighted ? 0.08 : highlighted ? 0.9 : 0.38,
        },
      };
    });
  return (
    <div
      ref={canvas}
      className="studio-network-canvas"
      data-testid="network-canvas"
      onKeyDownCapture={(event) => {
        if (!["Enter", " "].includes(event.key)) return;
        const element = (event.target as HTMLElement).closest(
          ".react-flow__node, .react-flow__edge",
        );
        const id = element?.getAttribute("data-id");
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        if (element?.classList.contains("react-flow__node")) inspect(null, id);
        else {
          const edge = graph.edges.find((edge) => edge.id === id);
          if (edge) inspect(id, edge.source_node_id);
        }
      }}
    >
      <div className="studio-graph-toolbar">
        <label className="studio-graph-search">
          <Search size={15} />
          <input
            aria-label="Find a network node"
            placeholder="Find in this network…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button aria-label="Clear node search" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </label>
        <label className="studio-graph-filter">
          <SlidersHorizontal size={14} />
          <select
            aria-label="Node type"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All Entities</option>
            {[...new Set(graph.nodes.map((node) => node.kind))]
              .filter((kind) => kind !== "product")
              .map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabels[kind]}
                </option>
              ))}
          </select>
        </label>
        <button
          className={`studio-neighbors ${neighborsOnly ? "is-active" : ""}`}
          aria-label="Show selected node and neighbors only"
          aria-pressed={neighborsOnly}
          disabled={!selectedNode}
          onClick={() => setNeighborsOnly(!neighborsOnly)}
          title="Focus on the selected node and its direct connections"
        >
          <GitBranch size={15} />
          <span>Local View</span>
        </button>
      </div>
      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => inspect(null, node.id)}
        onEdgeClick={(_, edge) => inspect(edge.id, edge.source)}
        onPaneClick={() => inspect(null)}
        onNodeMouseEnter={(_, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.38, maxZoom: 1.3 }}
        minZoom={0.15}
        maxZoom={2.5}
        defaultEdgeOptions={{ focusable: true }}
        colorMode="dark"
        aria-label="Supply chain network"
      ></ReactFlow>
      {search && matches.size === 0 && (
        <div className="studio-graph-message" role="status">
          No entities match “{query}”.<button onClick={() => setQuery("")}>Clear Search</button>
        </div>
      )}
      {graph.edges.length === 0 && !search && (
        <div className="studio-graph-message">
          No verified connections yet.
          <span>New findings will appear here as sources are verified.</span>
        </div>
      )}
      <div className="studio-graph-legend">
        {[...new Set(graph.nodes.map((node) => node.kind))].map((kind) => (
          <span key={kind}>
            <i style={{ background: nodeColors[kind] }} />
            {kindLabels[kind]}
          </span>
        ))}
      </div>
      <div className="studio-graph-controls">
        <button aria-label="Zoom in" onClick={() => zoomIn({ duration: reduced ? 0 : 200 })}>
          <Plus size={17} />
        </button>
        <button aria-label="Zoom out" onClick={() => zoomOut({ duration: reduced ? 0 : 200 })}>
          <Minus size={17} />
        </button>
        <span />
        <button
          aria-label="Fit network to view"
          onClick={() => fitView({ padding: 0.38, maxZoom: 1.3, duration: reduced ? 0 : 350 })}
        >
          <Focus size={17} />
        </button>
      </div>
      <div className="studio-graph-hint">
        <MousePointer2 size={12} />
        <span>Drag to explore · Select a node to look closer</span>
      </div>
    </div>
  );
}
