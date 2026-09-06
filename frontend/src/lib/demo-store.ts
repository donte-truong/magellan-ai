import { create } from "zustand";
import { suppliers as curatedSuppliers, type PartId, type Supplier } from "./demo-data";
import type { DemoGraphSummary, DemoSite } from "./demo-graph";

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
  setView: (view: "globe" | "graph") => void;
  selectGraphNode: (node: string | null) => void;
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
  setView: (view) => set({ view }),
  selectGraphNode: (graphNode) => set({ graphNode }),
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
