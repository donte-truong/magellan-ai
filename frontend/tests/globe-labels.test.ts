import { describe, expect, it } from "vitest";
import { layoutGlobeLabels } from "@/lib/scenes/globe-labels";

describe("globe location labels", () => {
  it("keeps nearby European locations separate and inside a mobile viewport", () => {
    const bounds = { left: 60, right: 448, top: 36, bottom: 374, width: 142, height: 68 };
    const labels = layoutGlobeLabels(
      [
        { id: "nxp", x: 240, y: 141 },
        { id: "bosch", x: 247, y: 150 },
        { id: "st", x: 242, y: 155 },
      ],
      bounds,
    );
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label.left).toBeGreaterThanOrEqual(bounds.left);
      expect(label.left + bounds.width).toBeLessThanOrEqual(bounds.right);
      expect(label.top).toBeGreaterThanOrEqual(bounds.top);
      expect(label.top + bounds.height).toBeLessThanOrEqual(bounds.bottom);
      for (const other of labels.filter((item) => item.id !== label.id)) {
        const overlap =
          label.left < other.left + bounds.width &&
          label.left + bounds.width > other.left &&
          label.top < other.top + bounds.height &&
          label.top + bounds.height > other.top;
        expect(overlap).toBe(false);
      }
    }
  });

  it("keeps a selected location readable when its pin is at the viewport edge", () => {
    const bounds = { left: 12, right: 412, top: 36, bottom: 360, width: 142, height: 68 };
    for (const x of [13, 411]) {
      const [label] = layoutGlobeLabels([{ id: "selected", x, y: 40 }], bounds);
      expect(label.left).toBeGreaterThanOrEqual(bounds.left);
      expect(label.left + bounds.width).toBeLessThanOrEqual(bounds.right);
      expect(label.top).toBeGreaterThanOrEqual(bounds.top);
    }
  });
});
