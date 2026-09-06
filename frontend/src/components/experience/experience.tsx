"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import dynamic from "next/dynamic";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Battery,
  Camera,
  Check,
  ChevronRight,
  CircleHelp,
  Cpu,
  Fingerprint,
  Globe2,
  Layers3,
  Maximize2,
  Pause,
  Play,
  Radio,
  Search,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { demoExport, parts, suppliers } from "@/lib/demo-data";
import { useDemo, type DemoStage } from "@/lib/demo-store";
import { useReducedMotion } from "@/lib/use-reduced-motion";

const ProductScene = dynamic(() => import("./product-scene"), {
  ssr: false,
  loading: () => (
    <div className="scene-loading">
      <span />
      Preparing the product
    </div>
  ),
});
const GlobeScene = dynamic(() => import("./globe-scene"), {
  ssr: false,
  loading: () => (
    <div className="scene-loading">
      <span />
      Opening the world
    </div>
  ),
});
const icons = {
  display: Smartphone,
  silicon: Cpu,
  camera: Camera,
  battery: Battery,
  enclosure: Layers3,
  connectivity: Radio,
};
const steps: { id: DemoStage; label: string }[] = [
  { id: "input", label: "Product" },
  { id: "bom", label: "Deconstruct" },
  { id: "network", label: "Explore" },
];

function Mark() {
  return (
    <svg className="magellan-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <circle cx="18" cy="18" r="15" stroke="currentColor" strokeWidth="1" opacity=".35" />
      <path d="m24.5 10-4 12.5L11.5 26l4-12.5L24.5 10Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="m15.5 13.5 5 9M18 1v4m0 26v4M1 18h4m26 0h4" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function Experience() {
  const { stage, started, paused, setStage, reset, togglePaused } = useDemo();
  const [info, setInfo] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash === "bom" || hash === "network") useDemo.getState().setStage(hash);
    const navigate = () => {
      const next = window.location.hash.slice(1);
      useDemo.getState().setStage(next === "bom" || next === "network" ? next : "input");
    };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = stage === "input" ? "" : stage;
    window.history.replaceState({}, "", url);
    window.scrollTo(0, 0);
    if (stage !== "input") heading.current?.focus({ preventScroll: true });
  }, [stage]);
  useEffect(() => {
    if (info) dialog.current?.showModal();
    else dialog.current?.close();
  }, [info]);

  return (
    <div className={`experience stage-${stage} ${paused ? "motion-paused" : ""}`}>
      <a className="experience-skip" href="#experience-main">
        Skip to exploration
      </a>
      <header className="experience-header">
        <button className="experience-brand" onClick={reset} aria-label="Magellan home">
          <Mark />
          <span>
            magellan<span className="brand-period">.</span>
          </span>
        </button>
        <nav className="journey-nav" aria-label="Exploration steps">
          {steps.map((step, i) => (
            <button
              key={step.id}
              aria-current={stage === step.id ? "step" : undefined}
              disabled={!started && i > 0}
              onClick={() => setStage(step.id)}
            >
              <span className="step-number">
                {started && steps.findIndex((s) => s.id === stage) > i ? (
                  <Check size={11} />
                ) : (
                  `0${i + 1}`
                )}
              </span>
              {step.label}
              {i < 2 && <ChevronRight className="step-chevron" size={12} />}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <span className="demo-badge">
            <i />
            Curated demo
          </span>
          <button
            className="icon-button about-button"
            aria-label="About this demo"
            onClick={() => setInfo(true)}
          >
            <CircleHelp size={18} />
          </button>
        </div>
      </header>

      <main id="experience-main" className="experience-main">
        {stage !== "network" && (
          <div className="product-render">
            <div className="product-glow" />
            <div className="product-orbit" />
            <ProductScene />
          </div>
        )}
        {stage === "input" && <InputStage headingRef={heading} />}
        {stage === "bom" && <DecompositionStage headingRef={heading} />}
        {stage === "network" && <NetworkStage headingRef={heading} />}
      </main>

      <footer className="experience-footer">
        <div>
          <span className="footer-signal" />A little curiosity. A much bigger picture.
        </div>
        <div className="footer-right">
          <a href="/research">
            Live research <ArrowUpRight size={12} />
          </a>
          <span className="footer-divider" />
          <button
            onClick={togglePaused}
            aria-label={paused ? "Resume animations" : "Pause animations"}
            aria-pressed={paused}
          >
            {paused || reduced ? <Play size={12} /> : <Pause size={12} />}
            <span>{reduced ? "Reduced motion" : paused ? "Motion paused" : "Motion on"}</span>
          </button>
        </div>
      </footer>

      <dialog
        ref={dialog}
        className="demo-dialog"
        onCancel={() => setInfo(false)}
        onClose={() => setInfo(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setInfo(false);
        }}
        aria-labelledby="about-title"
      >
        <div className="dialog-heading">
          <Mark />
          <button
            className="icon-button"
            onClick={() => setInfo(false)}
            aria-label="Close about dialog"
          >
            <X size={20} />
          </button>
        </div>
        <p className="eyebrow">A WORLD WITHIN</p>
        <h2 id="about-title">Curiosity, made visible.</h2>
        <p>
          This guided iPhone 17 Pro exploration uses a curated selection of Apple specifications and
          iFixit teardown findings. Select an assembly or supplier to open its source.
        </p>
        <div className="method-note">
          <ShieldCheck size={19} />
          <p>
            The 3D model is a stylized illustration. Map pins show approximate company headquarters;
            the arcs illustrate relationships, not shipment routes. Factory locations and a complete
            manufacturing BOM remain unresolved.
          </p>
        </div>
        <a className="text-link" href="/research">
          Open the live research workspace <ArrowUpRight size={15} />
        </a>
      </dialog>
    </div>
  );
}

type HeadingProps = { headingRef: React.RefObject<HTMLHeadingElement | null> };

function InputStage({ headingRef }: HeadingProps) {
  const [product, setProduct] = useState("iPhone 17 Pro");
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^(apple\s+)?iphone\s*17\s*pro$/i.test(product.trim())) {
      setError(
        "This featured demo explores iPhone 17 Pro. Choose it below, or open Live research for another product.",
      );
      return;
    }
    setError("");
    useDemo.getState().setStage("bom");
  };
  return (
    <section className="input-stage stage-enter" aria-labelledby="input-title">
      <div className="input-copy">
        <p className="eyebrow">
          <span />
          SUPPLY CHAIN INTELLIGENCE
        </p>
        <h1 id="input-title" ref={headingRef} tabIndex={-1}>
          Every product.
          <br />
          <span>A world within.</span>
        </h1>
        <p className="hero-description">
          Go beneath the surface. Discover the components,
          <br className="desktop-break" /> connections, and places behind the things we make.
        </p>
        <form className="discovery-form" onSubmit={submit}>
          <label htmlFor="demo-product">YOUR CURIOSITY STARTS HERE</label>
          <div className={`product-input-wrap ${error ? "has-error" : ""}`}>
            <Search size={19} />
            <input
              id="demo-product"
              value={product}
              onChange={(e) => {
                setProduct(e.target.value);
                setError("");
              }}
              aria-describedby={error ? "product-error" : "product-hint"}
              aria-invalid={Boolean(error)}
              autoComplete="off"
              spellCheck={false}
              maxLength={120}
              placeholder="Enter a product"
              aria-label="Product name"
            />
            <span className="input-key">↵</span>
          </div>
          {error && (
            <p className="demo-error" id="product-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button deconstruct-button" type="submit">
            Deconstruct product <ArrowRight size={17} />
          </button>
          <div className="product-hint" id="product-hint">
            <span>Featured exploration</span>
            <button
              type="button"
              onClick={() => {
                setProduct("iPhone 17 Pro");
                setError("");
              }}
            >
              iPhone 17 Pro <ArrowUpRight size={11} />
            </button>
          </div>
        </form>
      </div>
      <div className="product-annotation annotation-top">
        <span className="micro-label">THE OBJECT OF EXPLORATION</span>
        <span className="annotation-line" />
        <span className="micro-label">001</span>
      </div>
      <div className="hero-coordinate">
        <span>6.3″</span>
        <small>SUPER RETINA XDR</small>
        <svg viewBox="0 0 126 35" fill="none" aria-hidden="true">
          <path d="M0 34h72L104 2h20" stroke="currentColor" />
          <circle cx="124" cy="2" r="2" fill="currentColor" />
        </svg>
      </div>
      <div className="product-caption">
        <div className="finish-dot" />
        <div>
          <h2>iPhone 17 Pro</h2>
          <p>Deep Blue. Deeper possibilities.</p>
        </div>
        <span className="caption-index">01 / 01</span>
      </div>
      <div className="journey-preview">
        <div>
          <span className="preview-icon">
            <Fingerprint size={21} />
          </span>
          <p>
            <strong>Start with a product</strong>
            <span>One name. A new perspective.</span>
          </p>
        </div>
        <ArrowRight size={15} className="preview-arrow" />
        <div>
          <span className="preview-icon">
            <Layers3 size={21} />
          </span>
          <p>
            <strong>Reveal what’s inside</strong>
            <span>Every layer has a story.</span>
          </p>
        </div>
        <ArrowRight size={15} className="preview-arrow" />
        <div>
          <span className="preview-icon">
            <Globe2 size={21} />
          </span>
          <p>
            <strong>See the bigger picture</strong>
            <span>Follow the connections.</span>
          </p>
        </div>
      </div>
    </section>
  );
}

function DecompositionStage({ headingRef }: HeadingProps) {
  const { part, selectPart, exploded, toggleExploded, setStage } = useDemo();
  const selected = parts.find((p) => p.id === part)!;
  const [revealed, setRevealed] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    const timer = setTimeout(() => setRevealed(true), reduced ? 0 : 1800);
    return () => clearTimeout(timer);
  }, [reduced]);
  return (
    <section className="decomposition-stage stage-enter" aria-labelledby="bom-title">
      <div className="stage-heading">
        <button className="back-link" onClick={() => setStage("input")}>
          <ArrowLeft size={13} />
          The product
        </button>
        <p className="eyebrow">02 / BENEATH THE SURFACE</p>
        <h1 id="bom-title" ref={headingRef} tabIndex={-1}>
          One whole.
          <br />
          <span>Many extraordinary parts.</span>
        </h1>
        <p>Meet the building blocks of iPhone 17 Pro.</p>
      </div>
      <div className={`component-panel ${revealed ? "revealed" : ""}`}>
        <div className="panel-label">
          <span>BILL OF MATERIALS</span>
          <span>06 ASSEMBLIES</span>
        </div>
        <div className="component-list" aria-label="Product components">
          {parts.map((item, i) => {
            const Icon = icons[item.id];
            return (
              <div
                key={item.id}
                className={`component-row ${item.id === part ? "active" : ""}`}
                style={
                  { "--delay": `${i * 130 + 250}ms`, "--part-color": item.color } as CSSProperties
                }
              >
                <button
                  className="component-select"
                  onClick={() => selectPart(item.id)}
                  aria-expanded={item.id === part}
                  aria-controls={`part-${item.id}`}
                >
                  <span className="component-icon">
                    <Icon size={19} />
                  </span>
                  <span className="component-name">
                    {item.name}
                    <small>{item.material}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
                {item.id === part && (
                  <div className="component-detail" id={`part-${item.id}`}>
                    <p>{item.detail}</p>
                    <a href={item.source} target="_blank" rel="noreferrer">
                      {item.publisher}
                      <ArrowUpRight size={12} />
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="bom-note">
          <ShieldCheck size={13} />
          Selected assemblies · quantities unresolved
        </p>
      </div>
      <div className="explosion-label">
        <i style={{ background: selected.color }} />
        <div>
          <span>{selected.spec}</span>
          <small>{selected.subtitle}</small>
        </div>
        <svg viewBox="0 0 160 35" fill="none" aria-hidden="true">
          <path d="M0 1h76l33 33h49" stroke="currentColor" />
          <circle cx="158" cy="34" r="2" fill="currentColor" />
        </svg>
      </div>
      <div className="model-control">
        <span className="micro-label">ILLUSTRATIVE EXPLODED VIEW</span>
        <button onClick={toggleExploded} aria-pressed={!exploded}>
          {exploded ? <Layers3 size={15} /> : <Maximize2 size={15} />}{" "}
          {exploded ? "Reassemble" : "Explode view"}
        </button>
      </div>
      <div className="decomposition-bottom">
        <span className="reveal-status" role="status">
          <span className={revealed ? "status-complete" : "status-revealing"} />
          {revealed ? "Six assemblies, revealed." : "Revealing the architecture…"}
        </span>
        <button className="primary-button" onClick={() => setStage("network")}>
          Explore the supply network <Globe2 size={17} />
          <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}

function NetworkStage({ headingRef }: HeadingProps) {
  const { supplier: selected, selectSupplier, setStage } = useDemo();
  const [query, setQuery] = useState("");
  const [exported, setExported] = useState(false);
  const supplier = suppliers.find((s) => s.id === selected);
  const visible = suppliers.filter((s) =>
    `${s.name} ${s.country} ${s.component}`.toLowerCase().includes(query.toLowerCase()),
  );
  const exportGraph = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(demoExport, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "iphone-17-pro-supply-network.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExported(true);
  };
  return (
    <section className="network-stage stage-enter" aria-labelledby="network-title">
      <GlobeScene />
      <div className="stage-heading">
        <button className="back-link" onClick={() => setStage("bom")}>
          <ArrowLeft size={13} />
          The components
        </button>
        <p className="eyebrow">03 / A WORLD OF CONNECTIONS</p>
        <h1 id="network-title" ref={headingRef} tabIndex={-1}>
          Made of parts.
          <br />
          <span>Connected by a world.</span>
        </h1>
        <p>Follow the companies behind the components.</p>
      </div>
      <div className="supplier-panel">
        <div className="panel-label">
          <span>THE SUPPLIER NETWORK</span>
          <span>06</span>
        </div>
        <div className="supplier-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a connection"
            aria-label="Find a supplier"
          />
          {query && (
            <button aria-label="Clear supplier search" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="supplier-list" aria-label="Suppliers">
          {visible.map((item, i) => (
            <button
              className={`supplier-row ${selected === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => selectSupplier(selected === item.id ? null : item.id)}
              aria-pressed={selected === item.id}
              style={
                { "--delay": `${i * 90 + 200}ms`, "--part-color": item.color } as CSSProperties
              }
            >
              <span className="supplier-dot" />
              <span className="supplier-name">
                {item.name}
                <small>{item.component}</small>
              </span>
              <span className="country-code">{item.code}</span>
              <ChevronRight size={13} />
            </button>
          ))}
          {!visible.length && (
            <p className="no-suppliers">
              No matching connections.
              <button onClick={() => setQuery("")}>
                Show all suppliers <ArrowRight size={12} />
              </button>
            </p>
          )}
        </div>
        <div className="network-counts">
          <div>
            <strong>6</strong>
            <span>Companies</span>
          </div>
          <div>
            <strong>6</strong>
            <span>Countries</span>
          </div>
          <div>
            <strong>5</strong>
            <span>Connections</span>
          </div>
        </div>
      </div>
      {supplier ? (
        <aside className="supplier-inspector" aria-label="Supplier details" key={supplier.id}>
          <div className="inspector-heading">
            <span className="eyebrow">{supplier.category.toUpperCase()}</span>
            <button
              className="icon-button"
              aria-label="Close supplier details"
              onClick={() => selectSupplier(null)}
            >
              <X size={16} />
            </button>
          </div>
          <h2>{supplier.name}</h2>
          <p className="inspector-location">
            <span style={{ background: supplier.color }} />
            {supplier.city}, {supplier.country}
          </p>
          <div className="inspector-component">
            <Cpu size={18} />
            <div>
              {supplier.component}
              <small>Identified component</small>
            </div>
          </div>
          <p>{supplier.detail}</p>
          <div className="inspector-links">
            <a href={supplier.source} target="_blank" rel="noreferrer">
              Component source
              <ArrowUpRight size={12} />
            </a>
            <a href={supplier.locationSource} target="_blank" rel="noreferrer">
              Company location
              <ArrowUpRight size={12} />
            </a>
          </div>
        </aside>
      ) : (
        <div className="network-floating-caption">
          <span className="micro-label">A GLOBAL PERSPECTIVE</span>
          <p>
            Small components.
            <br />
            <span>Far-reaching connections.</span>
          </p>
          <div>
            <i />
            Select a company to follow its connection
          </div>
        </div>
      )}
      <div className="network-bottom">
        <div className="map-legend">
          <span>
            <i />
            Supplier headquarters
          </span>
          <span>
            <i className="legend-line" />
            Illustrative relationship
          </span>
          <p>Locations show headquarters, not factories or shipping routes.</p>
        </div>
        <button className="secondary-button" onClick={exportGraph}>
          <ArrowDownToLine size={15} />
          {exported ? "Export again" : "Export network"}
        </button>
      </div>
    </section>
  );
}
