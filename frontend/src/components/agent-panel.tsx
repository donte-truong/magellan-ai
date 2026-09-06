"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  GitBranch,
  LoaderCircle,
  MessageCircle,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useWorkspace, visibleGraph } from "@/lib/store";
import { isActive, type AgentSelection, type ChatTurn } from "@/lib/types";
import { MagellanMark } from "./magellan-mark";

type Mode = "ask" | "research" | "edit";
type Reference = { id: string; label: string; kind: "node" | "edge" };
interface Message extends ChatTurn {
  id: string;
  mode: Mode;
  graphId: string;
  revision: number;
  references?: Reference[];
  context?: string;
  runId?: string;
  operations?: { applied: Record<string, unknown>[]; skipped: Record<string, unknown>[] };
}
const modes = {
  ask: {
    label: "Ask",
    icon: MessageCircle,
    placeholder: "Ask about this supply chain…",
    hint: "Answers grounded in your graph and its evidence.",
  },
  research: {
    label: "Research",
    icon: Search,
    placeholder: "What should we investigate next?",
    hint: "Follow public sources and add supported findings to this graph.",
  },
  edit: {
    label: "Edit Scenario",
    icon: GitBranch,
    placeholder: "Describe a change to the supply chain…",
    hint: "Changes apply to a hypothetical scenario. Your original stays intact.",
  },
};

export function AgentPanel({
  open,
  onClose,
  onInspect,
}: {
  open: boolean;
  onClose: () => void;
  onInspect: () => void;
}) {
  const graph = useWorkspace(visibleGraph)!;
  const { selectedNode, selectedEdge, run, generation, agentBusy } = useWorkspace();
  const [mode, setMode] = useState<Mode>("ask");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{
    mode: Mode;
    text: string;
    selection: AgentSelection;
    graphId: string;
    key: string;
  } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const selected = graph.nodes.find((n) => n.id === selectedNode);
  const edge = graph.edges.find((e) => e.id === selectedEdge);
  const selection: AgentSelection = {
    node_ids: [
      ...new Set([
        ...(selected ? [selected.id] : []),
        ...(edge ? [edge.source_node_id, edge.target_node_id] : []),
      ]),
    ],
    edge_ids: edge ? [edge.id] : [],
  };
  const contextLabel = edge
    ? `${selected?.label ?? "Connection"} · ${edge.predicate.replaceAll("_", " ").toLowerCase()}`
    : selected?.label;
  const modeInfo = modes[mode];
  const actionBlocked = mode !== "ask" && isActive(run?.status);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (busy.current) useWorkspace.setState({ agentBusy: false });
    };
  }, []);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "nearest" });
  }, [messages, pending, open]);

  async function send(
    text = draft,
    actionMode = mode,
    selectedContext = selection,
    retryKey?: string,
  ) {
    const content = text.trim();
    if (
      busy.current ||
      useWorkspace.getState().agentBusy ||
      content.length < 3 ||
      !graph ||
      (actionMode !== "ask" && isActive(run?.status))
    )
      return;
    busy.current = true;
    useWorkspace.setState({ agentBusy: true });
    setPending(actionMode);
    setError(null);
    setRetry(null);
    setDraft("");
    const controller = new AbortController();
    request.current = controller;
    const snapshot = graph;
    const capturedGeneration = generation;
    const key = retryKey ?? crypto.randomUUID();
    const current = () =>
      mounted.current &&
      !controller.signal.aborted &&
      useWorkspace.getState().generation === capturedGeneration;
    const base = { mode: actionMode, graphId: snapshot.id, revision: snapshot.revision };
    if (!retryKey)
      setMessages((items) => [
        ...items,
        { ...base, id: crypto.randomUUID(), role: "user", content, context: contextLabel },
      ]);
    const append = (message: Partial<Message> & Pick<Message, "content">) =>
      setMessages((items) => [
        ...items,
        { ...base, id: crypto.randomUUID(), role: "assistant", ...message },
      ]);
    try {
      if (actionMode === "ask") {
        const history = messages
          .filter((m) => m.mode === "ask")
          .slice(-8)
          .map(({ role, content }) => ({ role, content: content.slice(0, 4000) }));
        const answer = await api.chat(
          snapshot.id,
          content,
          snapshot.revision,
          selectedContext,
          history,
          controller.signal,
        );
        if (!current()) return;
        const references: Reference[] = [
          ...answer.node_ids.flatMap((id) => {
            const n = snapshot.nodes.find((n) => n.id === id);
            return n ? [{ id, label: n.label, kind: "node" as const }] : [];
          }),
          ...answer.edge_ids.flatMap((id) => {
            const e = snapshot.edges.find((e) => e.id === id);
            return e
              ? [
                  {
                    id,
                    kind: "edge" as const,
                    label: `${snapshot.nodes.find((n) => n.id === e.source_node_id)?.label ?? "Entity"} → ${snapshot.nodes.find((n) => n.id === e.target_node_id)?.label ?? "Entity"}`,
                  },
                ]
              : [];
          }),
        ];
        append({
          content: answer.content,
          references,
          context: answer.context_truncated
            ? "Answer uses a focused excerpt of this graph."
            : undefined,
        });
      } else if (actionMode === "research") {
        const next = await api.followup(
          snapshot.id,
          content,
          selectedContext.node_ids.length ? selectedContext.node_ids : undefined,
          undefined,
          key,
        );
        if (!current()) return;
        append({
          content:
            "Research started. New supported findings will appear in the graph as sources are reviewed.",
          runId: next.id,
        });
        useWorkspace.getState().continueRun(next);
      } else {
        let scenario = snapshot;
        if (scenario.mode !== "scenario") {
          const created = await api.createScenario(snapshot.id, `${snapshot.name} · What If`);
          scenario = await api.graph(created.id);
          if (!current()) return;
          useWorkspace.getState().viewScenario(scenario);
        }
        const result = await api.edit(scenario.id, content, scenario.revision, selectedContext);
        // The edit has committed; refresh the canvas before reporting success.
        const updated = await api.graph(scenario.id);
        if (!current()) return;
        useWorkspace.getState().viewScenario(updated);
        append({
          graphId: updated.id,
          revision: updated.revision,
          content: result.applied.length
            ? `Applied ${result.applied.length} ${result.applied.length === 1 ? "change" : "changes"} to your scenario.${result.skipped.length ? ` ${result.skipped.length} could not be applied.` : ""} Your original graph is unchanged.`
            : "No changes were applied. Try naming the exact entity and the change you want to make.",
          operations: { applied: result.applied, skipped: result.skipped },
        });
      }
    } catch (cause) {
      if (!current()) return;
      setError(errorMessage(cause));
      // Research is idempotent. Edits are never automatically retried after a transport failure.
      if (actionMode !== "edit")
        setRetry({
          mode: actionMode,
          text: content,
          selection: selectedContext,
          graphId: snapshot.id,
          key,
        });
      else setDraft(content);
    } finally {
      busy.current = false;
      if (mounted.current) useWorkspace.setState({ agentBusy: false });
      if (mounted.current) setPending(null);
    }
  }

  function inspect(reference: Reference, snapshotId: string) {
    if (graph.id !== snapshotId) return;
    if (reference.kind === "edge") {
      const relation = graph.edges.find((e) => e.id === reference.id);
      if (relation) useWorkspace.getState().inspect(relation.id, relation.source_node_id);
    } else if (graph.nodes.some((n) => n.id === reference.id))
      useWorkspace.getState().inspect(null, reference.id);
    onInspect();
  }

  const suggestions = selected
    ? ["What do we know about this entity?", "Where are the gaps in its evidence?"]
    : ["Walk me through this supply chain", "Which relationships need more evidence?"];
  return (
    <aside
      className="agent-panel"
      hidden={!open}
      aria-label="Magellan Assistant"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="agent-heading">
        <span className="agent-mark">
          <MagellanMark />
        </span>
        <div>
          <h2>Ask Magellan</h2>
          <p>
            <span /> Your graph, in conversation
          </p>
        </div>
        <button className="studio-icon" onClick={onClose} aria-label="Close assistant">
          <X size={17} />
        </button>
      </header>
      <div className="agent-context-bar">
        <GitBranch size={13} />
        <span>{graph.name}</span>
        <span>r{graph.revision}</span>
      </div>
      <div
        className="agent-messages"
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {!messages.length && (
          <div className="agent-welcome">
            <div className="agent-orbit" aria-hidden="true">
              <svg viewBox="0 0 160 160">
                <circle cx="80" cy="80" r="59" />
                <ellipse cx="80" cy="80" rx="76" ry="30" transform="rotate(-35 80 80)" />
                <circle className="agent-orbit-dot" cx="129" cy="47" r="3" />
              </svg>
              <Sparkles size={24} />
            </div>
            <span className="studio-eyebrow">A NEW PERSPECTIVE</span>
            <h3>Follow your curiosity.</h3>
            <p>
              Understand a connection.
              <br />
              Trace it further. Explore a what-if.
            </p>
            <div className="agent-suggestions">
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  disabled={agentBusy}
                  onClick={() => {
                    setMode("ask");
                    void send(prompt, "ask");
                  }}
                >
                  {prompt}
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`agent-message is-${message.role}`}>
            <div className="agent-message-author">
              {message.role === "assistant" ? (
                <>
                  <MagellanMark /> Magellan
                </>
              ) : (
                <>
                  You <span>{modes[message.mode].label}</span>
                </>
              )}
            </div>
            {message.role === "user" && message.context && (
              <span className="agent-message-context">
                <GitBranch size={11} />
                {message.context}
              </span>
            )}
            <p>{message.content}</p>
            {message.references && message.references.length > 0 && (
              <div className="agent-references" aria-label="Graph references">
                {message.references.map((reference) => {
                  const exists =
                    graph.id === message.graphId &&
                    (reference.kind === "node" ? graph.nodes : graph.edges).some(
                      (item) => item.id === reference.id,
                    );
                  return (
                    <button
                      key={`${reference.kind}-${reference.id}`}
                      disabled={!exists}
                      title={
                        exists
                          ? "Inspect graph evidence"
                          : "Reference belongs to a different graph or an earlier revision"
                      }
                      onClick={() => inspect(reference, message.graphId)}
                    >
                      <GitBranch size={11} />
                      {reference.label}
                      <ArrowUpRight size={11} />
                    </button>
                  );
                })}
              </div>
            )}
            {message.role === "assistant" && (
              <small className="agent-message-meta">
                {message.mode === "ask"
                  ? `Graph revision ${message.revision}`
                  : modes[message.mode].label}
                {message.context ? ` · ${message.context}` : ""}
              </small>
            )}
            {message.runId && (
              <div className="agent-action-result">
                <Search size={13} />
                <span>
                  {message.runId === run?.id
                    ? isActive(run.status)
                      ? "Following Sources"
                      : run.status === "completed"
                        ? "Research Complete"
                        : `Research ${run.status}`
                    : "Research submitted"}
                </span>
              </div>
            )}
            {message.operations && (
              <details className="agent-operations">
                <summary>
                  <Check size={13} />
                  {message.operations.applied.length} Applied · {message.operations.skipped.length}{" "}
                  Skipped
                  <ChevronDown size={12} />
                </summary>
                <ul>
                  {[
                    ...message.operations.applied.map((op) => ({ op, skipped: false })),
                    ...message.operations.skipped.map((op) => ({ op, skipped: true })),
                  ].map(({ op, skipped }, i) => (
                    <li key={i}>
                      <strong>
                        {skipped ? "Skipped: " : ""}
                        {String(op.op ?? "Change").replaceAll("_", " ")}
                      </strong>
                      <span>
                        {[op.label, op.new_label ? `→ ${op.new_label}` : op.object_label, op.reason]
                          .filter(Boolean)
                          .map(String)
                          .join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
        {pending && (
          <div className="agent-thinking" role="status">
            <LoaderCircle size={14} className="spin" />
            {pending === "ask"
              ? "Reading the connections…"
              : pending === "research"
                ? "Following your lead…"
                : "Shaping your scenario…"}
          </div>
        )}
        {error && (
          <div className="agent-error" role="alert">
            <p>{error}</p>
            {retry && retry.graphId === graph.id && (
              <button
                disabled={Boolean(pending) || agentBusy}
                onClick={() => void send(retry.text, retry.mode, retry.selection, retry.key)}
              >
                Try Again
              </button>
            )}
            {!retry && <small>Check the scenario before submitting another edit.</small>}
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {contextLabel && (
          <div className="agent-selection">
            <GitBranch size={12} />
            <span>{contextLabel}</span>
            <button
              type="button"
              aria-label="Clear assistant selection"
              onClick={() => useWorkspace.getState().inspect(null)}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="agent-modes" aria-label="Assistant mode">
          {(Object.keys(modes) as Mode[]).map((item) => {
            const Icon = modes[item].icon;
            return (
              <button
                type="button"
                key={item}
                disabled={Boolean(pending)}
                aria-pressed={mode === item}
                className={mode === item ? "is-active" : ""}
                onClick={() => setMode(item)}
              >
                <Icon size={12} />
                {modes[item].label}
              </button>
            );
          })}
        </div>
        <div className="agent-input-wrap">
          <textarea
            ref={input}
            aria-label="Message Magellan"
            placeholder={modeInfo.placeholder}
            maxLength={1000}
            value={draft}
            rows={3}
            disabled={Boolean(pending)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="agent-send"
            type="submit"
            aria-label={
              mode === "ask"
                ? "Send message"
                : mode === "research"
                  ? "Start follow-up research"
                  : "Apply scenario edit"
            }
            disabled={Boolean(pending) || agentBusy || draft.trim().length < 3 || actionBlocked}
          >
            <ArrowUp size={17} />
          </button>
        </div>
        <p className="agent-composer-note">
          {actionBlocked
            ? "Wait for the current research to finish, or stop it first."
            : modeInfo.hint}
        </p>
      </form>
    </aside>
  );
}
