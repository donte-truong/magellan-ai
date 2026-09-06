import { MathUtils, Vector3 } from "three";
import type { PartId } from "../demo-data";

export const PHONE_DEPTH_PHASE = 0.35;

// Back-facing camera → housing → coil → battery → board → front display.
// Keep these depth lanes separated while parts travel across the phone.
const offsets: Record<PartId, readonly [number, number, number]> = {
  camera: [-0.4, 1.05, 0.85],
  enclosure: [-2.4, -0.22, 0.68],
  connectivity: [1.15, -0.8, 0.25],
  battery: [-0.4, -0.05, 0.04],
  silicon: [0.95, 0.25, -0.28],
  display: [3.5, 0.25, -0.55],
};

export function phoneAssemblyOffset(id: PartId, progress: number, target: Vector3) {
  const depth = MathUtils.smootherstep(progress, 0, PHONE_DEPTH_PHASE);
  const spread = MathUtils.smootherstep(progress, PHONE_DEPTH_PHASE, 1);
  const [x, y, z] = offsets[id];
  return target.set(x * spread, y * spread, z * depth);
}
