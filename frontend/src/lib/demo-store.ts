import { create } from "zustand";
import type { PartId } from "./demo-data";

export type DemoStage = "input" | "bom" | "network";
export const useDemo = create<{
  stage: DemoStage;
  started: boolean;
  part: PartId;
  supplier: string | null;
  exploded: boolean;
  paused: boolean;
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
    }),
}));
