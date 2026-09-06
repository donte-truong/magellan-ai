import { create } from "zustand";
import { suppliers as curatedSuppliers, type PartId, type Supplier } from "./demo-data";
import type { DemoGraphSummary, DemoSite } from "./demo-graph";
import type { Graph } from "./types";

export type DemoStage = "input" | "bom" | "network";
export const useDemo = create<{
  stage: DemoStage;
  started: boolean;
  part: PartId;
  supplier: string | null;
  exploded: boolean;
  paused: boolean;
  /** Pins on the globe: the curated placeholder until the generated graph loads. */
  suppliers: (Supplier | DemoSite)[];
  summary: DemoGraphSummary | null;
  graphState: "placeholder" | "loading" | "generated" | "unavailable";
  /** The network stage shows the globe or the graph (Obsidian-style) view. */
  view: "globe" | "graph";
  /** A graph node picked in the graph view; mirrors the pin when the node is a located site. */
  graphNode: string | null;
  /** The full export shown in the graph view; replaced after live research or a scenario edit. */
  fullGraph: Graph | null;
  /** The base graph's id on the local backend, from the export's index; null when unknown. */
  liveGraphId: string | null;
  /** An active scenario (a fork of the base graph) whose id the views currently show. */
  scenarioId: string | null;
  /** A live request in flight, with a short status for the panel. */
  busy: string | null;
  setView: (view: "globe" | "graph") => void;
  selectGraphNode: (node: string | null) => void;
  setFullGraph: (graph: Graph | null) => void;
  setLive: (liveGraphId: string | null, scenarioId: string | null) => void;
  setBusy: (busy: string | null) => void;
  setGraph: (suppliers: DemoSite[], summary: DemoGraphSummary) => void;
  setGraphState: (graphState: "placeholder" | "loading" | "generated" | "unavailable") => void;
  setStage: (stage: DemoStage) => void;
  selectPart: (part: PartId) => void;
  selectSupplier: (supplier: string | null) => void;
  toggleExploded: () => void;
  togglePaused: () => void;
  reset: () => void;
}>((set) => ({
  stage: "input",
  started: false,
  part: "silicon",
  supplier: null,
  exploded: true,
  paused: false,
  suppliers: curatedSuppliers,
  summary: null,
  graphState: "placeholder",
  view: "globe",
  graphNode: null,
  fullGraph: null,
  liveGraphId: null,
  scenarioId: null,
  busy: null,
  setView: (view) => set({ view }),
  selectGraphNode: (graphNode) => set({ graphNode }),
  setFullGraph: (fullGraph) => set({ fullGraph }),
  setLive: (liveGraphId, scenarioId) => set({ liveGraphId, scenarioId }),
  setBusy: (busy) => set({ busy }),
  setGraph: (suppliers, summary) => set({ suppliers, summary, graphState: "generated" }),
  setGraphState: (graphState) => set({ graphState }),
  setStage: (stage) => set((s) => ({ stage, started: s.started || stage !== "input" })),
  selectPart: (part) => set({ part }),
  selectSupplier: (supplier) => set({ supplier }),
  toggleExploded: () => set((s) => ({ exploded: !s.exploded })),
  togglePaused: () => set((s) => ({ paused: !s.paused })),
  reset: () =>
    set({
      stage: "input",
      started: false,
      part: "silicon",
      supplier: null,
      exploded: true,
      paused: false,
      view: "globe",
      graphNode: null,
    }),
}));
