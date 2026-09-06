import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { Graph, NodeKind, SupportLabel } from "./types";

export type SupplyNodeData = {
  label: string;
  kind: NodeKind;
  support: SupportLabel;
  country?: string;
  tier: number | null;
};
export type SupplyNode = Node<SupplyNodeData, "supply">;

export function layoutGraph(graph: Graph): { nodes: SupplyNode[]; edges: Edge[] } {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: "LR", ranksep: 110, nodesep: 38, marginx: 36, marginy: 36 });
  graph.nodes.forEach((node) => layout.setNode(node.id, { width: 216, height: 100 }));
  // Arrange dependencies left-to-right from the product, but keep the API's edge direction.
  graph.edges.forEach((edge) => layout.setEdge(edge.target_node_id, edge.source_node_id));
  dagre.layout(layout);
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: "supply",
      ariaLabel: `${node.label}, ${node.kind}. Press Enter to inspect evidence.`,
      position: { x: layout.node(node.id).x - 108, y: layout.node(node.id).y - 50 },
      data: {
        label: node.label,
        kind: node.kind,
        support: node.status,
        tier: node.tier,
        country: node.data.geography?.country_iso2,
      },
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source_node_id,
      target: edge.target_node_id,
      type: "smoothstep",
      label: edge.predicate.toLowerCase().replaceAll("_", " "),
      style: {
        stroke:
          edge.support_label === "directly_supported"
            ? "#548476"
            : edge.support_label === "disputed"
              ? "#b7665a"
              : "#91a397",
        strokeWidth: 1.6,
        strokeDasharray: edge.support_label === "directly_supported" ? undefined : "5 5",
      },
      labelStyle: { fill: "#60736a", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "#f8faf7", fillOpacity: 0.95 },
      labelBgPadding: [7, 4],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#548476", width: 16, height: 16 },
      interactionWidth: 28,
    })),
  };
}
