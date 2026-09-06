"use client";
import { useEffect, useRef, type RefObject } from "react";
import {
  HANDOFF_DURATION,
  componentDotFrame,
  handoffPosition,
  smoothProgress,
  type LandingHandoff,
} from "@/lib/scenes/landing-handoff";

export function ComponentJourney({ handoff }: { handoff: RefObject<LandingHandoff> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current!;
    const context = element.getContext("2d");
    if (!context) return;
    const state = handoff.current;
    let width = 0,
      height = 0,
      frame = 0,
      previous = 0,
      elapsed = 0,
      preparingElapsed = 0;
    let origins: { x: number; y: number }[] = [];
    let launchWidth = 1,
      launchHeight = 1,
      launchScroll = 0;
    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio, 2);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const render = (time: number) => {
      frame = requestAnimationFrame(render);
      if (document.hidden) {
        previous = time;
        return;
      }
      if (time - previous < 1000 / 40) return;
      const dt = previous ? Math.min(time - previous, 100) : 0;
      previous = time;
      if (state.reduced && (state.phase === "playing" || state.phase === "preparing")) {
        state.phase = "complete";
        state.progress = 1;
      }
      if (
        state.phase === "idle" &&
        state.enabled &&
        !state.reduced &&
        state.pastThreshold &&
        state.sourceHost &&
        state.targetHost
      ) {
        state.phase = "preparing";
      }
      if (state.phase === "preparing") {
        preparingElapsed += dt;
        if (state.sources.length === 6 && state.sourceHost && state.targetHost) {
          const bounds = state.sourceHost.getBoundingClientRect();
          launchWidth = width;
          launchHeight = height;
          launchScroll = window.scrollY;
          // Keep the component-to-dot transformation in view even on an anchor
          // jump. Normal scrolling preserves the original phone positions.
          origins = state.sources.map((source) => ({
            x: bounds.left + source.x,
            y: Math.max(100 + source.height / 2, bounds.top + source.y),
          }));
          state.phase = "playing";
          elapsed = 0;
        } else if (preparingElapsed > 3000) {
          state.phase = "complete";
          state.progress = 1;
        }
      }
      context.clearRect(0, 0, width, height);
      let dotCount = 0;
      if (state.phase === "playing") {
        elapsed += dt;
        state.progress = Math.min(1, elapsed / HANDOFF_DURATION);
        const targetBounds = state.targetHost?.getBoundingClientRect();
        if (targetBounds && state.targets.length) {
          state.sources.forEach((source, index) => {
            const target = state.targets[index % state.targets.length];
            const { morph, flight } = componentDotFrame(state.progress, index);
            const origin = origins[index];
            const start = {
              x: (origin.x * width) / launchWidth,
              y: (origin.y * height) / launchHeight + launchScroll,
            };
            const destination = {
              x: targetBounds.left + target.x,
              y: targetBounds.top + target.y + window.scrollY,
            };
            const bend = (index / 5 - 0.5) * Math.min(width * 0.48, 440);
            const position = handoffPosition(start, destination, flight, bend);
            const x = position.x,
              y = position.y - window.scrollY;
            if (morph < 1) {
              // Each complete assembly condenses into one point at its center.
              const size = (1 - morph * 0.985) * Math.min(1.35, width / launchWidth);
              const w = source.width * size,
                h = source.height * size;
              context.save();
              context.globalAlpha = 1 - smoothProgress(morph, 0.35, 1);
              context.drawImage(source.image, x - w / 2, y - h / 2, w, h);
              context.restore();
            }
            const opacity =
              smoothProgress(morph, 0.2, 0.85) *
              (1 - smoothProgress(flight, target.visible ? 0.96 : 0.78, 1));
            if (opacity <= 0) return;
            dotCount++;
            context.save();
            context.globalAlpha = opacity;
            // A short continuous light trail follows the curve; it never
            // splits a component into a cloud of smaller particles.
            if (flight > 0) {
              const tail = handoffPosition(start, destination, Math.max(0, flight - 0.045), bend);
              const trail = context.createLinearGradient(tail.x, tail.y - window.scrollY, x, y);
              trail.addColorStop(0, "#9fcefa00");
              trail.addColorStop(1, "#a9dbff70");
              context.beginPath();
              context.moveTo(tail.x, tail.y - window.scrollY);
              context.lineTo(x, y);
              context.lineWidth = 1.5;
              context.strokeStyle = trail;
              context.stroke();
            }
            const glow = context.createRadialGradient(x, y, 0, x, y, 21);
            glow.addColorStop(0, "#caeaffb0");
            glow.addColorStop(0.25, "#94cfff55");
            glow.addColorStop(1, "#75b7ff00");
            context.fillStyle = glow;
            context.fillRect(x - 21, y - 21, 42, 42);
            context.beginPath();
            context.arc(x, y, 4, 0, Math.PI * 2);
            context.fillStyle = "#c4e5ff";
            context.fill();
            context.beginPath();
            context.arc(x, y, 1.7, 0, Math.PI * 2);
            context.fillStyle = "#f0f8ff";
            context.fill();
            context.restore();
          });
        }
        if (state.progress >= 1 || !state.targetHost) {
          state.phase = "complete";
          state.progress = 1;
          context.clearRect(0, 0, width, height);
        }
      }
      element.dataset.phase = state.phase;
      element.dataset.progress = state.progress.toFixed(3);
      element.dataset.dotCount = String(state.phase === "playing" ? dotCount : 0);
      element.dataset.stage =
        state.phase !== "playing" ? state.phase : state.progress < 0.26 ? "morphing" : "dots";
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      // Next can preserve this page's refs while deactivating its effects.
      // A completed or interrupted entrance must not replay on return.
      if (state.phase === "playing" || state.phase === "preparing") {
        state.phase = "complete";
        state.progress = 1;
      }
    };
  }, [handoff]);
  return <canvas ref={canvas} className="landing-component-journey" aria-hidden="true" />;
}
