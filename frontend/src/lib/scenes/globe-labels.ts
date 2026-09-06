export interface MapLabelPoint {
  id: string;
  x: number;
  y: number;
}

export interface MapLabelBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** Place projected labels near their pins without covering neighboring labels. */
export function layoutGlobeLabels(points: MapLabelPoint[], bounds: MapLabelBounds) {
  const placed: (MapLabelPoint & { left: number; top: number })[] = [];
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(Math.max(min, max), value));
  for (const point of [...points].sort((a, b) => a.y - b.y)) {
    const preferredLeft = point.x - bounds.width - 28;
    const preferredTop = point.y - bounds.height / 2;
    const candidates = [];
    for (const x of [preferredLeft, point.x + 28]) {
      for (const offset of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5]) {
        const left = clamp(x, bounds.left, bounds.right - bounds.width);
        const top = clamp(
          preferredTop + offset * (bounds.height + 10),
          bounds.top,
          bounds.bottom - bounds.height,
        );
        const overlaps = placed.some(
          (p) =>
            left < p.left + bounds.width + 8 &&
            left + bounds.width + 8 > p.left &&
            top < p.top + bounds.height + 8 &&
            top + bounds.height + 8 > p.top,
        );
        if (!overlaps) candidates.push({ left, top });
      }
    }
    candidates.sort(
      (a, b) =>
        Math.hypot(a.left - preferredLeft, a.top - preferredTop) -
        Math.hypot(b.left - preferredLeft, b.top - preferredTop),
    );
    if (candidates[0]) placed.push({ ...point, ...candidates[0] });
  }
  return placed;
}
