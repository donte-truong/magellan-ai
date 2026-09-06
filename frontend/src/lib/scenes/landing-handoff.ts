import type { PartId } from "../demo-data";

export interface HandoffPoint {
  x: number;
  y: number;
}
export interface HandoffSource extends HandoffPoint {
  part: PartId;
  width: number;
  height: number;
  image: HTMLCanvasElement;
}
export interface HandoffTarget extends HandoffPoint {
  id: string;
  visible: boolean;
}
export type HandoffPhase = "idle" | "preparing" | "playing" | "complete";

// Scenes exchange CSS-pixel measurements and intact assembly snapshots.
// The flight clock is independent of scrolling once the threshold is crossed.
export interface LandingHandoff {
  progress: number;
  phase: HandoffPhase;
  pastThreshold: boolean;
  enabled: boolean;
  reduced: boolean;
  sourceHost: HTMLElement | null;
  targetHost: HTMLElement | null;
  sources: HandoffSource[];
  targets: HandoffTarget[];
}
export const HANDOFF_DURATION = 4400;
export function componentDotFrame(progress: number, index: number) {
  const delay = index * 0.02;
  return {
    morph: smoothProgress(progress, delay, 0.16 + delay),
    flight: smoothProgress(progress, 0.18 + delay, 0.9 + delay),
  };
}
export function createLandingHandoff(): LandingHandoff {
  return {
    progress: 0,
    phase: "idle",
    pastThreshold: false,
    enabled: false,
    reduced: false,
    sourceHost: null,
    targetHost: null,
    sources: [],
    targets: [],
  };
}
export function smoothProgress(value: number, start = 0, end = 1) {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function handoffPosition(
  source: HandoffPoint,
  target: HandoffPoint,
  progress: number,
  bend: number,
): HandoffPoint {
  const t = Math.max(0, Math.min(1, progress)),
    u = 1 - t;
  const distance = target.y - source.y;
  return {
    x:
      u * u * u * source.x +
      3 * u * u * t * (source.x + bend) +
      3 * u * t * t * (target.x + bend) +
      t * t * t * target.x,
    y:
      u * u * u * source.y +
      3 * u * u * t * (source.y + distance * 0.35) +
      3 * u * t * t * (target.y - distance * 0.3) +
      t * t * t * target.y,
  };
}
