import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchFailureNotice } from "@/components/research-failure-notice";
import { api } from "@/lib/api";
import { researchFailure } from "@/lib/research-failure";
import { useWorkspace, visibleGraph } from "@/lib/store";
import type { Run } from "@/lib/types";
import { bom, graph, run } from "./fixtures";

const failed: Run = {
  ...run,
  provider: "live",
  stop_reason: "provider_quota_exhausted",
};
const continued: Run = {
  ...run,
  id: "run_retry",
  status: "queued",
  mode: "followup",
  stop_reason: null,
};

beforeEach(() => {
  useWorkspace.getState().reset();
  useWorkspace.getState().begin(failed);
  useWorkspace.getState().update(useWorkspace.getState().generation, failed, graph, bom);
});

describe("research failure feedback", () => {
  it.each([
    ["source_unavailable", "could not retrieve its sources"],
    ["provider_quota_exhausted", "usage limit"],
    ["provider_rate_limited", "too many requests"],
    ["provider_auth_failed", "rejected access"],
    ["provider_model_unavailable", "model is unavailable"],
    ["provider_request_invalid", "rejected the configured model or request parameters"],
    ["provider_unavailable", "could not reach"],
    ["provider_timeout", "too long"],
    ["model_output_invalid", "could not be validated"],
  ])("explains %s without reporting a successful empty exploration", (reason, explanation) => {
    render(<ResearchFailureNotice run={{ ...failed, stop_reason: reason }} graph={graph} />);
    expect(screen.getByRole("alert")).toHaveTextContent(explanation);
    expect(screen.getByRole("alert")).toHaveTextContent("existing findings are saved");
    expect(screen.getByRole("link", { name: /Open iPhone Demo/ })).toHaveAttribute("href", "/demo");
  });

  it("recognizes persisted legacy failures without treating evidence gaps as provider failures", () => {
    expect(
      researchFailure({
        ...failed,
        stop_reason: "source_unavailable",
        open_questions: ["Research provider failed or returned invalid data"],
      }),
    ).not.toBeNull();
    expect(researchFailure({ ...run, stop_reason: "research_exhausted" })).toBeNull();
    expect(researchFailure({ ...run, stop_reason: "budget_limit" })).toBeNull();
    expect(researchFailure({ ...run, stop_reason: "max_documents" })).toBeNull();
    expect(researchFailure({ ...failed, status: "running" })).toBeNull();
  });

  it("makes an empty graph failure explicit and retries without losing existing graph data", async () => {
    const followup = vi.spyOn(api, "followup").mockResolvedValue(continued);
    render(<ResearchFailureNotice run={failed} graph={{ ...graph, edges: [] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("No supply chain connections were added");
    fireEvent.click(screen.getByRole("button", { name: "Retry Research" }));
    await waitFor(() => expect(useWorkspace.getState().run).toBe(continued));
    expect(followup).toHaveBeenCalledWith(
      graph.id,
      expect.stringContaining(run.product),
      undefined,
      undefined,
      expect.any(String),
    );
    expect(visibleGraph(useWorkspace.getState())).toBe(graph);
    expect(useWorkspace.getState().agentBusy).toBe(false);
  });

  it("preserves the original follow-up instruction and idempotency key after a transport failure", async () => {
    const instruction = "Find the chip packaging facilities";
    const followup = vi
      .spyOn(api, "followup")
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(continued);
    render(<ResearchFailureNotice run={{ ...failed, instruction }} graph={graph} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry Research" }));
    expect(await screen.findByText("Connection interrupted")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry Research" }));
    await waitFor(() => expect(useWorkspace.getState().run).toBe(continued));
    expect(followup.mock.calls[0][1]).toBe(instruction);
    expect(followup.mock.calls[1][4]).toBe(followup.mock.calls[0][4]);
  });

  it("ignores a late retry after navigation and leaves another graph's active request alone", async () => {
    let finish!: (result: Run) => void;
    const followup = vi.spyOn(api, "followup").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<ResearchFailureNotice run={failed} graph={graph} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Restarting Research…" }));
    expect(followup).toHaveBeenCalledTimes(1);
    const other = { ...run, id: "run_other", graph_id: "g_other" };
    act(() => {
      useWorkspace.getState().begin(other);
      useWorkspace.setState({ agentBusy: true });
    });
    await act(async () => finish(continued));
    expect(useWorkspace.getState().run).toBe(other);
    expect(useWorkspace.getState().agentBusy).toBe(true);
  });

  it("blocks recovery while an assistant action is pending or another scenario is displayed", () => {
    useWorkspace.setState({ agentBusy: true });
    const view = render(<ResearchFailureNotice run={failed} graph={graph} />);
    expect(screen.getByRole("button", { name: "Retry Research" })).toBeDisabled();
    act(() => useWorkspace.setState({ agentBusy: false }));
    view.rerender(<ResearchFailureNotice run={failed} graph={{ ...graph, id: "g_scenario" }} />);
    expect(screen.getByRole("button", { name: "Retry Research" })).toBeDisabled();
  });

  it("releases its action lock on unmount without unlocking a later request", async () => {
    let finish!: (result: Run) => void;
    vi.spyOn(api, "followup").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<ResearchFailureNotice run={failed} graph={graph} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry Research" }));
    expect(useWorkspace.getState().agentBusy).toBe(true);
    view.unmount();
    expect(useWorkspace.getState().agentBusy).toBe(false);
    useWorkspace.setState({ agentBusy: true });
    await act(async () => finish(continued));
    expect(useWorkspace.getState().run).toBe(failed);
    expect(useWorkspace.getState().agentBusy).toBe(true);
  });
});
