"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildPhone, disposeScene } from "@/lib/scenes/phone";
import { useDemo } from "@/lib/demo-store";

export default function ProductScene() {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const container = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
    } catch {
      // WebGL availability is an external system result, known only after mounting.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0, 11);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.AmbientLight("#a6b9ef", 0.7));
    const key = new THREE.DirectionalLight("#dde8ff", 3);
    key.position.set(-3, 6, 7);
    scene.add(key);
    const rim = new THREE.DirectionalLight("#438fff", 2.5);
    rim.position.set(5, 1, -3);
    scene.add(rim);
    const fill = new THREE.DirectionalLight("#bcd9ff", 1.5);
    fill.position.set(-5, -3, 2);
    scene.add(fill);
    const { root, groups, targets } = buildPhone();
    scene.add(root);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = { x: 0, y: 0 };
    const move = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.x = (event.clientX - rect.left) / rect.width - 0.5;
      pointer.y = (event.clientY - rect.top) / rect.height - 0.5;
    };
    const leave = () => {
      pointer.x = 0;
      pointer.y = 0;
    };
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerleave", leave);
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.position.z = camera.aspect < 0.8 ? 13.5 : 11;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    let frame = 0,
      previous = 0,
      elapsed = 0;
    let renderedSnapshot = "";
    const origin = new THREE.Vector3(),
      destination = new THREE.Vector3(),
      scale = new THREE.Vector3();
    const render = (time: number) => {
      frame = requestAnimationFrame(render);
      if (time - previous < 1000 / 40) return;
      const dt = Math.min((time - previous) / 1000, 0.05);
      previous = time;
      if (document.hidden) return;
      const state = useDemo.getState();
      const motion = !media.matches && !state.paused;
      const snapshot = `${state.stage}:${state.exploded}:${state.part}:${container.clientWidth}:${container.clientHeight}`;
      if (!motion && renderedSnapshot === snapshot) return;
      renderedSnapshot = motion ? "" : snapshot;
      if (motion) elapsed += dt;
      const exploded = state.stage === "bom" && state.exploded;
      const lerp = media.matches || state.paused ? 1 : 1 - Math.exp(-dt * 3.2);
      for (const [id, group] of Object.entries(groups)) {
        destination.copy(exploded ? targets[id as keyof typeof targets] : origin);
        if (exploded && state.part === id) destination.z += 0.35;
        group.position.lerp(destination, lerp);
      }
      const compact = container.clientWidth < 600;
      const targetScale = exploded ? (compact ? 0.52 : 0.64) : 1;
      root.scale.lerp(scale.setScalar(targetScale), lerp);
      root.position.x = THREE.MathUtils.lerp(
        root.position.x,
        exploded && compact ? -0.28 : 0,
        lerp,
      );
      root.rotation.x = THREE.MathUtils.lerp(
        root.rotation.x,
        exploded ? 0.19 : 0.13 + (motion ? pointer.y * 0.12 : 0),
        lerp,
      );
      root.rotation.y = THREE.MathUtils.lerp(
        root.rotation.y,
        exploded
          ? -0.72
          : -0.45 + (motion ? Math.sin(elapsed * 0.26) * 0.06 + pointer.x * 0.22 : 0),
        lerp,
      );
      root.rotation.z = THREE.MathUtils.lerp(root.rotation.z, exploded ? -0.18 : -0.13, lerp);
      root.position.y = motion ? Math.sin(elapsed * 0.65) * 0.065 : 0;
      renderer.render(scene, camera);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerleave", leave);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      disposeScene(scene);
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div
      ref={host}
      className="product-canvas"
      role="img"
      aria-label="Stylized 3D iPhone 17 Pro with six separable component assemblies"
    >
      {failed && (
        <div className="phone-fallback">
          <div className="fallback-cameras">
            <i />
            <i />
            <i />
          </div>
          <span>
            iPhone
            <br />
            <strong>17 Pro</strong>
          </span>
          <small>Product illustration</small>
        </div>
      )}
    </div>
  );
}
