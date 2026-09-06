"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  ChevronRight,
  Clock3,
  Compass,
  FileText,
  GitBranch,
  Layers3,
  LoaderCircle,
  Menu,
  Plus,
  ShieldCheck,
  Square,
} from "lucide-react";
import { MagellanMark } from "./magellan-mark";
import { api, errorMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/store";
import { useResearch } from "@/lib/use-research";
import { isActive, type Run } from "@/lib/types";
import { BOMView } from "./bom-view";
import { EvidencePanel } from "./evidence-panel";
import { ProductForm } from "./product-form";
import { ErrorNotice, Spinner } from "./ui";

const NetworkView = dynamic(() => import("./network-view").then((module) => module.NetworkView), {
  ssr: false,
  loading: () => (
    <div className="network-loading">
      <Spinner label="Opening the network" />
    </div>
  ),
});

export function Workspace() {
  const { stage, run, graph, bom, selectedEdge, selectedNode, setStage, reset } = useWorkspace();
  const { error: syncError, refresh } = useResearch();
  const [recent, setRecent] = useState<Run[]>([]);
  const [recentError, setRecentError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [recentRetry, setRecentRetry] = useState(0);
  const active = isActive(run?.status);
  const hasInspector = Boolean(graph && (selectedEdge || selectedNode));

  useEffect(() => {
    const controller = new AbortController();
    api
      .recent(controller.signal)
      .then(({ items }) => {
        setRecent(items);
        setRecentError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRecentError(true);
      });
    return () => controller.abort();
  }, [run?.id, run?.status, recentRetry]);

  useEffect(() => {
    if (window.location.pathname === "/" && ["#network", "#bom"].includes(window.location.hash)) {
      window.location.replace(`/demo${window.location.hash}`);
      return;
    }
    const runId = new URL(window.location.href).searchParams.get("run");
    if (!runId || !/^run_[a-zA-Z0-9_-]+$/.test(runId)) return;
    const controller = new AbortController();
    const generation = useWorkspace.getState().generation;
    api
      .run(runId, controller.signal)
      .then((run) => {
        if (!controller.signal.aborted && useWorkspace.getState().generation === generation)
          useWorkspace.getState().begin(run);
      })
      .catch((error) => {
        if (!controller.signal.aborted && useWorkspace.getState().generation === generation)
          setActionError(errorMessage(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!run) return;
    const url = new URL(window.location.href);
    url.searchParams.set("run", run.id);
    window.history.replaceState({}, "", url);
  }, [run]);

  async function openRecent(run: Run) {
    setSidebarOpen(false);
    setActionError(null);
    useWorkspace.getState().begin(run);
  }
  function newExploration() {
    setSidebarOpen(false);
    reset();
    setActionError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("run");
    window.history.replaceState({}, "", url);
  }
  async function cancel() {
    if (!run || action) return;
    setAction("cancel");
    setActionError(null);
    try {
      await api.cancel(run.id);
      refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setAction(null);
    }
  }
  async function answer(question: string, choice: string) {
    if (!run || action) return;
    setAction("answer");
    setActionError(null);
    try {
      await api.answer(run.id, question, choice);
      refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setAction(null);
    }
  }
  async function download() {
    if (!graph || action) return;
    setAction("export");
    setActionError(null);
    try {
      const response = await fetch(
        `/api/backend/graphs/${graph.id}/export?revision=${graph.revision}`,
      );
      if (!response.ok) throw new Error("The export could not be downloaded. Please try again.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${run?.product.replace(/[^a-zA-Z0-9-]/g, "-") || "supply-network"}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setAction(null);
    }
  }

  return (
    <div className={`studio ${hasInspector ? "studio-inspecting" : ""}`}>
      <a className="experience-skip" href="#main-content">
        Skip to exploration
      </a>
      <header className="studio-header">
        <div className="studio-header-start">
          <button
            className="studio-icon studio-menu"
            aria-label="Toggle explorations"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Menu size={19} />
          </button>
          <Link className="experience-brand" href="/home" aria-label="Magellan home">
            <MagellanMark />
            <span>Magellan</span>
          </Link>
          <span className="studio-header-divider" />
          <span className="studio-header-label">Explorer</span>
        </div>
        <nav aria-label="Main navigation">
          <Link href="/home">Discover</Link>
          <Link href="/demo">
            iPhone Demo <ArrowUpRight size={13} />
          </Link>
        </nav>
        <div className="studio-workspace-badge">
          <span className="studio-status-dot" />
          Personal Workspace
        </div>
      </header>
      <div className="studio-body">
        {sidebarOpen && (
          <button
            className="studio-sidebar-scrim"
            aria-label="Close explorations"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside
          className={`studio-sidebar ${sidebarOpen ? "is-open" : ""}`}
          aria-label="Explorations"
        >
          <button className="studio-new" onClick={newExploration}>
            <Plus size={16} />
            New Exploration<span>↗</span>
          </button>
          <div className="studio-sidebar-label">
            <span>YOUR EXPLORATIONS</span>
            <Clock3 size={12} />
          </div>
          <div className="studio-recent">
            {recent.map((item) => (
              <button
                key={item.id}
                className={run?.id === item.id ? "is-active" : ""}
                onClick={() => openRecent(item)}
              >
                <span className="studio-recent-icon">
                  <GitBranch size={16} />
                </span>
                <span>
                  <strong>{item.product}</strong>
                  <small>
                    {isActive(item.status)
                      ? "Researching"
                      : item.status === "cancelled"
                        ? "Stopped"
                        : new Date(item.created_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                  </small>
                </span>
                <ChevronRight size={12} />
              </button>
            ))}
            {!recent.length && !recentError && (
              <p className="studio-sidebar-empty">
                A place for everything
                <br />
                you discover.
              </p>
            )}
            {recentError && (
              <button className="studio-reconnect" onClick={() => setRecentRetry((v) => v + 1)}>
                Reconnect to explorations
                <ArrowRight size={14} />
              </button>
            )}
          </div>
          {run && graph && (
            <div className="studio-summary">
              <div className="studio-sidebar-label">IN THIS EXPLORATION</div>
              <div>
                <span>
                  <Box size={14} />
                  Entities
                </span>
                <strong>{graph.nodes.length}</strong>
              </div>
              <div>
                <span>
                  <GitBranch size={14} />
                  Connections
                </span>
                <strong>{graph.edges.length}</strong>
              </div>
              <div>
                <span>
                  <FileText size={14} />
                  Documents Read
                </span>
                <strong>{run.usage.documents}</strong>
              </div>
              <div>
                <span>
                  <Layers3 size={14} />
                  Supply Tiers
                </span>
                <strong>{graph.stats.max_tier}</strong>
              </div>
            </div>
          )}
          <div className="studio-sidebar-bottom">
            <Compass size={23} />
            <p>
              A little curiosity.
              <br />
              <span>A much bigger picture.</span>
            </p>
            <Link href="/demo">
              Take the guided demo
              <ArrowUpRight size={13} />
            </Link>
          </div>
        </aside>
        <main id="main-content" className={`studio-main ${run ? "has-research" : ""}`}>
          {actionError && <ErrorNotice message={actionError} />}
          {!run ? (
            <ProductForm />
          ) : (
            <>
              <div className="studio-research-heading">
                <div>
                  <span className="studio-eyebrow">SUPPLY CHAIN EXPLORATION</span>
                  <h1>{run.product}</h1>
                  {run.company && <p>{run.company}</p>}
                </div>
                <div className="studio-research-actions">
                  {run.provider === "curated_fixture" && (
                    <span className="studio-tag">Curated Example</span>
                  )}
                  {run.mode === "replay" && <span className="studio-tag">Replay</span>}
                  <button
                    className="studio-secondary"
                    onClick={download}
                    disabled={!graph || action === "export"}
                  >
                    <ArrowDownToLine size={15} />
                    <span>{action === "export" ? "Exporting…" : "Export JSON"}</span>
                  </button>
                </div>
              </div>
              <div className="studio-viewbar">
                <nav aria-label="Research views">
                  <button
                    className={stage === "network" ? "is-active" : ""}
                    aria-pressed={stage === "network"}
                    onClick={() => setStage("network")}
                  >
                    <GitBranch size={16} />
                    Network
                  </button>
                  <button
                    className={stage === "bom" ? "is-active" : ""}
                    aria-pressed={stage === "bom"}
                    onClick={() => setStage("bom")}
                  >
                    <Layers3 size={16} />
                    Bill of Materials<span>{bom?.items.length ?? 0}</span>
                  </button>
                </nav>
                <span className={`studio-run-status ${active ? "is-live" : ""}`} role="status">
                  {active ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : run.status === "completed" ? (
                    <Check size={13} />
                  ) : (
                    <span className="studio-status-dot" />
                  )}
                  {run.status === "awaiting_input"
                    ? "Needs Your Input"
                    : active
                      ? "Following Sources"
                      : run.status === "partial"
                        ? "Partial Findings"
                        : run.status === "failed"
                          ? "Research Interrupted"
                          : run.status === "cancelled"
                            ? "Research Stopped"
                            : "Research Complete"}
                  {active && (
                    <button onClick={cancel} disabled={Boolean(action)} aria-label="Stop research">
                      <Square size={12} />
                    </button>
                  )}
                </span>
              </div>
              {syncError && <ErrorNotice message={syncError} retry={refresh} />}
              {run.pending_questions.map((question) => (
                <section className="studio-clarification" key={question.question_id}>
                  <div>
                    <Compass size={21} />
                    <div>
                      <h2>A quick clarification before we continue</h2>
                      <p>{question.prompt}</p>
                    </div>
                  </div>
                  <div>
                    {question.choices.map((choice) => (
                      <button
                        className="studio-secondary"
                        key={choice.id}
                        disabled={Boolean(action)}
                        onClick={() => answer(question.question_id, choice.id)}
                      >
                        {choice.label}
                        <ArrowRight size={14} />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              <div className="studio-results">
                {stage === "bom" ? (
                  <BOMView />
                ) : graph ? (
                  <NetworkView />
                ) : (
                  <div className="studio-graph-loading">
                    <MagellanMark />
                    <Spinner label="Opening your exploration" />
                  </div>
                )}
              </div>
              {run.open_questions.length > 0 && (
                <details className="studio-questions">
                  <summary>
                    <span>
                      <ShieldCheck size={14} />
                      Open Questions<span>{run.open_questions.length}</span>
                    </span>
                    <ChevronRight size={15} />
                  </summary>
                  <ul>
                    {run.open_questions.map((question, i) => (
                      <li key={i}>{question}</li>
                    ))}
                  </ul>
                </details>
              )}
              <footer className="studio-result-footer">
                <span>
                  <ShieldCheck size={12} />
                  Built on public evidence
                </span>
                <span>
                  {graph?.nodes.length ?? 0} entities · {graph?.edges.length ?? 0} connections
                </span>
              </footer>
            </>
          )}
        </main>
        {hasInspector && <EvidencePanel />}
      </div>
    </div>
  );
}
