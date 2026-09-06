"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import {
  Box,
  Check,
  Factory,
  Focus,
  Globe2,
  Layers3,
  Minus,
  MousePointer2,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { layoutGraph, type SupplyNode } from "@/lib/graph-layout";
import type { Graph } from "@/lib/types";

const kindIcons = {
  product: Box,
  component: Layers3,
  material: Globe2,
  organization: Factory,
  facility: Factory,
  geography: Globe2,
};
function SupplyCard({ data, selected }: NodeProps<SupplyNode>) {
  const Icon = kindIcons[data.kind];
  return (
    <div className={`supply-node kind-${data.kind} ${selected ? "is-selected" : ""}`}>
      <Handle type="source" position={Position.Left} isConnectable={false} />
      <div className="supply-node-top">
        <span className="supply-node-icon">
          <Icon size={17} />
        </span>
        <span>{data.kind}</span>
        {data.support === "directly_supported" && (
          <span className="node-verified" title="Source supported">
            <Check size={12} />
          </span>
        )}
      </div>
      <strong>{data.label}</strong>
      <div className="supply-node-bottom">
        <span>
          {data.kind === "product"
            ? "STARTING POINT"
            : data.tier === null
              ? "CONTEXT"
              : `TIER ${data.tier}`}
        </span>
        {data.country && (
          <span>
            <Globe2 size={10} />
            {data.country}
          </span>
        )}
      </div>
      <Handle type="target" position={Position.Right} isConnectable={false} />
    </div>
  );
}
const nodeTypes = { supply: SupplyCard };

export function NetworkView() {
  const graph = useWorkspace((state) => state.graph);
  if (!graph) return null;
  return (
    <section className="network-view" aria-labelledby="network-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">02 / THE CONNECTIONS BETWEEN</span>
          <h2 id="network-title">The supply network</h2>
          <p>One product. Connected parts. Evidence you can follow.</p>
        </div>
        <span className="canvas-count">
          {graph.nodes.length} nodes <span>·</span> {graph.edges.length} connections
        </span>
      </div>
      <ReactFlowProvider>
        <NetworkCanvas key={`${graph.id}:${graph.revision}`} graph={graph} />
      </ReactFlowProvider>
      <div className="network-explainer">
        <span>
          <MousePointer2 size={14} />
          Select a node or connection to inspect its evidence.
        </span>
        <span>Arrows follow inputs toward their destination.</span>
      </div>
    </section>
  );
}

function NetworkCanvas({ graph }: { graph: Graph }) {
  const flow = useMemo(() => layoutGraph(graph), [graph]);
  const [nodes, , onNodesChange] = useNodesState<SupplyNode>(flow.nodes);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const selectedNode = useWorkspace((state) => state.selectedNode);
  const selectedEdge = useWorkspace((state) => state.selectedEdge);
  const inspect = useWorkspace((state) => state.inspect);
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canvas.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void fitView({ padding: 0.35, maxZoom: 1.05 });
      });
    });
    observer.observe(canvas.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fitView]);

  function inspectNode(id: string) {
    const edge = graph.edges.find((edge) => edge.source_node_id === id);
    inspect(edge?.id ?? null, id);
  }
  const visibleIds = new Set(
    nodes
      .filter(
        (node) =>
          (filter === "all" || node.data.kind === filter || node.id === graph.root_node_id) &&
          (!query ||
            node.data.label.toLowerCase().includes(query.toLowerCase()) ||
            node.id === graph.root_node_id),
      )
      .map((node) => node.id),
  );
  const visibleNodes = nodes
    .filter((node) => visibleIds.has(node.id))
    .map((node) => ({ ...node, selected: node.id === selectedNode }));
  const visibleEdges = flow.edges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      selected: edge.id === selectedEdge,
      style: { ...edge.style, strokeWidth: edge.id === selectedEdge ? 3 : 1.6 },
    }));

  return (
    <div
      ref={canvas}
      className="network-canvas"
      data-testid="network-canvas"
      onKeyDownCapture={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const element = (event.target as HTMLElement).closest(
          ".react-flow__node, .react-flow__edge",
        );
        const id = element?.getAttribute("data-id");
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        if (element?.classList.contains("react-flow__node")) inspectNode(id);
        else {
          const edge = graph.edges.find((edge) => edge.id === id);
          if (edge) inspect(edge.id, edge.source_node_id);
        }
      }}
    >
      <div className="canvas-toolbar">
        <label className="canvas-search">
          <Search size={15} />
          <input
            aria-label="Find a network node"
            placeholder="Find a node…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="canvas-filter">
          <SlidersHorizontal size={14} />
          <span className="sr-only">Node type</span>
          <select
            aria-label="Node type"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All types</option>
            {[...new Set(graph.nodes.map((node) => node.kind))]
              .filter((kind) => kind !== "product")
              .map((kind) => (
                <option value={kind} key={kind}>
                  {kind.charAt(0).toUpperCase() + kind.slice(1)}s
                </option>
              ))}
          </select>
        </label>
        <span className="canvas-live-label">
          <span className="status-dot" />
          EVIDENCE GRAPH
        </span>
      </div>
      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => inspectNode(node.id)}
        onEdgeClick={(_, edge) => inspect(edge.id, edge.source)}
        onPaneClick={() => inspect(null)}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.35, maxZoom: 1.05 }}
        minZoom={0.2}
        maxZoom={1.8}
        defaultEdgeOptions={{ focusable: true }}
        colorMode="light"
        aria-label="Supply chain network"
      >
        <Background variant={BackgroundVariant.Dots} gap={23} size={1} color="#d7e1d8" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) =>
            node.data.kind === "product"
              ? "#254b3d"
              : node.data.kind === "material"
                ? "#b69a60"
                : "#8baa96"
          }
          maskColor="rgba(235, 241, 234, 0.75)"
        />
      </ReactFlow>
      <div className="canvas-controls">
        <button aria-label="Zoom in" onClick={() => zoomIn()}>
          <Plus size={18} />
        </button>
        <button aria-label="Zoom out" onClick={() => zoomOut()}>
          <Minus size={18} />
        </button>
        <span />
        <button
          aria-label="Fit network to view"
          onClick={() => fitView({ padding: 0.35, maxZoom: 1.05, duration: 200 })}
        >
          <Focus size={18} />
        </button>
      </div>
      <div className="graph-legend">
        <span>
          <i className="legend-product" />
          Product
        </span>
        <span>
          <i className="legend-component" />
          Component
        </span>
        <span>
          <i className="legend-material" />
          Material
        </span>
        <span className="legend-separator" />
        <span>
          <i className="legend-line" />
          Sourced
        </span>
        <span>
          <i className="legend-dashed" />
          Inferred / provided
        </span>
      </div>
      {graph.edges.length === 0 && (
        <div className="canvas-empty-note">
          No verified connections yet. The product remains a starting point for research.
        </div>
      )}
    </div>
  );
}
