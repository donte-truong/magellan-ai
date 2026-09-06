import { create } from "zustand";
import type { BOM, Graph, Run } from "./types";

export type Stage = "input" | "bom" | "network";
interface WorkspaceState {
  stage: Stage;
  run: Run | null;
  graph: Graph | null;
  bom: BOM | null;
  selectedEdge: string | null;
  selectedNode: string | null;
  generation: number;
  begin: (run: Run) => void;
  update: (generation: number, run: Run, graph: Graph, bom: BOM) => void;
  setStage: (stage: Stage) => void;
  inspect: (edge: string | null, node?: string | null) => void;
  reset: () => void;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  stage: "input",
  run: null,
  graph: null,
  bom: null,
  selectedEdge: null,
  selectedNode: null,
  generation: 0,
  begin: (run) =>
    set((state) => ({
      run,
      graph: null,
      bom: null,
      stage: "bom",
      selectedEdge: null,
      selectedNode: null,
      generation: state.generation + 1,
    })),
  update: (generation, run, graph, bom) =>
    set((state) =>
      state.generation === generation && state.run?.id === run.id
        ? {
            run,
            graph:
              state.graph?.id === graph.id && state.graph.revision === graph.revision
                ? state.graph
                : graph,
            bom,
          }
        : state,
    ),
  setStage: (stage) => set({ stage, selectedEdge: null, selectedNode: null }),
  inspect: (selectedEdge, selectedNode = null) => set({ selectedEdge, selectedNode }),
  reset: () =>
    set((state) => ({
      stage: "input",
      run: null,
      graph: null,
      bom: null,
      selectedEdge: null,
      selectedNode: null,
      generation: state.generation + 1,
    })),
}));
