"use client";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildPhone, disposeScene } from "@/lib/scenes/phone";
import { useDemo } from "@/lib/demo-store";
import type { PartId } from "@/lib/demo-data";
import { phoneAssemblyOffset } from "@/lib/scenes/phone-motion";
import { capturePhoneAssemblies } from "@/lib/scenes/phone-snapshots";
import type { LandingHandoff } from "@/lib/scenes/landing-handoff";

export interface ProductPresentation {
  progress: number;
  paused: boolean;
}

export default function ProductScene({
  presentation,
  handoff: handoffRef,
  onReady,
}: {
  presentation?: RefObject<ProductPresentation>;
  handoff?: RefObject<LandingHandoff>;
  onReady?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const notifyReady = useEffectEvent(() => onReady?.());
  useEffect(() => {
    const container = host.current!;
    const journey = handoffRef?.current;
    let ready = false;
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
      notifyReady();
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
    const { root, groups } = buildPhone();
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
    let needsSourceRefresh = false;
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      needsSourceRefresh = true;
      camera.aspect = width / height;
      camera.position.z = camera.aspect < 0.8 ? 13.5 : 11;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    let visible = true;
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    visibility.observe(container);
    resize();
    let frame = 0,
      previous = 0,
      elapsed = 0,
      animatedProgress = 0;
    let renderedSnapshot = "";
    const destination = new THREE.Vector3(),
      scale = new THREE.Vector3();
    const render = (time: number) => {
      frame = requestAnimationFrame(render);
      if (time - previous < 1000 / 40) return;
      const dt = Math.min((time - previous) / 1000, 0.05);
      previous = time;
      if (journey && needsSourceRefresh && journey.phase === "idle") journey.sources = [];
      needsSourceRefresh = false;
      const preparing = journey?.phase === "preparing";
      const hidden =
        journey &&
        !journey.reduced &&
        journey.sources.length > 0 &&
        (journey.phase === "playing" || (journey.phase === "complete" && journey.pastThreshold));
      if (document.hidden || (!visible && !preparing && ready)) return;
      const state = useDemo.getState();
      const paused = presentation?.current.paused ?? state.paused;
      const progress = preparing
        ? 1
        : presentation
          ? presentation.current.progress
          : Number(state.stage === "bom" && state.exploded);
      const motion = !media.matches && !paused;
      const snapshot = `${progress}:${hidden}:${state.part}:${container.clientWidth}:${container.clientHeight}`;
      if (!motion && renderedSnapshot === snapshot) return;
      renderedSnapshot = motion ? "" : snapshot;
      if (motion) elapsed += dt;
      // A fast scroll may skip decomposition frames. Catch up to the expanded
      // pose immediately at section entry so the dot transition can start now.
      const finishAssembly = preparing && !journey?.sources.length;
      const lerp = media.matches || paused || finishAssembly ? 1 : 1 - Math.exp(-dt * 3.2);
      // Animate one timeline, not each group's position: independently lerping
      // XYZ would cut diagonally through the depth-first path on button presses.
      animatedProgress = finishAssembly
        ? 1
        : motion
          ? animatedProgress +
            THREE.MathUtils.clamp(progress - animatedProgress, -dt * 0.85, dt * 0.85)
          : progress;
      for (const [id, group] of Object.entries(groups)) {
        phoneAssemblyOffset(id as PartId, animatedProgress, destination);
        const lift =
          !presentation && state.part === id
            ? THREE.MathUtils.smootherstep(animatedProgress, 0.9, 1) * 0.1
            : 0;
        group.userData.focusLift = THREE.MathUtils.lerp(group.userData.focusLift ?? 0, lift, lerp);
        destination.z += group.userData.focusLift;
        group.position.copy(destination);
      }
      root.visible = !hidden;
      if (journey) container.parentElement?.style.setProperty("--transfer", hidden ? "1" : "0");
      const poseProgress = THREE.MathUtils.smootherstep(animatedProgress, 0, 1);
      const compact = container.clientWidth < 600;
      const explodedScale = compact ? 0.52 : presentation ? 0.57 : 0.64;
      const targetScale = THREE.MathUtils.lerp(1, explodedScale, poseProgress);
      root.scale.lerp(scale.setScalar(targetScale), lerp);
      const horizontalOffset = compact ? -0.28 : presentation ? -0.4 : 0;
      root.position.x = THREE.MathUtils.lerp(
        root.position.x,
        horizontalOffset * poseProgress,
        lerp,
      );
      root.rotation.x = THREE.MathUtils.lerp(
        root.rotation.x,
        THREE.MathUtils.lerp(0.13 + (motion ? pointer.y * 0.12 : 0), 0.19, poseProgress),
        lerp,
      );
      root.rotation.y = THREE.MathUtils.lerp(
        root.rotation.y,
        THREE.MathUtils.lerp(
          -0.45 + (motion ? Math.sin(elapsed * 0.26) * 0.06 + pointer.x * 0.22 : 0),
          -0.72,
          poseProgress,
        ),
        lerp,
      );
      root.rotation.z = THREE.MathUtils.lerp(root.rotation.z, -0.13 - 0.05 * poseProgress, lerp);
      root.position.y = motion ? Math.sin(elapsed * 0.65) * 0.065 : 0;
      if (journey) {
        journey.sourceHost = container;
        // Prepare the six source images during decomposition so normal section
        // entry starts the handoff immediately, without another assembly delay.
        if (animatedProgress >= 0.999 && !journey.sources.length) {
          try {
            journey.sources = capturePhoneAssemblies(
              groups,
              scene,
              camera,
              renderer,
              container.clientWidth,
              container.clientHeight,
            );
          } catch {
            // Keep the original model usable if this browser cannot copy its WebGL canvas.
            journey.phase = "complete";
            journey.progress = 1;
          }
        }
      }
      renderer.render(scene, camera);
      if (!ready) {
        ready = true;
        notifyReady();
      }
    };
    const lost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(frame);
      if (journey) {
        journey.sourceHost = null;
        journey.sources = [];
      }
      setFailed(true);
      notifyReady();
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      visibility.disconnect();
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerleave", leave);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      disposeScene(scene);
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      if (journey?.sourceHost === container) {
        journey.sourceHost = null;
        journey.sources = [];
      }
    };
  }, [presentation, handoffRef]);
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
