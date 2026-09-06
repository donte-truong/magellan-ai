import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { buildPhone, disposeScene } from "@/lib/scenes/phone";
import { phoneAssemblyOffset, PHONE_DEPTH_PHASE } from "@/lib/scenes/phone-motion";
import type { PartId } from "@/lib/demo-data";

const depthOrder: PartId[] = [
  "display",
  "silicon",
  "battery",
  "connectivity",
  "enclosure",
  "camera",
];
let phone: ReturnType<typeof buildPhone>;

function solidMeshes(group: THREE.Object3D) {
  return group.children.filter(
    (object): object is THREE.Mesh =>
      object instanceof THREE.Mesh &&
      !Array.isArray(object.material) &&
      !object.material.transparent,
  );
}

function bounds(group: THREE.Object3D) {
  const result = new THREE.Box3();
  for (const mesh of solidMeshes(group)) result.union(new THREE.Box3().setFromObject(mesh, true));
  return result;
}

beforeEach(() => {
  // Textures do not affect the actual solid geometry being checked here.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillText() {},
    beginPath() {},
    moveTo() {},
    bezierCurveTo() {},
    fill() {},
    ellipse() {},
  } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  phone = buildPhone();
  phone.root.updateMatrixWorld(true);
});

afterEach(() => disposeScene(phone.root));

describe("phone assembly clearances", () => {
  it("fits the internals between the rear panel and screen inside an open frame", () => {
    const panel = new THREE.Box3().setFromObject(
      phone.root.getObjectByName("phone-back-panel")!,
      true,
    );
    const screen = bounds(phone.groups.display);
    for (const id of ["battery", "silicon", "connectivity"] as const) {
      const internal = bounds(phone.groups[id]);
      expect(internal.max.z).toBeLessThan(panel.min.z);
      expect(internal.min.z).toBeGreaterThan(screen.max.z);
    }
    const frame = phone.root.getObjectByName("phone-frame")!;
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, -0.05), new THREE.Vector3(1, 0, 0));
    const [innerWall] = ray.intersectObject(frame);
    expect(innerWall.distance).toBeGreaterThan(1);
    expect(innerWall.distance).toBeLessThan(1.15);
  });

  it("keeps the battery, logic board and charging hardware from intersecting when assembled", () => {
    const ids = ["battery", "silicon", "connectivity"] as const;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (const a of solidMeshes(phone.groups[ids[i]])) {
          for (const b of solidMeshes(phone.groups[ids[j]])) {
            expect(
              new THREE.Box3()
                .setFromObject(a, true)
                .intersectsBox(new THREE.Box3().setFromObject(b, true)),
              `${ids[i]} intersects ${ids[j]}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("separates only in depth first, and closes depth only after lateral reassembly", () => {
    for (const progress of [0, 0.1, 0.2, PHONE_DEPTH_PHASE, 0.2, 0.1, 0]) {
      for (const id of depthOrder) {
        const offset = phoneAssemblyOffset(id, progress, new THREE.Vector3());
        expect(Math.abs(offset.x)).toBe(0);
        expect(Math.abs(offset.y)).toBe(0);
        if (progress === 0) expect(Math.abs(offset.z)).toBe(0);
      }
    }
  });

  it("maintains separated depth lanes throughout lateral travel, including selection lift", () => {
    for (let step = 0; step <= 40; step++) {
      const progress = PHONE_DEPTH_PHASE + ((1 - PHONE_DEPTH_PHASE) * step) / 40;
      for (const id of depthOrder) phoneAssemblyOffset(id, progress, phone.groups[id].position);
      phone.root.updateMatrixWorld(true);
      const lanes = depthOrder.map((id) => bounds(phone.groups[id]));
      for (let i = 1; i < lanes.length; i++) {
        expect(
          lanes[i].min.z - lanes[i - 1].max.z,
          `${depthOrder[i - 1]} → ${depthOrder[i]} at ${progress}`,
        ).toBeGreaterThan(0.1);
      }
    }
  });
});
