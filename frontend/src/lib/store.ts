import { create } from "zustand";
import type { BOM, Graph, Run } from "./types";

export type Stage = "input" | "bom" | "network";
interface WorkspaceState {
  stage: Stage;
  run: Run | null;
  graph: Graph | null;
  scenario: Graph | null;
  bom: BOM | null;
  selectedEdge: string | null;
  selectedNode: string | null;
  generation: number;
  agentBusy: boolean;
  begin: (run: Run) => void;
  continueRun: (run: Run) => void;
  viewScenario: (graph: Graph | null) => void;
  update: (generation: number, run: Run, graph: Graph, bom: BOM) => void;
  setStage: (stage: Stage) => void;
  inspect: (edge: string | null, node?: string | null) => void;
  reset: () => void;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  stage: "input",
  run: null,
  graph: null,
  scenario: null,
  bom: null,
  selectedEdge: null,
  selectedNode: null,
  generation: 0,
  agentBusy: false,
  begin: (run) =>
    set((state) => ({
      run,
      graph: null,
      scenario: null,
      agentBusy: false,
      bom: null,
      stage: "network",
      selectedEdge: null,
      selectedNode: null,
      generation: state.generation + 1,
    })),
  continueRun: (run) =>
    set((state) => {
      const current = state.scenario ?? state.graph;
      return {
        run,
        graph: current?.id === run.graph_id ? current : null,
        scenario: null,
        bom: null,
        stage: "network",
        generation: state.generation + 1,
      };
    }),
  viewScenario: (scenario) =>
    set({ scenario, stage: "network", selectedEdge: null, selectedNode: null }),
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
      agentBusy: false,
      run: null,
      graph: null,
      scenario: null,
      bom: null,
      selectedEdge: null,
      selectedNode: null,
      generation: state.generation + 1,
    })),
}));

export const visibleGraph = (state: Pick<WorkspaceState, "scenario" | "graph">) =>
  state.scenario ?? state.graph;
