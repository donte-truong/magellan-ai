"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { MagellanMark as Mark } from "@/components/magellan-mark";
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
  GitFork,
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
import { demoExport, parts, suppliers as curatedSuppliers } from "@/lib/demo-data";
import {
  downloadDemoGraph,
  loadDemoGraph,
  loadFullDemoGraph,
  sitesToSuppliers,
  summarize,
  type DemoSite,
} from "@/lib/demo-graph";
import { kindLabels, nodeColors } from "@/lib/graph-layout";
import { useDemo, type DemoStage } from "@/lib/demo-store";
import { AskPanel } from "./ask-panel";
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
const NetworkGraph = dynamic(
  () => import("@/components/network-view").then((module) => module.NetworkGraph),
  {
    ssr: false,
    loading: () => (
      <div className="scene-loading">
        <span />
        Laying out the graph
      </div>
    ),
  },
);
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

export function Experience() {
  const { stage, started, paused, graphState, setStage, togglePaused } = useDemo();
  const [info, setInfo] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const navigate = () => {
      const next = window.location.hash.slice(1);
      useDemo.getState().setStage(next === "bom" || next === "network" ? next : "input");
    };
    // Read the URL before subscribing. An effect from the initial "input" render
    // must never erase a deep link arriving while the page is hydrating.
    navigate();
    const unsubscribe = useDemo.subscribe((state, previous) => {
      if (state.stage === previous.stage) return;
      const url = new URL(window.location.href);
      url.hash = state.stage === "input" ? "" : state.stage;
      window.history.replaceState(window.history.state, "", url);
    });
    window.addEventListener("hashchange", navigate);
    return () => {
      unsubscribe();
      window.removeEventListener("hashchange", navigate);
    };
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
    if (stage !== "input") heading.current?.focus({ preventScroll: true });
  }, [stage]);
  useEffect(() => {
    if (info) dialog.current?.showModal();
    else dialog.current?.close();
  }, [info]);
  useEffect(() => {
    // The generated research graph replaces the curated placeholder once it loads. The loader
    // caches its promise, so React's development double-mount does not fetch twice.
    let mounted = true;
    if (useDemo.getState().graphState === "placeholder")
      useDemo.getState().setGraphState("loading");
    void loadDemoGraph().then((data) => {
      if (!mounted) return;
      if (!data || !data.sites.sites.length) {
        useDemo.getState().setGraphState("unavailable");
        return;
      }
      const records = sitesToSuppliers(data.sites, curatedSuppliers[0]);
      useDemo.getState().setGraph(records, summarize(data.index, data.sites, records));
      useDemo.getState().setLive(data.index.graph_id, null);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className={`experience stage-${stage} ${paused ? "motion-paused" : ""}`}>
      <a className="experience-skip" href="#experience-main">
        Skip to exploration
      </a>
      <header className="experience-header">
        <Link className="experience-brand" href="/home" aria-label="Magellan home">
          <Mark />
          <span>Magellan</span>
        </Link>
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
            {graphState === "generated" ? "Generated graph" : "Curated demo"}
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

/** Read a relation from the picked node's side: "part of X" going out, "contains X" coming in. */
function relationText(predicate: string, outgoing: boolean) {
  const words: Record<string, [string, string]> = {
    PART_OF: ["part of", "contains"],
    INPUT_TO: ["input to", "uses"],
    MANUFACTURES: ["manufactures", "made by"],
    PRODUCES: ["produces", "produced by"],
    SUPPLIES: ["supplies", "supplied by"],
    OPERATES: ["operates", "operated by"],
    LOCATED_IN: ["located in", "site of"],
    OWNED_BY: ["owned by", "owns"],
    PROCESSED_BY: ["processed by", "processes"],
  };
  const pair = words[predicate] ?? [
    predicate.toLowerCase().replace(/_/g, " "),
    predicate.toLowerCase().replace(/_/g, " "),
  ];
  return outgoing ? pair[0] : pair[1];
}

function NetworkStage({ headingRef }: HeadingProps) {
  const {
    supplier: selected,
    selectSupplier,
    setStage,
    suppliers,
    summary,
    graphState,
    view,
    setView,
    graphNode,
    selectGraphNode,
    fullGraph,
    setFullGraph,
  } = useDemo();
  const [query, setQuery] = useState("");
  const [exported, setExported] = useState(false);
  const [graphFailed, setGraphFailed] = useState(false);
  const supplier = suppliers.find((s) => s.id === selected);
  const site = supplier && "role" in supplier ? (supplier as DemoSite) : null;
  const generatedGraph = graphState === "generated";
  useEffect(() => {
    // The full export (nodes, edges, claims) is fetched only when the graph view is opened.
    if (view !== "graph" || fullGraph || !generatedGraph) return;
    let mounted = true;
    void loadFullDemoGraph().then((graph) => {
      if (!mounted) return;
      if (graph) setFullGraph(graph);
      else setGraphFailed(true);
    });
    return () => {
      mounted = false;
    };
  }, [view, fullGraph, generatedGraph, setFullGraph]);
  const pickNode = (edge: string | null, node?: string | null) => {
    const id = node ?? null;
    selectGraphNode(id);
    // A located site is the same entity on both views: picking it opens the pin's inspector.
    selectSupplier(id && suppliers.some((s) => s.id === id) ? id : null);
  };
  const pickedNode =
    view === "graph" && fullGraph && graphNode && !supplier
      ? (fullGraph.nodes.find((n) => n.id === graphNode) ?? null)
      : null;
  const pickedRelations = pickedNode
    ? fullGraph!.edges.filter(
        (e) => e.source_node_id === pickedNode.id || e.target_node_id === pickedNode.id,
      )
    : [];
  const visible = suppliers.filter((s) =>
    `${s.name} ${s.city} ${s.country} ${s.component} ${s.category}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const generated = graphState === "generated" && summary;
  const counts = generated
    ? [
        [summary.organizations + summary.plants, "Sites"],
        [summary.countries, "Countries"],
        [summary.connections, "Connections"],
      ]
    : [
        [6, "Companies"],
        [6, "Countries"],
        [5, "Connections"],
      ];
  const exportGraph = async () => {
    let blob: Blob;
    try {
      blob = generated
        ? await downloadDemoGraph()
        : new Blob([JSON.stringify(demoExport, null, 2)], { type: "application/json" });
    } catch {
      blob = new Blob([JSON.stringify(demoExport, null, 2)], { type: "application/json" });
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "iphone-17-pro-supply-network.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExported(true);
  };
  return (
    <section className={`network-stage stage-enter view-${view}`} aria-labelledby="network-title">
      {view === "globe" ? (
        <GlobeScene />
      ) : (
        <div className="demo-graph-view">
          {fullGraph ? (
            <NetworkGraph
              graph={fullGraph}
              selectedNode={graphNode}
              selectedEdge={null}
              inspect={pickNode}
            />
          ) : (
            <div className="scene-loading">
              <span />
              {graphFailed ? "The graph export is unavailable" : "Loading the graph"}
            </div>
          )}
        </div>
      )}
      {generatedGraph && (
        <div className="view-toggle" role="group" aria-label="Network view">
          <button aria-pressed={view === "globe"} onClick={() => setView("globe")}>
            <Globe2 size={14} /> Globe
          </button>
          <button aria-pressed={view === "graph"} onClick={() => setView("graph")}>
            <GitFork size={14} /> Graph
          </button>
        </div>
      )}
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
        <p>
          {generated
            ? `${summary.nodes} entities and ${summary.edges} verified relations, researched from public sources.`
            : "Follow the companies behind the components."}
        </p>
      </div>
      <div className="supplier-panel">
        <div className="panel-label">
          <span>THE SUPPLIER NETWORK</span>
          <span>{String(suppliers.length - 1).padStart(2, "0")}</span>
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
                <small>
                  <span className="supplier-city">{item.city}</span> · {item.component}
                </small>
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
          {counts.map(([value, label]) => (
            <div key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
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
          <dl className="location-facts">
            <div>
              <dt>Location type</dt>
              <dd>
                {site
                  ? site.role === "plant"
                    ? `Plant · ${site.precision} precision`
                    : `Company office · ${site.precision} precision`
                  : "Company headquarters"}
              </dd>
            </div>
            {site && site.share !== null && (
              <div>
                <dt>Share</dt>
                <dd>
                  {Math.round(site.share * 100)}%
                  {site.shareBasis === "stated" ? " · stated in a source" : " · labelled prior"}
                </dd>
              </div>
            )}
            <div>
              <dt>Coordinates</dt>
              <dd>
                {Math.abs(supplier.lat).toFixed(2)}° {supplier.lat >= 0 ? "N" : "S"}
                {" / "}
                {Math.abs(supplier.lon).toFixed(2)}° {supplier.lon >= 0 ? "E" : "W"}
              </dd>
            </div>
          </dl>
          <div className="inspector-component">
            <Cpu size={18} />
            <div>
              {supplier.component}
              <small>
                {site && site.makes.length > 1
                  ? `${site.makes.length} verified relations`
                  : site
                    ? "Verified relation"
                    : "Identified component"}
              </small>
            </div>
          </div>
          <p>{supplier.detail}</p>
          <div className="inspector-links">
            {site ? (
              site.sources.slice(0, 3).map((url, i) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  {i === 0 ? "Evidence" : new URL(url).hostname.replace(/^www\./, "")}
                  <ArrowUpRight size={12} />
                </a>
              ))
            ) : (
              <>
                <a href={supplier.source} target="_blank" rel="noreferrer">
                  Component source
                  <ArrowUpRight size={12} />
                </a>
                <a href={supplier.locationSource} target="_blank" rel="noreferrer">
                  Company location
                  <ArrowUpRight size={12} />
                </a>
              </>
            )}
          </div>
        </aside>
      ) : pickedNode ? (
        <aside className="supplier-inspector" aria-label="Entity details" key={pickedNode.id}>
          <div className="inspector-heading">
            <span className="eyebrow">{kindLabels[pickedNode.kind].toUpperCase()}</span>
            <button
              className="icon-button"
              aria-label="Close entity details"
              onClick={() => pickNode(null, null)}
            >
              <X size={16} />
            </button>
          </div>
          <h2>{pickedNode.label}</h2>
          <p className="inspector-location">
            <span style={{ background: nodeColors[pickedNode.kind] }} />
            {pickedNode.tier === null
              ? "Outside the tiered bill of materials"
              : `Tier ${pickedNode.tier}`}
          </p>
          <dl className="location-facts">
            <div>
              <dt>Support</dt>
              <dd>{pickedNode.status.replace(/_/g, " ")}</dd>
            </div>
            {pickedNode.external_ids?.mpn && (
              <div>
                <dt>Part number</dt>
                <dd>{pickedNode.external_ids.mpn}</dd>
              </div>
            )}
            {pickedNode.external_ids?.manufacturer && (
              <div>
                <dt>Maker</dt>
                <dd>{pickedNode.external_ids.manufacturer}</dd>
              </div>
            )}
          </dl>
          <div className="inspector-component">
            <GitFork size={18} />
            <div>
              {pickedRelations.length} verified{" "}
              {pickedRelations.length === 1 ? "relation" : "relations"}
              <small>
                {pickedRelations
                  .slice(0, 4)
                  .map((e) => {
                    const outgoing = e.source_node_id === pickedNode.id;
                    const other = outgoing ? e.target_node_id : e.source_node_id;
                    const label = fullGraph!.nodes.find((n) => n.id === other)?.label ?? "";
                    return `${relationText(e.predicate, outgoing)} ${label}`;
                  })
                  .join(" · ")}
              </small>
            </div>
          </div>
          {pickedNode.aliases && pickedNode.aliases.length > 0 && (
            <p>Also named {pickedNode.aliases.slice(0, 4).join(", ")}.</p>
          )}
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
      {generatedGraph && <AskPanel />}
      <div className="network-bottom">
        <div className="map-legend">
          <span>
            <i />
            {generated ? "Plants and company offices" : "Supplier headquarters"}
          </span>
          <span>
            <i className="legend-line" />
            {generated ? "Verified relation to the product" : "Illustrative relationship"}
          </span>
          <p>
            {generated
              ? "Every pin carries its evidence; coordinates are labelled by precision and never a guess."
              : "Locations show headquarters, not factories or shipping routes."}
          </p>
        </div>
        <button className="secondary-button" onClick={exportGraph}>
          <ArrowDownToLine size={15} />
          {exported ? "Export again" : "Export network"}
        </button>
      </div>
    </section>
  );
}
