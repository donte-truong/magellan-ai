import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { PartId } from "../demo-data";

function labelTexture(text: string, small = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c0cada";
  ctx.textAlign = "center";
  ctx.font = `${small ? 32 : 98}px Arial`;
  ctx.fillText(text, 256, 280);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function roundedOutline<T extends THREE.Path>(path: T, w: number, h: number, r: number): T {
  const left = -w / 2,
    bottom = -h / 2;
  path.moveTo(left + r, bottom);
  path.lineTo(left + w - r, bottom);
  path.quadraticCurveTo(left + w, bottom, left + w, bottom + r);
  path.lineTo(left + w, bottom + h - r);
  path.quadraticCurveTo(left + w, bottom + h, left + w - r, bottom + h);
  path.lineTo(left + r, bottom + h);
  path.quadraticCurveTo(left, bottom + h, left, bottom + h - r);
  path.lineTo(left, bottom + r);
  path.quadraticCurveTo(left, bottom, left + r, bottom);
  return path;
}

export function buildPhone() {
  const root = new THREE.Group();
  const groups = Object.fromEntries(
    (["display", "silicon", "camera", "battery", "enclosure", "connectivity"] as PartId[]).map(
      (id) => {
        const group = new THREE.Group();
        group.name = id;
        root.add(group);
        return [id, group];
      },
    ),
  ) as Record<PartId, THREE.Group>;
  const metal = new THREE.MeshStandardMaterial({
    color: "#354461",
    metalness: 0.92,
    roughness: 0.29,
  });
  const edgeMetal = new THREE.MeshStandardMaterial({
    color: "#7786a7",
    metalness: 0.96,
    roughness: 0.22,
  });
  const black = new THREE.MeshStandardMaterial({
    color: "#060b14",
    metalness: 0.45,
    roughness: 0.28,
  });
  const board = new THREE.MeshStandardMaterial({
    color: "#123937",
    metalness: 0.58,
    roughness: 0.48,
  });
  const gold = new THREE.MeshStandardMaterial({
    color: "#d4ae63",
    metalness: 0.85,
    roughness: 0.3,
  });

  function box(
    parent: THREE.Group,
    w: number,
    h: number,
    d: number,
    material: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    radius = 0.08,
  ) {
    let geometry: THREE.BufferGeometry;
    if (w > 1.9 && h > 1.2) {
      const shape = roundedOutline(new THREE.Shape(), w, h, h > 3 ? 0.22 : 0.17);
      geometry = new THREE.ExtrudeGeometry(shape, {
        depth: d,
        bevelEnabled: true,
        bevelThickness: 0.008,
        bevelSize: 0.008,
        bevelSegments: 2,
        steps: 1,
        curveSegments: 8,
      });
      geometry.translate(0, 0, -d / 2);
    } else geometry = new RoundedBoxGeometry(w, h, d, 3, Math.min(radius, d / 2));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  function cylinder(
    parent: THREE.Group,
    radius: number,
    depth: number,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, depth, 64), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  function label(
    parent: THREE.Group,
    text: string,
    size: number,
    x: number,
    y: number,
    z: number,
    small = false,
  ) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({
        map: labelTexture(text, small),
        transparent: true,
        depthWrite: false,
      }),
    );
    mesh.position.set(x, y, z);
    parent.add(mesh);
  }

  // A hollow perimeter holds the internals between a rear panel and front display.
  // A solid box here would intersect the battery, board and charging coil.
  const frameShape = roundedOutline(new THREE.Shape(), 2.28, 4.75, 0.22);
  frameShape.holes.push(roundedOutline(new THREE.Path(), 2.16, 4.63, 0.16));
  const frameGeometry = new THREE.ExtrudeGeometry(frameShape, {
    depth: 0.34,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 2,
    steps: 1,
    curveSegments: 10,
  });
  frameGeometry.translate(0, 0, -0.195);
  const frame = new THREE.Mesh(frameGeometry, edgeMetal);
  frame.name = "phone-frame";
  groups.enclosure.add(frame);
  const backPanel = box(groups.enclosure, 2.2, 4.67, 0.045, metal, 0, 0, 0.145);
  backPanel.name = "phone-back-panel";
  box(
    groups.enclosure,
    2.08,
    2.92,
    0.014,
    new THREE.MeshStandardMaterial({ color: "#18273f", roughness: 0.45, metalness: 0.46 }),
    0,
    -0.67,
    0.18,
  );
  box(groups.enclosure, 2.18, 1.43, 0.08, metal, 0, 1.58, 0.205);
  // A restrained embossed maker mark, drawn locally rather than loading external art.
  const markCanvas = document.createElement("canvas");
  markCanvas.width = markCanvas.height = 256;
  const mark = markCanvas.getContext("2d")!;
  mark.fillStyle = "#25334d";
  mark.beginPath();
  mark.moveTo(130, 94);
  mark.bezierCurveTo(70, 60, 61, 132, 99, 176);
  mark.bezierCurveTo(114, 194, 119, 176, 133, 181);
  mark.bezierCurveTo(158, 196, 174, 155, 177, 150);
  mark.bezierCurveTo(147, 137, 152, 113, 176, 99);
  mark.bezierCurveTo(153, 73, 141, 86, 130, 94);
  mark.fill();
  mark.beginPath();
  mark.ellipse(140, 68, 10, 21, 0.7, 0, Math.PI * 2);
  mark.fill();
  const markTexture = new THREE.CanvasTexture(markCanvas);
  markTexture.colorSpace = THREE.SRGBColorSpace;
  const markMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.8),
    new THREE.MeshBasicMaterial({ map: markTexture, transparent: true, depthWrite: false }),
  );
  markMesh.position.set(0, -0.52, 0.2);
  groups.enclosure.add(markMesh);
  for (const y of [0.73, 0.12]) box(groups.enclosure, 0.065, 0.39, 0.1, edgeMetal, -1.15, y, 0);
  box(groups.enclosure, 0.065, 0.6, 0.1, edgeMetal, 1.15, 0.56, 0);
  box(groups.enclosure, 0.37, 0.05, 0.11, black, 0, -2.37, 0);
  for (let i = 0; i < 7; i++) {
    box(groups.enclosure, 0.035, 0.015, 0.06, black, -0.72 + i * 0.075, -2.38, 0);
    box(groups.enclosure, 0.035, 0.015, 0.06, black, 0.29 + i * 0.075, -2.38, 0);
  }

  const lensGlass = new THREE.MeshPhysicalMaterial({
    color: "#0c1732",
    metalness: 0.65,
    roughness: 0.075,
    clearcoat: 1,
    iridescence: 1,
  });
  for (const [x, y] of [
    [-0.58, 1.94],
    [-0.58, 1.27],
    [0.14, 1.605],
  ]) {
    cylinder(groups.camera, 0.278, 0.11, edgeMetal, x, y, 0.305);
    cylinder(groups.camera, 0.249, 0.1, black, x, y, 0.314);
    cylinder(groups.camera, 0.208, 0.01, lensGlass, x, y, 0.371);
    cylinder(
      groups.camera,
      0.098,
      0.008,
      new THREE.MeshStandardMaterial({ color: "#153956", metalness: 1, roughness: 0.13 }),
      x,
      y,
      0.379,
    );
    cylinder(groups.camera, 0.049, 0.004, black, x, y, 0.384);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.169, 0.0055, 6, 64),
      new THREE.MeshBasicMaterial({ color: "#376688", transparent: true, opacity: 0.7 }),
    );
    ring.position.set(x, y, 0.38);
    groups.camera.add(ring);
    cylinder(
      groups.camera,
      0.02,
      0.004,
      new THREE.MeshBasicMaterial({ color: "#a0d4ff" }),
      x - 0.07,
      y + 0.09,
      0.384,
    );
  }
  cylinder(
    groups.camera,
    0.073,
    0.025,
    new THREE.MeshStandardMaterial({ color: "#e0d4bc", roughness: 0.25 }),
    0.78,
    1.94,
    0.275,
  );
  cylinder(groups.camera, 0.078, 0.027, black, 0.78, 1.27, 0.274);

  box(groups.display, 2.22, 4.65, 0.07, black, 0, 0, -0.245);
  const screen = new THREE.MeshStandardMaterial({
    color: "#243d67",
    emissive: "#143860",
    emissiveIntensity: 0.4,
    metalness: 0.7,
    roughness: 0.15,
  });
  box(groups.display, 2.11, 4.53, 0.016, screen, 0, 0, -0.298);
  box(groups.display, 0.63, 0.18, 0.012, black, 0, 2.01, -0.312);

  box(
    groups.battery,
    1.32,
    2.44,
    0.12,
    new THREE.MeshStandardMaterial({ color: "#252c37", metalness: 0.7, roughness: 0.5 }),
    -0.34,
    -0.62,
    -0.06,
  );
  for (let i = 0; i < 8; i++)
    box(groups.battery, 1.2, 0.006, 0.004, edgeMetal, -0.34, -1.61 + i * 0.27, 0.004);
  label(groups.battery, "Li-ion", 1.08, -0.34, -0.5, 0.009);
  label(groups.battery, "+    −", 0.8, -0.34, -1.26, 0.009, true);
  box(groups.battery, 0.1, 0.3, 0.025, gold, 0.18, 0.63, -0.03);

  box(groups.silicon, 0.66, 2.62, 0.09, board, 0.66, -0.02, -0.07);
  box(groups.silicon, 1.38, 0.63, 0.09, board, 0.27, 1.11, -0.07);
  box(
    groups.silicon,
    0.55,
    0.64,
    0.07,
    new THREE.MeshStandardMaterial({ color: "#3f465b", metalness: 0.9, roughness: 0.35 }),
    0.66,
    0.68,
    0.02,
  );
  label(groups.silicon, "A19", 0.54, 0.66, 0.69, 0.065);
  for (let i = 0; i < 18; i++) {
    const y = -0.96 + i * 0.105;
    box(
      groups.silicon,
      0.105,
      0.052,
      0.018,
      i % 3 ? gold : edgeMetal,
      0.49 + (i % 2) * 0.22,
      y,
      -0.005,
    );
    box(groups.silicon, 0.015, 0.06, 0.004, gold, 0.94, y, -0.016);
  }
  for (let i = 0; i < 4; i++)
    box(groups.silicon, 0.19, 0.21, 0.04, black, -0.24 + i * 0.3, 1.13, 0.005);

  box(groups.connectivity, 1.6, 0.27, 0.075, black, 0, -2.12, -0.03);
  label(groups.connectivity, "TAPTIC ENGINE", 1.3, 0, -2.12, 0.012, true);
  const coil = new THREE.Mesh(new THREE.TorusGeometry(0.59, 0.042, 8, 80), gold);
  coil.position.set(-0.1, -0.44, 0.065);
  groups.connectivity.add(coil);
  const coil2 = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.015, 8, 80), gold);
  coil2.position.copy(coil.position);
  groups.connectivity.add(coil2);

  return { root, groups };
}

export function disposeScene(scene: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Points ||
      object instanceof THREE.Line
    ) {
      geometries.add(object.geometry);
      (Array.isArray(object.material) ? object.material : [object.material]).forEach((m) =>
        materials.add(m),
      );
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => {
    for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
    m.dispose();
  });
}
