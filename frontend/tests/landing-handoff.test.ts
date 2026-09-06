import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { PartId } from "@/lib/demo-data";
import { componentDotFrame, handoffPosition, smoothProgress } from "@/lib/scenes/landing-handoff";
import { capturePhoneAssemblies } from "@/lib/scenes/phone-snapshots";

describe("landing component handoff", () => {
  it("finishes turning every assembly into one dot before that dot leaves", () => {
    for (let index = 0; index < 6; index++) {
      expect(componentDotFrame(0, index)).toEqual({ morph: 0, flight: 0 });
      expect(componentDotFrame(1, index)).toEqual({ morph: 1, flight: 1 });
      for (let frame = 0; frame <= 100; frame++) {
        const { morph, flight } = componentDotFrame(frame / 100, index);
        if (flight > 0) expect(morph).toBe(1);
      }
    }
  });

  it("preserves exact endpoints and the path when translating between page and viewport coordinates", () => {
    const source = { x: 912.25, y: 348.5 };
    const target = { x: 467.75, y: 1864.25 };
    const offset = { x: -184.5, y: -1200 };
    const movedSource = { x: source.x + offset.x, y: source.y + offset.y };
    const movedTarget = { x: target.x + offset.x, y: target.y + offset.y };

    for (const [start, end] of [
      [source, target],
      [movedSource, movedTarget],
    ]) {
      for (const progress of [-10, 0]) {
        expect(handoffPosition(start, end, progress, 130)).toEqual(start);
      }
      for (const progress of [1, 10]) {
        expect(handoffPosition(start, end, progress, 130)).toEqual(end);
      }
    }
    for (const progress of [0.15, 0.5, 0.85]) {
      const original = handoffPosition(source, target, progress, 130);
      const translated = handoffPosition(movedSource, movedTarget, progress, 130);
      expect(translated.x).toBeCloseTo(original.x + offset.x, 8);
      expect(translated.y).toBeCloseTo(original.y + offset.y, 8);
    }
  });

  it("retraces the same positions when scrolling backward or jumping between sections", () => {
    const source = Object.freeze({ x: 620, y: 280 });
    const target = Object.freeze({ x: 380, y: 1520 });
    const checkpoints = [0, 0.08, 0.3, 0.57, 0.82, 1];
    const forward = checkpoints.map((progress) =>
      handoffPosition(source, target, smoothProgress(progress), -95),
    );

    for (const index of [5, 4, 3, 2, 1, 0, 4, 1, 5, 2, 0]) {
      expect(handoffPosition(source, target, smoothProgress(checkpoints[index]), -95)).toEqual(
        forward[index],
      );
    }
  });

  it("moves continuously downward without overshooting across mobile and desktop scales", () => {
    expect(smoothProgress(-2)).toBe(0);
    expect(smoothProgress(3)).toBe(1);

    for (const scale of [0.25, 0.65, 1, 2, 4]) {
      const source = { x: 730 * scale, y: -180 * scale };
      const target = { x: 240 * scale, y: 1950 * scale };
      for (const bend of [-220 * scale, 0, 220 * scale]) {
        let previousY = source.y;
        for (let step = 0; step <= 100; step++) {
          const position = handoffPosition(source, target, smoothProgress(step / 100), bend);
          expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
          expect(position.y).toBeGreaterThanOrEqual(previousY);
          expect(position.y).toBeLessThanOrEqual(target.y);
          previousY = position.y;
        }
      }
    }
  });

  it("captures intact assemblies and restores their visibility and geometry", () => {
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: vi.fn() } as unknown as ReturnType<
        HTMLCanvasElement["getContext"]
      >);
    const geometry = new THREE.BoxGeometry(0.2, 0.4, 0.1);
    const material = new THREE.MeshBasicMaterial();
    const ids: PartId[] = ["display", "silicon", "camera", "battery", "enclosure", "connectivity"];
    const groups = Object.fromEntries(
      ids.map((id, i) => {
        const group = new THREE.Group();
        group.position.x = (i - 2.5) * 0.3;
        group.add(new THREE.Mesh(geometry, material));
        return [id, group];
      }),
    ) as Record<PartId, THREE.Group>;
    const scene = new THREE.Scene();
    scene.add(...Object.values(groups));
    const camera = new THREE.PerspectiveCamera(40, 2, 0.1, 100);
    camera.position.z = 4;
    const frames: number[] = [];
    const renderer = {
      getPixelRatio: () => 1.5,
      domElement: document.createElement("canvas"),
      render: () => frames.push(Object.values(groups).filter((g) => g.visible).length),
    } as unknown as THREE.WebGLRenderer;
    const sources = capturePhoneAssemblies(groups, scene, camera, renderer, 800, 400);
    expect(sources.map((s) => s.part)).toEqual(ids);
    expect(frames).toEqual([1, 1, 1, 1, 1, 1, 6]);
    for (const source of sources) {
      expect(source.height).toBeGreaterThan(source.width);
      expect(source.image.width).toBe(Math.ceil(source.width * 1.5));
      expect(source.image.height).toBe(Math.ceil(source.height * 1.5));
      expect(groups[source.part].scale.toArray()).toEqual([1, 1, 1]);
      expect(groups[source.part].children).toHaveLength(1);
    }
    geometry.dispose();
    material.dispose();
    context.mockRestore();
  });
});
