"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  Clock3,
  Compass,
  FileText,
  Layers3,
  LoaderCircle,
  Network,
  Plus,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/store";
import { useResearch } from "@/lib/use-research";
import { isActive, type Run } from "@/lib/types";
import { BOMView } from "./bom-view";
import { EvidencePanel } from "./evidence-panel";
import { ProductForm } from "./product-form";
import { Brand, ErrorNotice, Spinner, Stepper } from "./ui";

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
  const [showInfo, setShowInfo] = useState(false);
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
    setActionError(null);
    useWorkspace.getState().begin(run);
  }
  function newExploration() {
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
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to exploration
      </a>
      <aside className="sidebar">
        <button className="brand-link" onClick={newExploration} aria-label="Magellan home">
          <Brand />
        </button>
        <div className="workspace-label">
          <span className="workspace-avatar">M</span>
          <span>
            My workspace<small>Product research</small>
          </span>
          <ShieldCheck size={15} />
        </div>
        <div className="sidebar-section-label">WORKSPACE</div>
        <button
          className="sidebar-nav active"
          onClick={() => (run ? setStage("bom") : newExploration())}
        >
          <Compass size={18} />
          Explorations<span>{recent.length || ""}</span>
        </button>
        <button className="new-exploration" onClick={newExploration}>
          <Plus size={16} />
          New exploration
        </button>
        <div className="recent-heading">
          <span className="sidebar-section-label">RECENT EXPLORATIONS</span>
          <Clock3 size={13} />
        </div>
        <div className="recent-list">
          {recent.slice(0, 4).map((item) => (
            <button
              key={item.id}
              className={run?.id === item.id ? "recent-active" : ""}
              onClick={() => openRecent(item)}
            >
              <Box size={15} />
              <span>
                {item.product}
                <small>
                  {isActive(item.status)
                    ? "Research in progress"
                    : item.status === "cancelled"
                      ? "Research stopped"
                      : "Saved exploration"}
                </small>
              </span>
              {isActive(item.status) ? (
                <span className="status-dot pulse" />
              ) : (
                <ChevronRight size={13} />
              )}
            </button>
          ))}
          {recent.length === 0 && !recentError && (
            <p className="sidebar-empty">
              Your explorations will
              <br />
              find a home here.
            </p>
          )}
          {recentError && (
            <button className="recent-retry" onClick={() => setRecentRetry((v) => v + 1)}>
              Reconnect to recent explorations <ArrowRight size={13} />
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="sidebar-note-icon">
              <ShieldCheck size={18} />
            </span>
            <strong>Clarity, with receipts.</strong>
            <p>
              Every connection leads back
              <br />
              to the evidence behind it.
            </p>
          </div>
          <button className="about-button" onClick={() => setShowInfo(true)}>
            <span className="help-icon">?</span>About this workspace
            <ArrowRight size={14} />
          </button>
          <div className="sidebar-footer">
            <span className="status-dot" />
            PUBLIC-SOURCE INTELLIGENCE
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand compact />
          </div>
          <div className="breadcrumb">
            <Compass size={15} />
            <span>Explorations</span>
            <ChevronRight size={13} />
            <strong>{run?.product ?? "New exploration"}</strong>
          </div>
          <span className="workspace-status">
            <span className="status-dot" />
            Research workspace
          </span>
          <button
            className="mobile-new icon-button"
            onClick={newExploration}
            aria-label="New exploration"
          >
            <Plus size={18} />
          </button>
        </header>
        <main
          id="main-content"
          className={`main-content ${stage !== "input" ? "results-content" : ""}`}
        >
          <div className="page-topline">
            <span className="section-kicker">
              <Compass size={15} />
              SUPPLY CHAIN EXPLORER
            </span>
            <span className="mvp-label">An open view of what’s inside</span>
          </div>
          <Stepper
            step={stage === "input" ? 0 : stage === "bom" ? 1 : 2}
            canNavigate={Boolean(graph)}
            onChange={(index) => setStage(index === 0 ? "input" : index === 1 ? "bom" : "network")}
          />
          {actionError && <ErrorNotice message={actionError} />}
          {stage === "input" ? (
            <ProductForm />
          ) : (
            run && (
              <>
                <div className="product-header">
                  <div className="product-heading-group">
                    <button
                      className="icon-button back-button"
                      onClick={stage === "network" ? () => setStage("bom") : newExploration}
                      aria-label={
                        stage === "network"
                          ? "Back to bill of materials"
                          : "Start a new exploration"
                      }
                    >
                      <ArrowLeft size={19} />
                    </button>
                    <span className="product-avatar">
                      <Box size={27} />
                    </span>
                    <div>
                      <div className="product-header-eyebrow">EXPLORING THE SUPPLY CHAIN</div>
                      <h1>{run.product}</h1>
                      {run.company && <p>{run.company}</p>}
                    </div>
                  </div>
                  <div className="product-header-actions">
                    {run.provider === "curated_fixture" && (
                      <span
                        className="fixture-badge"
                        title="This exploration uses a curated set of public-source excerpts."
                      >
                        Curated example
                      </span>
                    )}
                    {run.mode === "replay" && <span className="fixture-badge">Replay</span>}
                    <button
                      className="button button-secondary export-button"
                      onClick={download}
                      disabled={!graph || action === "export"}
                    >
                      <ArrowDownToLine size={15} />
                      {action === "export" ? "Exporting…" : "Export JSON"}
                    </button>
                  </div>
                </div>
                <div
                  className={`research-status ${run.status === "failed" ? "research-failed" : ""}`}
                  aria-live="polite"
                >
                  <span className="research-status-icon">
                    {active ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : run.status === "failed" ? (
                      <X size={17} />
                    ) : (
                      <Check size={17} />
                    )}
                  </span>
                  <div>
                    <strong>
                      {run.status === "awaiting_input"
                        ? "A quick clarification before we continue"
                        : active
                          ? "Following sources and connecting the parts"
                          : run.status === "failed"
                            ? "Research couldn’t finish"
                            : run.status === "cancelled"
                              ? "Research stopped. Your findings are saved."
                              : "Exploration ready. Every finding has a source."}
                    </strong>
                    <span>
                      {active
                        ? `${run.usage.documents} documents examined · New findings appear automatically`
                        : run.status === "partial"
                          ? "Some branches remain unresolved. Review the open questions below."
                          : "Select a component or a connection to look closer."}
                    </span>
                  </div>
                  {active && (
                    <button
                      className="text-button cancel-button"
                      onClick={cancel}
                      disabled={Boolean(action)}
                    >
                      <Square size={12} />
                      {action === "cancel" ? "Stopping…" : "Stop research"}
                    </button>
                  )}
                </div>
                {syncError && <ErrorNotice message={syncError} retry={refresh} />}
                {run.pending_questions.map((question) => (
                  <section className="clarification-card" key={question.question_id}>
                    <h2>{question.prompt}</h2>
                    <div>
                      {question.choices.map((choice) => (
                        <button
                          className="button button-secondary"
                          key={choice.id}
                          onClick={() => answer(question.question_id, choice.id)}
                          disabled={Boolean(action)}
                        >
                          {choice.label}
                          <ArrowRight size={15} />
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
                <div className="view-tabs" aria-label="Exploration views">
                  <button
                    onClick={() => setStage("bom")}
                    aria-pressed={stage === "bom"}
                    className={stage === "bom" ? "active" : ""}
                  >
                    <Layers3 size={16} />
                    Bill of materials{graph && <span>{bom?.items.length ?? 0}</span>}
                  </button>
                  <button
                    onClick={() => setStage("network")}
                    disabled={!graph}
                    aria-pressed={stage === "network"}
                    className={stage === "network" ? "active" : ""}
                  >
                    <Network size={16} />
                    Network overlay
                  </button>
                  <span className="revision-label">
                    {graph ? `REV ${String(graph.revision).padStart(2, "0")}` : "CONNECTING"}
                  </span>
                </div>
                <div className={`exploration-layout ${hasInspector ? "with-inspector" : ""}`}>
                  <div className="exploration-main">
                    {stage === "bom" ? <BOMView /> : <NetworkView />}
                  </div>
                  {hasInspector && <EvidencePanel />}
                </div>
              </>
            )
          )}
          <footer className="main-footer">
            <span>Magellan</span>
            <p>Follow the parts. Find the bigger picture.</p>
            <span>
              Built on public evidence <ShieldCheck size={12} />
            </span>
          </footer>
        </main>
      </div>
      {showInfo && <AboutDialog close={() => setShowInfo(false)} />}
    </div>
  );
}

function AboutDialog({ close }: { close: () => void }) {
  useEffect(() => {
    const dialog = document.querySelector<HTMLDialogElement>("#about-dialog");
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      id="about-dialog"
      className="about-dialog"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="about-dialog-heading">
        <Brand />
        <button className="icon-button" onClick={close} aria-label="Close about dialog" autoFocus>
          <X size={20} />
        </button>
      </div>
      <span className="eyebrow">A LITTLE CONTEXT</span>
      <h2>Explore what you can verify.</h2>
      <p>
        Magellan turns a product name into an evidence-backed bill of materials and an explorable
        supply network.
      </p>
      <div className="about-feature">
        <FileText size={20} />
        <p>
          <strong>Sources, not certainty.</strong> Claims carry exact source excerpts and support
          labels. A gap in evidence is an open question.
        </p>
      </div>
      <div className="about-feature">
        <ShieldCheck size={20} />
        <p>
          <strong>A clear starting point.</strong> The Raspberry Pi 5 example uses curated
          manufacturer sources. Other products depend on the research sources available to this
          workspace.
        </p>
      </div>
      <button className="button button-primary" onClick={close}>
        Let’s explore
        <ArrowRight size={16} />
      </button>
    </dialog>
  );
}
