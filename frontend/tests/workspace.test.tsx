import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductForm } from "@/components/product-form";
import { BOMView } from "@/components/bom-view";
import { api, safeSourceUrl } from "@/lib/api";
import { useWorkspace } from "@/lib/store";
import { useResearch } from "@/lib/use-research";
import { layoutGraph } from "@/lib/graph-layout";
import { bom, graph, run } from "./fixtures";

beforeEach(() => {
  useWorkspace.getState().reset();
});

describe("exploration state", () => {
  it("ignores a late result even when the same run is reopened", () => {
    useWorkspace.getState().begin(run);
    const previous = useWorkspace.getState().generation;
    useWorkspace.getState().reset();
    useWorkspace.getState().begin(run);
    useWorkspace.getState().update(previous, run, graph, bom);
    expect(useWorkspace.getState().graph).toBeNull();
    useWorkspace.getState().update(useWorkspace.getState().generation, run, graph, bom);
    expect(useWorkspace.getState().bom?.revision).toBe(graph.revision);
  });

  it("polls the BOM at the displayed graph revision and aborts on exit", async () => {
    const readRun = vi.spyOn(api, "run").mockResolvedValue(run);
    vi.spyOn(api, "graph").mockResolvedValue(graph);
    const readBom = vi.spyOn(api, "bom").mockResolvedValue(bom);
    useWorkspace.getState().begin(run);
    const view = renderHook(() => useResearch());
    await waitFor(() => expect(useWorkspace.getState().bom).toEqual(bom));
    expect(readBom).toHaveBeenCalledWith(run.id, graph.revision, expect.any(AbortSignal));
    const signal = readRun.mock.calls[0][1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("product to BOM", () => {
  it("validates input and reuses the same idempotency key for a failed submission", async () => {
    const user = userEvent.setup();
    const decompose = vi
      .spyOn(api, "decompose")
      .mockRejectedValueOnce(new Error("Service unavailable"))
      .mockResolvedValue(run);
    render(<ProductForm />);
    expect(screen.getByRole("button", { name: "Deconstruct product" })).toBeDisabled();
    await user.type(screen.getByLabelText(/Product name/), "  Test product  ");
    await user.click(screen.getByRole("button", { name: "Deconstruct product" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Service unavailable");
    await user.click(screen.getByRole("button", { name: "Deconstruct product" }));
    await waitFor(() => expect(useWorkspace.getState().stage).toBe("bom"));
    expect(decompose.mock.calls[0][0]).toBe("Test product");
    expect(decompose.mock.calls[1][2]).toBe(decompose.mock.calls[0][2]);
  });

  it("does not reopen a product when its request finishes after navigation", async () => {
    let finish!: (value: typeof run) => void;
    vi.spyOn(api, "decompose").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<ProductForm />);
    fireEvent.change(screen.getByLabelText(/Product name/), { target: { value: "Test product" } });
    fireEvent.click(screen.getByRole("button", { name: "Deconstruct product" }));
    view.unmount();
    await act(async () => finish(run));
    expect(useWorkspace.getState().run).toBeNull();
  });

  it("keeps unknown quantities explicit and lets a component open its evidence", async () => {
    const user = userEvent.setup();
    useWorkspace.getState().begin(run);
    useWorkspace.getState().update(useWorkspace.getState().generation, run, graph, bom);
    render(<BOMView />);
    expect(screen.getByText("Unknown", { exact: true })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Inspect Test chip" }));
    expect(useWorkspace.getState().selectedEdge).toBe("e_chip");
    await user.type(screen.getByRole("textbox", { name: "Find a component" }), "unrelated");
    expect(screen.getByText("No matching components")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Explore network" }));
    expect(useWorkspace.getState().stage).toBe("network");
    expect(useWorkspace.getState().selectedEdge).toBeNull();
  });
});

it("lays out dependencies after the product without reversing API arrows", () => {
  const result = layoutGraph(graph);
  expect(result.nodes[1].position.x).toBeGreaterThan(result.nodes[0].position.x);
  expect(result.edges[0].source).toBe("n_component");
  expect(result.edges[0].target).toBe("n_product");
  expect(result.nodes[1].data.country).toBeUndefined();
});

it.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "file:///tmp/evidence",
  "urn:upload:row1",
  "not a URL",
])("does not make an unsafe source clickable: %s", (url) => {
  expect(safeSourceUrl(url)).toBeNull();
});
