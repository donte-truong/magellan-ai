"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  FileText,
  Layers3,
  RotateCcw,
  ScanLine,
  ShieldCheck,
} from "lucide-react";
import { MagellanMark } from "@/components/magellan-mark";
import type { ProductPresentation } from "@/components/experience/product-scene";
import { PRODUCT_SOURCE, TEARDOWN_SOURCE, ENVIRONMENT_SOURCE } from "@/lib/demo-data";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { createLandingHandoff, smoothProgress } from "@/lib/scenes/landing-handoff";
import { ComponentJourney } from "./component-journey";
import { LoadingScreen } from "./loading-screen";

const ProductScene = dynamic(() => import("@/components/experience/product-scene"), {
  ssr: false,
  loading: () => (
    <div className="landing-scene-loading" aria-label="Loading product">
      <span />
    </div>
  ),
});
const GlobeScene = dynamic(() => import("@/components/experience/globe-scene"), {
  ssr: false,
  loading: () => (
    <div className="landing-scene-loading" aria-label="Loading globe">
      <span />
    </div>
  ),
});

function OrbitLines() {
  return (
    <svg className="landing-orbits" viewBox="0 0 800 800" fill="none" aria-hidden="true">
      <defs>
        <linearGradient
          id="home-orbit-light"
          x1="0"
          y1="0"
          x2="800"
          y2="800"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#9fcefa" stopOpacity="0" />
          <stop offset=".45" stopColor="#9fcefa" stopOpacity=".5" />
          <stop offset="1" stopColor="#9fcefa" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform="rotate(-28 400 400)">
        <ellipse cx="400" cy="400" rx="355" ry="245" stroke="url(#home-orbit-light)" />
        <ellipse cx="400" cy="400" rx="310" ry="210" stroke="#9fcefa" strokeOpacity=".08" />
        <ellipse
          className="landing-orbit-tracer"
          cx="400"
          cy="400"
          rx="355"
          ry="245"
          stroke="#b8dcff"
          strokeWidth="2"
          pathLength="100"
        />
      </g>
      <path
        d="M90 400h12m-6-6v12m602-6h12m-6-6v12M400 90v12m-6-6h12"
        stroke="#9fcefa"
        strokeOpacity=".4"
      />
    </svg>
  );
}

function EvidenceLines() {
  return (
    <svg className="landing-evidence-lines" viewBox="0 0 600 300" fill="none" aria-hidden="true">
      {[70, 150, 230].map((y) => (
        <g key={y}>
          <path
            d={`M45 ${y}H160C230 ${y} 210 150 285 150H560`}
            stroke="#719acb"
            strokeOpacity=".2"
          />
          <path
            className="landing-evidence-tracer"
            style={{ animationDelay: `${y / -50}s` }}
            d={`M45 ${y}H160C230 ${y} 210 150 285 150H560`}
            stroke="#9fcefa"
            pathLength="100"
          />
          <circle cx="45" cy={y} r="4" fill="#9fcefa" />
        </g>
      ))}
      <circle cx="560" cy="150" r="7" fill="#c2deff" />
      <circle
        className="landing-signal-ring"
        cx="560"
        cy="150"
        r="17"
        stroke="#9fcefa"
        strokeOpacity=".4"
      />
    </svg>
  );
}

function TransitionWaves() {
  const wave = "M-180 120C160-30 440 300 760 140S1220 30 1620 170";
  return (
    <div className="landing-wave-transition" aria-hidden="true">
      <svg viewBox="0 0 1440 300" fill="none" preserveAspectRatio="none">
        <defs>
          <linearGradient
            id="home-wave-light"
            x1="0"
            y1="0"
            x2="1440"
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#78a6e0" stopOpacity="0" />
            <stop offset=".25" stopColor="#799ee8" stopOpacity=".55" />
            <stop offset=".55" stopColor="#b5e4ff" stopOpacity=".9" />
            <stop offset=".8" stopColor="#7eacdf" stopOpacity=".4" />
            <stop offset="1" stopColor="#78a6e0" stopOpacity="0" />
          </linearGradient>
          <filter id="home-wave-glow" x="-20%" y="-100%" width="140%" height="300%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
        </defs>
        <g className="landing-wave-layer landing-wave-far">
          <path
            d={wave}
            stroke="url(#home-wave-light)"
            strokeWidth="20"
            opacity=".22"
            filter="url(#home-wave-glow)"
          />
          {Array.from({ length: 10 }, (_, i) => (
            <path
              key={i}
              d={wave}
              transform={`translate(0 ${i * 7})`}
              stroke="url(#home-wave-light)"
              strokeWidth=".8"
              opacity={0.65 - i * 0.04}
            />
          ))}
        </g>
        <g className="landing-wave-layer landing-wave-near">
          {Array.from({ length: 8 }, (_, i) => (
            <path
              key={i}
              d={wave}
              transform={`translate(0 ${i * 8})`}
              stroke="url(#home-wave-light)"
              strokeWidth=".8"
              opacity={0.8 - i * 0.07}
            />
          ))}
          <path
            className="landing-wave-tracer"
            d={wave}
            stroke="url(#home-wave-light)"
            strokeWidth="1.5"
            pathLength="100"
          />
        </g>
      </svg>
    </div>
  );
}

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const story = useRef<HTMLElement>(null);
  const globe = useRef<HTMLDivElement>(null);
  const presentation = useRef<ProductPresentation>({ progress: 0, paused: false });
  const handoff = useRef(createLandingHandoff());
  const [assemblyView, setAssemblyView] = useState<boolean | null>(null);
  const [decomposed, setDecomposed] = useState(false);
  const [productReady, setProductReady] = useState(false);
  const [globeReady, setGlobeReady] = useState(false);
  const [entered, setEntered] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    const section = story.current!;
    const hero = section.querySelector<HTMLElement>(".landing-hero")!;
    const header = root.current!.querySelector<HTMLElement>(".landing-header")!;
    const worldScene = globe.current!;
    const worldSection = worldScene.closest<HTMLElement>("#world")!;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!section.isConnected || !worldScene.isConnected) return;
      const rect = section.getBoundingClientRect();
      const releaseScroll =
        rect.top + window.scrollY + section.offsetHeight - hero.offsetHeight - header.offsetHeight;
      const scroll = Math.max(0, Math.min(1, window.scrollY / Math.max(1, releaseScroll)));
      const scrollProgress = reduced ? 0 : smoothProgress(scroll, 0.08, 0.72);
      const progress = Math.max(scrollProgress, Number(assemblyView));
      presentation.current.progress = reduced ? Number(progress > 0.5) : progress;
      Object.assign(handoff.current, {
        // Start on entry into the section, not when the globe's center is visible.
        pastThreshold: worldSection.getBoundingClientRect().top <= window.innerHeight,
        enabled: entered,
        reduced,
      });
      section.style.setProperty("--unfold", String(progress));
      setDecomposed(progress > 0.5);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [assemblyView, reduced, entered]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12 },
    );
    root.current!.querySelectorAll("[data-reveal]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  const closer = () => {
    setAssemblyView(!decomposed);
    document
      .getElementById("inside")
      ?.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "start" });
  };

  return (
    <div ref={root} className="experience landing">
      {!entered && (
        <LoadingScreen ready={productReady && globeReady} onEntered={() => setEntered(true)} />
      )}
      <div className="landing-page" inert={!entered} aria-hidden={!entered || undefined}>
        <ComponentJourney handoff={handoff} />
        <a className="experience-skip" href="#home-main">
          Skip to content
        </a>
        <header className="landing-header">
          <Link className="experience-brand" href="/home" aria-label="Magellan home">
            <MagellanMark />
            <span>Magellan</span>
          </Link>
          <nav className="landing-nav" aria-label="Main navigation">
            <a href="#inside">Discover</a>
            <a href="#world">The Bigger Picture</a>
            <a href="#evidence">Our Approach</a>
          </nav>
          <div className="landing-header-actions">
            <Link className="landing-nav-cta" href="/">
              Explore Magellan <ArrowUpRight size={15} />
            </Link>
          </div>
        </header>

        <main id="home-main">
          <section
            ref={story}
            className="landing-story"
            id="inside"
            aria-labelledby="landing-title"
          >
            <div className="landing-hero">
              <div className="landing-hero-aura" aria-hidden="true" />
              <div className="landing-hero-copy">
                <p className="landing-eyebrow">
                  <span className="landing-status-dot" /> CURIOSITY HAS A NEW COMPASS
                </p>
                <h1 id="landing-title">
                  Every product.
                  <br />
                  <span>
                    A world of
                    <br />
                    supply chains.
                  </span>
                </h1>
                <p className="landing-description">
                  Go beneath the surface of everyday products.
                  <br className="landing-desktop-break" /> Discover the parts, the people, and the
                  places behind them.
                </p>
                <div className="landing-hero-actions">
                  <Link className="landing-button" href="/">
                    Start exploring <ArrowRight size={18} />
                  </Link>
                  <button
                    className="landing-text-button"
                    onClick={closer}
                    aria-pressed={decomposed}
                  >
                    {decomposed ? "Reassemble iPhone" : "Take a closer look"}
                    {decomposed ? <RotateCcw size={16} /> : <Layers3 size={16} />}
                  </button>
                </div>
              </div>
              <div className="landing-product">
                <OrbitLines />
                <div className="landing-product-light" aria-hidden="true" />
                <ProductScene
                  presentation={presentation}
                  handoff={handoff}
                  onReady={() => setProductReady(true)}
                />
                <span className="landing-product-label">
                  <span /> iPhone 17 Pro{" "}
                  <span className="landing-product-label-detail">
                    The beginning of a bigger story.
                  </span>
                </span>
                <span className="landing-assembly-caption">Six assemblies. A new perspective.</span>
              </div>
            </div>
          </section>

          <TransitionWaves />

          <section className="landing-world" id="world" aria-labelledby="world-title">
            <div className="landing-section-heading" data-reveal>
              <p className="landing-eyebrow">
                <span /> THE BIGGER PICTURE
              </p>
              <h2 id="world-title">
                Nothing is made
                <br />
                <span>in isolation.</span>
              </h2>
              <p>Follow a single component. Find a world of connections.</p>
            </div>
            <div ref={globe} className="landing-world-scene">
              <div className="landing-world-halo" aria-hidden="true" />
              <GlobeScene
                preview={{ paused: false }}
                handoff={handoff}
                onReady={() => setGlobeReady(true)}
              />
            </div>
            <div className="landing-world-caption" data-reveal>
              <span>
                <span className="landing-status-dot" /> Real companies. Connected by components.
              </span>
              <Link className="landing-text-button" href="/#network">
                Explore the network <ArrowUpRight size={16} />
              </Link>
            </div>
            <p className="landing-map-note">
              Featured iPhone exploration · Company headquarters · Illustrative connections
            </p>
          </section>

          <section className="landing-evidence" id="evidence" aria-labelledby="evidence-title">
            <div className="landing-evidence-copy" data-reveal>
              <p className="landing-eyebrow">
                <span /> GROUNDED IN EVIDENCE
              </p>
              <h2 id="evidence-title">
                Wonder, meet
                <br />
                <span>understanding.</span>
              </h2>
              <p>
                Every connection has a story. Follow it back to the source, see what’s supported,
                and discover what’s still unknown.
              </p>
              <Link className="landing-text-button" href="/research">
                Go deeper with live research <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="landing-evidence-art" data-reveal>
              <div className="landing-source-stack">
                <a href={PRODUCT_SOURCE} target="_blank" rel="noreferrer">
                  <FileText size={17} />
                  <span>
                    Apple <small>Technical specifications</small>
                  </span>
                  <ArrowUpRight size={14} />
                </a>
                <a href={TEARDOWN_SOURCE} target="_blank" rel="noreferrer">
                  <ScanLine size={17} />
                  <span>
                    iFixit <small>A closer look inside</small>
                  </span>
                  <ArrowUpRight size={14} />
                </a>
                <a href={ENVIRONMENT_SOURCE} target="_blank" rel="noreferrer">
                  <FileText size={17} />
                  <span>
                    Apple <small>Environmental report</small>
                  </span>
                  <ArrowUpRight size={14} />
                </a>
              </div>
              <EvidenceLines />
              <div className="landing-evidence-node">
                <ShieldCheck size={29} />
                <span>Clarity, with context.</span>
                <span className="landing-source-badge">
                  <Check size={12} /> Source linked
                </span>
              </div>
            </div>
          </section>

          <section className="landing-outro" aria-labelledby="outro-title">
            <div className="landing-horizon" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="landing-outro-content" data-reveal>
              <MagellanMark />
              <h2 id="outro-title">
                Let curiosity
                <br />
                <span>take you further.</span>
              </h2>
              <Link className="landing-button" href="/">
                Explore your first product <ArrowRight size={18} />
              </Link>
            </div>
          </section>
        </main>

        <footer className="landing-footer">
          <Link className="experience-brand" href="/home">
            <MagellanMark />
            <span>Magellan</span>
          </Link>
          <span>A little curiosity. A much bigger picture.</span>
          <nav aria-label="Footer navigation">
            <Link href="/">
              Explore <ArrowUpRight size={13} />
            </Link>
            <Link href="/research">
              Live Research <ArrowUpRight size={13} />
            </Link>
          </nav>
        </footer>
      </div>
    </div>
  );
}
