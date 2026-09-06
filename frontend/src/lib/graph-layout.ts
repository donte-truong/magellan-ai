import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { Graph, NodeKind, SupportLabel } from "./types";

export const nodeColors: Record<NodeKind, string> = {
  product: "#d3e9ff",
  component: "#89bfff",
  material: "#a69bea",
  organization: "#6fd9c9",
  facility: "#e1bb82",
  geography: "#88bfc8",
};
export const kindLabels: Record<NodeKind, string> = {
  product: "Products",
  component: "Components",
  material: "Materials",
  organization: "Companies",
  facility: "Facilities",
  geography: "Locations",
};
export type SupplyNodeData = {
  label: string;
  kind: NodeKind;
  support: SupportLabel;
  country?: string;
  tier: number | null;
  connections: number;
};
export type SupplyNode = Node<SupplyNodeData, "supply">;

/** Deterministic spring layout. It changes positions, never the graph's evidence or directions. */
export function layoutGraph(graph: Graph): { nodes: SupplyNode[]; edges: Edge[] } {
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const points = graph.nodes.map((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = node.id === graph.root_node_id ? 0 : 130 * Math.sqrt(index + 1);
    return { id: node.id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
  });
  const byId = new Map(points.map((point) => [point.id, point]));
  const links = graph.edges.flatMap((edge) => {
    const source = byId.get(edge.source_node_id),
      target = byId.get(edge.target_node_id);
    if (!source || !target) return [];
    degree.set(source.id, (degree.get(source.id) ?? 0) + 1);
    degree.set(target.id, (degree.get(target.id) ?? 0) + 1);
    return [{ source, target }];
  });
  for (let step = 0; step < 260; step++) {
    const cooling = 1 - step / 290;
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i],
          b = points[j];
        const dx = a.x - b.x || 0.01,
          dy = a.y - b.y || 0.01;
        const distance = Math.max(20, Math.hypot(dx, dy));
        const force =
          Math.min(9, 1100 / distance ** 2 + (distance < 145 ? (145 - distance) * 0.032 : 0)) *
          cooling;
        a.vx += (dx / distance) * force;
        a.vy += (dy / distance) * force;
        b.vx -= (dx / distance) * force;
        b.vy -= (dy / distance) * force;
      }
    for (const { source: a, target: b } of links) {
      const dx = b.x - a.x,
        dy = b.y - a.y,
        distance = Math.max(1, Math.hypot(dx, dy));
      const length =
        175 + Math.min(100, Math.max(degree.get(a.id) ?? 0, degree.get(b.id) ?? 0) * 8);
      const force = (distance - length) * 0.018 * cooling;
      a.vx += (dx / distance) * force;
      a.vy += (dy / distance) * force;
      b.vx -= (dx / distance) * force;
      b.vy -= (dy / distance) * force;
    }
    for (const point of points) {
      if (point.id === graph.root_node_id) {
        point.x = 0;
        point.y = 0;
        point.vx = 0;
        point.vy = 0;
        continue;
      }
      point.vx = (point.vx - point.x * 0.0006) * 0.78;
      point.vy = (point.vy - point.y * 0.0006) * 0.78;
      point.x += point.vx;
      point.y += point.vy;
    }
  }
  return {
    nodes: graph.nodes.map((node) => {
      const point = byId.get(node.id)!;
      const size = node.kind === "product" ? 40 : 24;
      return {
        id: node.id,
        type: "supply",
        width: size,
        height: size,
        ariaLabel: `${node.label}, ${node.kind}. Press Enter to inspect details.`,
        position: { x: point.x - size / 2, y: point.y - size / 2 },
        data: {
          label: node.label,
          kind: node.kind,
          support: node.status,
          tier: node.tier,
          country: node.data.geography?.country_iso2,
          connections: degree.get(node.id) ?? 0,
        },
      };
    }),
    edges: graph.edges
      .filter((edge) => byId.has(edge.source_node_id) && byId.has(edge.target_node_id))
      .map((edge) => ({
        id: edge.id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        type: "straight",
        ariaLabel: `${byId.has(edge.source_node_id) ? graph.nodes.find((node) => node.id === edge.source_node_id)!.label : "Entity"} ${edge.predicate.toLowerCase().replaceAll("_", " ")} ${graph.nodes.find((node) => node.id === edge.target_node_id)!.label}. Inspect evidence.`,
        style: {
          stroke: edge.support_label === "disputed" ? "#dc9c99" : "#7193b6",
          strokeWidth: 1,
          strokeOpacity: 0.44,
          strokeDasharray: edge.support_label === "directly_supported" ? undefined : "4 5",
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#7193b6", width: 12, height: 12 },
        interactionWidth: 22,
      })),
  };
}
