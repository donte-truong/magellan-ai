import * as THREE from "three";
import type { PartId } from "../demo-data";
import type { HandoffSource } from "./landing-handoff";

// Capture each real assembly in the same camera and lighting as the hero.
// Six transparent sprites preserve every component's silhouette and detail.
export function capturePhoneAssemblies(
  groups: Record<PartId, THREE.Group>,
  scene: THREE.Scene,
  camera: THREE.Camera,
  renderer: THREE.WebGLRenderer,
  width: number,
  height: number,
): HandoffSource[] {
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  const entries = Object.entries(groups) as [PartId, THREE.Group][];
  const originalVisibility = entries.map(([, group]) => group.visible);
  const projected = new THREE.Vector3();
  const ratio = renderer.getPixelRatio();
  const sources: HandoffSource[] = [];
  try {
    for (const [part, group] of entries) {
      const bounds = new THREE.Box3().setFromObject(group);
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            projected.set(x, y, z).project(camera);
            const px = (projected.x * 0.5 + 0.5) * width,
              py = (-projected.y * 0.5 + 0.5) * height;
            left = Math.min(left, px);
            right = Math.max(right, px);
            top = Math.min(top, py);
            bottom = Math.max(bottom, py);
          }
      left = Math.max(0, Math.floor(left - 5));
      top = Math.max(0, Math.floor(top - 5));
      right = Math.min(width, Math.ceil(right + 5));
      bottom = Math.min(height, Math.ceil(bottom + 5));
      if (right <= left || bottom <= top) continue;
      const image = document.createElement("canvas");
      image.width = Math.ceil((right - left) * ratio);
      image.height = Math.ceil((bottom - top) * ratio);
      const context = image.getContext("2d");
      if (!context) continue;
      for (const [, assembly] of entries) assembly.visible = assembly === group;
      renderer.render(scene, camera);
      context.drawImage(
        renderer.domElement,
        left * ratio,
        top * ratio,
        (right - left) * ratio,
        (bottom - top) * ratio,
        0,
        0,
        image.width,
        image.height,
      );
      sources.push({
        part,
        x: (left + right) / 2,
        y: (top + bottom) / 2,
        width: right - left,
        height: bottom - top,
        image,
      });
    }
  } finally {
    entries.forEach(([, group], index) => {
      group.visible = originalVisibility[index];
    });
    renderer.render(scene, camera);
  }
  return sources;
}
