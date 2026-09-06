"use client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { MagellanMark } from "@/components/magellan-mark";

export function LoadingScreen({ ready, onEntered }: { ready: boolean; onEntered: () => void }) {
  const [fontsReady, setFontsReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const started = useRef(0);
  const enter = useEffectEvent(onEntered);
  useEffect(() => {
    started.current = performance.now();
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) setFontsReady(true);
    });
    // A stalled connection must never trap someone behind a loading screen.
    const deadline = window.setTimeout(() => setLeaving(true), 10000);
    return () => {
      active = false;
      clearTimeout(deadline);
    };
  }, []);
  useEffect(() => {
    if (!ready || !fontsReady) return;
    const timer = window.setTimeout(
      () => setLeaving(true),
      Math.max(0, 900 - (performance.now() - started.current)),
    );
    return () => clearTimeout(timer);
  }, [ready, fontsReady]);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(
      () => enter(),
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : 750,
    );
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <div
      className={`landing-loader${leaving ? " is-leaving" : ""}`}
      role="status"
      aria-label="Loading Magellan"
    >
      <div className="landing-loader-content">
        <div className="landing-loader-compass">
          <svg className="landing-loader-dial" viewBox="0 0 160 160" fill="none" aria-hidden="true">
            <circle cx="80" cy="80" r="73" stroke="currentColor" opacity=".1" />
            <circle
              className="landing-loader-trace"
              cx="80"
              cy="80"
              r="73"
              stroke="currentColor"
              pathLength="100"
            />
            {Array.from({ length: 48 }, (_, i) => (
              <path
                key={i}
                d={`M80 12v${i % 4 === 0 ? 6 : 3}`}
                transform={`rotate(${i * 7.5} 80 80)`}
                stroke="currentColor"
                opacity={i % 4 === 0 ? 0.5 : 0.17}
              />
            ))}
          </svg>
          <MagellanMark />
        </div>
        <span>Magellan</span>
      </div>
    </div>
  );
}
