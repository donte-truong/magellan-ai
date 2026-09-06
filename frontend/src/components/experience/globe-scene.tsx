"use client";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { LocateFixed, Minus, Plus } from "lucide-react";
import * as THREE from "three";
import { suppliers } from "@/lib/demo-data";
import { useDemo } from "@/lib/demo-store";
import { disposeScene } from "@/lib/scenes/phone";
import { layoutGlobeLabels, type MapLabelPoint } from "@/lib/scenes/globe-labels";
import {
  smoothProgress,
  type HandoffTarget,
  type LandingHandoff,
} from "@/lib/scenes/landing-handoff";

const radius = 2.15;
function position(lat: number, lon: number, r = radius) {
  const a = THREE.MathUtils.degToRad(lat),
    b = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    Math.cos(a) * Math.sin(b) * r,
    Math.sin(a) * r,
    Math.cos(a) * Math.cos(b) * r,
  );
}
function route(from: THREE.Vector3, to: THREE.Vector3) {
  const start = from.clone().normalize(),
    end = to.clone().normalize();
  const angle = Math.acos(THREE.MathUtils.clamp(start.dot(end), -1, 1));
  const points = Array.from({ length: 81 }, (_, i) => {
    const t = i / 80;
    const direction = start
      .clone()
      .multiplyScalar(Math.sin((1 - t) * angle))
      .addScaledVector(end, Math.sin(t * angle))
      .normalize();
    return direction.multiplyScalar(radius + 0.025 + Math.sin(Math.PI * t) * 0.68);
  });
  return new THREE.CatmullRomCurve3(points);
}

export default function GlobeScene({
  preview,
  handoff,
  onReady,
}: {
  preview?: { paused: boolean };
  handoff?: RefObject<LandingHandoff>;
  onReady?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pins = useRef<(HTMLButtonElement | null)[]>([]);
  const leaders = useRef<(SVGPathElement | null)[]>([]);
  const control = useRef({ zoom: 1, reset: 0 });
  const [failed, setFailed] = useState(false);
  const notifyReady = useEffectEvent(() => onReady?.());
  const demoSelected = useDemo((s) => s.supplier);
  const [previewSelected, setPreviewSelected] = useState<string | null>(null);
  const isLandingHandoff = Boolean(preview && handoff);
  const selected = preview ? previewSelected : demoSelected;
  const selectSupplier = (id: string | null) => {
    if (preview) setPreviewSelected(id);
    else useDemo.getState().selectSupplier(id);
  };
  const getSceneState = useEffectEvent(() =>
    preview ? { paused: preview.paused, supplier: previewSelected } : useDemo.getState(),
  );
  useEffect(() => {
    const container = host.current!;
    const abort = new AbortController();
    const assetAbort = new AbortController();
    const assetTimeout = window.setTimeout(() => assetAbort.abort(), 8000);
    let assetsSettled = false,
      ready = false;
    const handoffState = handoff?.current;
    const clearProjection = () => {
      if (handoffState?.targetHost === container) {
        handoffState.targetHost = null;
        handoffState.targets = [];
      }
    };
    let contextLost = false;
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
      clearTimeout(assetTimeout);
      notifyReady();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    container.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 8.4);
    const earth = new THREE.Group();
    scene.add(earth);
    // The northern view puts all featured headquarters on the visible surface
    // while the landing-page streams arrive from the product above.
    const initialRotation = isLandingHandoff ? { x: 1.15, y: -0.15 } : { x: 0.19, y: -0.6 };
    earth.rotation.set(initialRotation.x, initialRotation.y, -0.1);
    const surface = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 80, 64),
      new THREE.MeshPhongMaterial({
        color: "#050e20",
        emissive: "#020818",
        shininess: 12,
        specular: "#24487a",
      }),
    );
    earth.add(surface);
    scene.add(new THREE.AmbientLight("#6b91ba", 1.8));
    const light = new THREE.DirectionalLight("#548ad7", 2.2);
    light.position.set(-4, 4, 6);
    scene.add(light);
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.025, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { glow: { value: new THREE.Color("#3281dc") } },
        vertexShader:
          "varying vec3 vNormal; varying vec3 vView; void main(){ vec4 p=modelViewMatrix*vec4(position,1.0); vNormal=normalize(normalMatrix*normal); vView=normalize(-p.xyz); gl_Position=projectionMatrix*p; }",
        fragmentShader:
          "varying vec3 vNormal; varying vec3 vView; uniform vec3 glow; void main(){ float rim=pow(1.0-abs(dot(normalize(vNormal),normalize(vView))),4.0); gl_FragColor=vec4(glow,rim*0.45); }",
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    earth.add(atmosphere);

    const gridMaterial = new THREE.LineBasicMaterial({
      color: "#3e668f",
      transparent: true,
      opacity: 0.17,
    });
    for (let lat = -60; lat <= 60; lat += 30) {
      earth.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(
            Array.from({ length: 181 }, (_, i) => position(lat, i * 2, radius + 0.008)),
          ),
          gridMaterial,
        ),
      );
    }
    for (let lon = 0; lon < 360; lon += 30) {
      earth.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(
            Array.from({ length: 181 }, (_, i) => position(i - 90, lon, radius + 0.008)),
          ),
          gridMaterial,
        ),
      );
    }
    const pointCanvas = document.createElement("canvas");
    pointCanvas.width = pointCanvas.height = 32;
    const ctx = pointCanvas.getContext("2d")!;
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.65, "#ffffff");
    gradient.addColorStop(1, "#ffffff00");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 32, 32);
    const dot = new THREE.CanvasTexture(pointCanvas);
    let mapVersion = 0;
    const pointsLoaded = fetch("/assets/models/world-points.json", { signal: assetAbort.signal })
      .then((r) => {
        if (!r.ok) throw new Error("Map asset unavailable");
        return r.json() as Promise<[number, number][]>;
      })
      .then((data) => {
        if (abort.signal.aborted) return;
        mapVersion++;
        const geometry = new THREE.BufferGeometry().setFromPoints(
          data.map(([lat, lon]) => position(lat, lon, radius + 0.018)),
        );
        earth.add(
          new THREE.Points(
            geometry,
            new THREE.PointsMaterial({
              color: "#addcff",
              size: 0.033,
              map: dot,
              transparent: true,
              opacity: 0.96,
              depthWrite: false,
              alphaTest: 0.05,
            }),
          ),
        );
      });

    const coastlinesLoaded = fetch("/assets/models/world-coastlines.json", {
      signal: assetAbort.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Coastline asset unavailable");
        return response.json() as Promise<[number, number][][]>;
      })
      .then((rings) => {
        if (abort.signal.aborted) return;
        // One draw call for all shorelines. Subdivide long segments so they follow
        // the sphere instead of cutting through its surface near the horizon.
        const vertices: THREE.Vector3[] = [];
        for (const ring of rings) {
          for (let i = 1; i < ring.length; i++) {
            const a = position(...ring[i - 1], 1);
            const b = position(...ring[i], 1);
            const steps = Math.max(1, Math.ceil(a.angleTo(b) / 0.012));
            for (let step = 0; step < steps; step++) {
              for (const t of [step / steps, (step + 1) / steps]) {
                vertices.push(
                  a
                    .clone()
                    .lerp(b, t)
                    .normalize()
                    .multiplyScalar(radius + 0.012),
                );
              }
            }
          }
        }
        earth.add(
          new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(vertices),
            new THREE.LineBasicMaterial({
              color: "#78bce9",
              transparent: true,
              opacity: 0.65,
              depthWrite: false,
            }),
          ),
        );
        mapVersion++;
      });
    // Either layer can still provide a usable map if the other fails to load.
    void Promise.allSettled([pointsLoaded, coastlinesLoaded]).then((results) => {
      clearTimeout(assetTimeout);
      if (abort.signal.aborted) return;
      assetsSettled = true;
      needsProjection = true;
      if (!abort.signal.aborted && results.every((result) => result.status === "rejected")) {
        setFailed(true);
      }
    });

    const anchor = position(suppliers[0].lat, suppliers[0].lon, radius + 0.025);
    const arcs = suppliers.slice(1).map((supplier) => {
      const curve = route(position(supplier.lat, supplier.lon, radius + 0.025), anchor);
      const material = new THREE.MeshBasicMaterial({
        color: supplier.color,
        transparent: true,
        opacity: 0.58,
      });
      const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 100, 0.007, 5, false), material);
      earth.add(line);
      const trail = new THREE.Mesh(
        new THREE.SphereGeometry(0.021, 10, 10),
        new THREE.MeshBasicMaterial({ color: "#d9f0ff" }),
      );
      earth.add(trail);
      return { curve, line, trail, id: supplier.id };
    });
    const markers = suppliers.map((supplier) => {
      const location = position(supplier.lat, supplier.lon, radius + 0.04);
      const material = new THREE.MeshBasicMaterial({ color: supplier.color });
      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.031, 12, 12), material);
      marker.position.copy(location);
      earth.add(marker);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.052, 0.062, 32),
        new THREE.MeshBasicMaterial({
          color: supplier.color,
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.position.copy(location);
      ring.lookAt(location.clone().multiplyScalar(2));
      earth.add(ring);
      return { location, marker, ring };
    });
    const starPositions: number[] = [];
    let seed = 47;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 160; i++)
      starPositions.push((random() - 0.5) * 19, (random() - 0.5) * 13, -4 - random() * 5);
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
    scene.add(
      new THREE.Points(
        starGeometry,
        new THREE.PointsMaterial({
          color: "#719acb",
          size: 0.015,
          transparent: true,
          opacity: 0.5,
        }),
      ),
    );

    let width = 1,
      height = 1;
    let needsProjection = true;
    const labelBounds = { left: 12, right: 1, top: 30, bottom: 1, width: 164, height: 74 };
    const resize = () => {
      width = container.clientWidth;
      height = container.clientHeight;
      if (!width || !height) return;
      needsProjection = true;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      const rect = container.getBoundingClientRect();
      const compact = window.innerWidth <= 760;
      labelBounds.left = Math.max(12, 12 - rect.left);
      labelBounds.right = Math.min(width - 12, window.innerWidth - rect.left - 12);
      labelBounds.top = compact ? 36 : height * 0.18;
      labelBounds.bottom = height * 0.8;
      labelBounds.width = compact ? 142 : 164;
      labelBounds.height = compact ? 68 : 74;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    let visible = true;
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    visibility.observe(container);
    resize();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0,
      previous = 0,
      elapsed = 0,
      reset = 0,
      previousSelected: string | null = null;
    let drag: { x: number; y: number } | null = null;
    const target = { ...initialRotation };
    const down = (event: PointerEvent) => {
      drag = { x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      target.y += (event.clientX - drag.x) * 0.005;
      const tiltLimit = isLandingHandoff ? 1.35 : 0.8;
      target.x = THREE.MathUtils.clamp(
        target.x + (event.clientY - drag.y) * 0.003,
        -tiltLimit,
        tiltLimit,
      );
      drag = { x: event.clientX, y: event.clientY };
    };
    const up = () => {
      drag = null;
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("pointercancel", up);
    const projected = new THREE.Vector3(),
      worldPosition = new THREE.Vector3();
    const labels = pins.current.map((pin) =>
      pin?.querySelector<HTMLElement>(".globe-location-card"),
    );
    const handoffTargets: HandoffTarget[] = suppliers.map((supplier) => ({
      id: supplier.id,
      x: 0,
      y: 0,
      visible: false,
    }));
    let renderedSnapshot = "";
    const render = (time: number) => {
      frame = requestAnimationFrame(render);
      if (time - previous < 1000 / 40) return;
      const dt = Math.min((time - previous) / 1000, 0.05);
      previous = time;
      const handoffProgress = handoffState?.progress ?? 1;
      const handoffActive = Boolean(
        handoffState && !handoffState.reduced && handoffProgress > 0 && handoffProgress < 1,
      );
      if (
        document.hidden ||
        contextLost ||
        (!visible && !handoffActive && !needsProjection) ||
        !width ||
        !height
      )
        return;
      const state = getSceneState();
      const motion = !state.paused && !media.matches;
      const snapshot = `${state.supplier}:${width}:${height}:${target.x}:${target.y}:${control.current.zoom}:${control.current.reset}:${mapVersion}:${handoffProgress}`;
      if (!motion && !needsProjection && renderedSnapshot === snapshot) return;
      const firstProjection = !handoffState?.targetHost;
      needsProjection = false;
      renderedSnapshot = motion ? "" : snapshot;
      if (motion) elapsed += dt;
      if (control.current.reset !== reset) {
        reset = control.current.reset;
        target.x = initialRotation.x;
        target.y = initialRotation.y;
        control.current.zoom = 1;
      }
      if (state.supplier !== previousSelected) {
        previousSelected = state.supplier;
        const supplier = suppliers.find((s) => s.id === state.supplier);
        if (supplier) {
          target.y = -THREE.MathUtils.degToRad(supplier.lon);
          target.x = THREE.MathUtils.degToRad(supplier.lat) * 0.6;
        }
      }
      if (!drag && motion && !state.supplier && (!isLandingHandoff || handoffProgress >= 1))
        target.y += dt * 0.028;
      const damping =
        media.matches || state.paused || (handoffState && firstProjection)
          ? 1
          : 1 - Math.exp(-dt * 4);
      earth.rotation.x = THREE.MathUtils.lerp(earth.rotation.x, target.x, damping);
      earth.rotation.y = THREE.MathUtils.lerp(earth.rotation.y, target.y, damping);
      camera.position.z = THREE.MathUtils.lerp(
        camera.position.z,
        (width / height < 0.9 ? 9.9 : 8.4) / control.current.zoom,
        damping,
      );
      earth.updateMatrixWorld();
      // Project DOM pins with the current camera, including an on-demand zoom frame.
      camera.updateMatrixWorld();
      arcs.forEach((arc, i) => {
        const active = !state.supplier || state.supplier === arc.id || state.supplier === "apple";
        arc.line.material.opacity = active ? 0.7 : 0.12;
        arc.trail.visible = active;
        arc.trail.position.copy(arc.curve.getPointAt((elapsed * 0.07 + i * 0.17) % 1));
      });
      const labelPoints: MapLabelPoint[] = [];
      markers.forEach((entry, i) => {
        const arrival =
          handoffState && motion && !handoffState.reduced
            ? Math.sin(Math.PI * smoothProgress(handoffProgress, 0.8 + i * 0.008, 1))
            : 0;
        entry.marker.scale.setScalar(1 + arrival * 0.65);
        entry.ring.scale.setScalar(
          1 + (motion ? (Math.sin(elapsed * 2 + i) + 1) * 0.3 : 0) + arrival * 1.4,
        );
        entry.ring.material.opacity = 0.7 + arrival * 0.25;
        worldPosition.copy(entry.location).applyMatrix4(earth.matrixWorld);
        projected.copy(worldPosition).project(camera);
        const markerVisible =
          worldPosition.z > (radius * radius) / camera.position.z - 0.12 &&
          Math.abs(projected.x) < 0.98 &&
          Math.abs(projected.y) < 0.98;
        const markerX = (projected.x * 0.5 + 0.5) * width;
        const markerY = (-projected.y * 0.5 + 0.5) * height;
        handoffTargets[i].x = markerX;
        handoffTargets[i].y = markerY;
        handoffTargets[i].visible = markerVisible;
        const pin = pins.current[i];
        if (pin) {
          pin.style.transform = `translate(${markerX}px,${markerY}px)`;
          pin.style.visibility = markerVisible ? "visible" : "hidden";
          pin.style.opacity = markerVisible ? "1" : "0";
          pin.tabIndex = markerVisible ? 0 : -1;
          if (labels[i]) labels[i]!.style.visibility = "hidden";
          if (leaders.current[i]) leaders.current[i]!.style.visibility = "hidden";
          if (markerVisible && (!state.supplier || state.supplier === suppliers[i].id)) {
            labelPoints.push({
              id: suppliers[i].id,
              x: markerX,
              y: markerY,
            });
          }
        }
      });
      if (assetsSettled && mapVersion === 0) {
        clearProjection();
      } else if (handoffState) {
        handoffState.targetHost = container;
        handoffState.targets = handoffTargets;
      }
      for (const label of layoutGlobeLabels(labelPoints, labelBounds)) {
        const index = suppliers.findIndex((supplier) => supplier.id === label.id);
        const card = labels[index];
        const leader = leaders.current[index];
        if (!card || !leader) continue;
        card.style.left = `${label.left - label.x + 13.5}px`;
        card.style.top = `${label.top - label.y + 13.5}px`;
        card.style.visibility = "visible";
        const edgeX = label.left + (label.left < label.x ? labelBounds.width : 0);
        const edgeY = label.top + labelBounds.height / 2;
        leader.setAttribute("d", `M${label.x},${label.y} L${edgeX},${edgeY}`);
        leader.style.visibility = "visible";
      }
      renderer.render(scene, camera);
      if (assetsSettled && !ready) {
        ready = true;
        notifyReady();
      }
    };
    const lost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      clearProjection();
      setFailed(true);
      notifyReady();
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    frame = requestAnimationFrame(render);
    return () => {
      abort.abort();
      assetAbort.abort();
      clearTimeout(assetTimeout);
      clearProjection();
      cancelAnimationFrame(frame);
      observer.disconnect();
      visibility.disconnect();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointermove", move);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("pointercancel", up);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      disposeScene(scene);
      dot.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [handoff, isLandingHandoff]);
  return (
    <div className="globe-stage" aria-label="3D supplier globe">
      <div className="globe-atmosphere" />
      <div ref={host} className="globe-canvas">
        <svg
          className="globe-label-leaders"
          aria-hidden="true"
          style={failed ? { display: "none" } : undefined}
        >
          {suppliers.map((supplier, index) => (
            <path
              key={supplier.id}
              ref={(el) => {
                leaders.current[index] = el;
              }}
              stroke={supplier.color}
            />
          ))}
        </svg>
        {!failed &&
          suppliers.map((supplier, index) => (
            <button
              key={supplier.id}
              ref={(el) => {
                pins.current[index] = el;
              }}
              className={`globe-pin ${selected === supplier.id ? "selected" : ""}`}
              style={{ "--pin-color": supplier.color } as React.CSSProperties}
              aria-label={`Locate ${supplier.name} in ${supplier.country}`}
              aria-pressed={selected === supplier.id}
              onClick={() => selectSupplier(supplier.id)}
            >
              <i />
              <span className="globe-location-card">
                <small>
                  {supplier.city} · {supplier.code}
                </small>
                <strong>{supplier.name}</strong>
                <span>{supplier.component}</span>
              </span>
            </button>
          ))}
        {failed && (
          <div className="globe-fallback">
            <svg viewBox="0 0 400 400" aria-label="World globe illustration">
              <defs>
                <radialGradient id="sphere">
                  <stop stopColor="#183352" />
                  <stop offset="1" stopColor="#071325" />
                </radialGradient>
              </defs>
              <circle cx="200" cy="200" r="168" fill="url(#sphere)" stroke="#406da4" />
              {[-60, -30, 0, 30, 60].map((a) => (
                <ellipse
                  key={a}
                  cx="200"
                  cy="200"
                  rx={Math.max(20, Math.abs(a) * 2)}
                  ry="168"
                  fill="none"
                  stroke="#375675"
                  opacity=".5"
                />
              ))}
              {[100, 150, 200, 250, 300].map((y) => (
                <path
                  key={y}
                  d={`M 49 ${y} Q 200 ${y + 50} 351 ${y}`}
                  fill="none"
                  stroke="#375675"
                />
              ))}
            </svg>
            <p>Use the supplier list to explore connections.</p>
          </div>
        )}
      </div>
      {!failed && (
        <div className="globe-controls" aria-label="Globe controls">
          <button
            aria-label="Zoom in"
            onClick={() => {
              control.current.zoom = Math.min(1.35, control.current.zoom + 0.12);
            }}
          >
            <Plus size={17} />
          </button>
          <button
            aria-label="Zoom out"
            onClick={() => {
              control.current.zoom = Math.max(0.8, control.current.zoom - 0.12);
            }}
          >
            <Minus size={17} />
          </button>
          <span />
          <button
            aria-label="Reset globe view"
            onClick={() => {
              selectSupplier(null);
              control.current.reset++;
            }}
          >
            <LocateFixed size={17} />
          </button>
        </div>
      )}
      <p className="globe-instruction">
        {failed ? "Headquarters map" : "Drag to explore the world"}
      </p>
    </div>
  );
}
