import { describe, expect, test, vi } from "vitest";
import { createAnnotationWorkTracker } from "../../src/app/annotation-work.js";

describe("annotation work", () => {
  test("saved point work follows its own ID even when another color occupies the same pixel", () => {
    const tracker = createAnnotationWorkTracker();
    const ds = { id: "slide" };
    const point = { id: 1, x: 10, y: 20 };
    const drawings = [1, 2].map(id => ({ id, tool: "point", points: [{ x: 10, y: 20 }] }));
    tracker.begin(ds, { point });
    expect(tracker.list(ds, 1, drawings, { id: 2, x: 10, y: 20 })).toHaveLength(1);
    expect(tracker.list(ds, 1, drawings.slice(1), { id: 2, x: 10, y: 20 })).toEqual([]);
    drawings[0].points[0].x = 11;
    expect(tracker.list(ds, 1, drawings, point)).toEqual([]);
  });
  const a = { id: 1, points: [{ x: 10, y: 20 }, { x: 80, y: 50 }] };
  const b = { id: 2, points: [{ x: 20, y: 60 }, { x: 90, y: 90 }] };
  const ds = { id: "slide" };

  test("independent jobs survive other completions and removed regions disappear", () => {
    const changed = vi.fn();
    const tracker = createAnnotationWorkTracker(changed);
    const old = tracker.begin(ds, { items: [a, b], label: "Histogram" });
    const next = tracker.begin(ds, { items: [a], label: "Spectrum" });
    next.update(2, 8);
    expect(tracker.list(ds, 1, [a, b])).toHaveLength(2);
    expect(tracker.list(ds, 1, [a])[0].fraction).toBeNull();
    old.done();
    expect(tracker.list(ds, 1, [a])[0]).toMatchObject({ label: "Spectrum", fraction: 0.25 });
    old.done();
    expect(tracker.list(ds, 1, [a])).toHaveLength(1);
    expect(tracker.list(ds, 1, [b])).toEqual([]);
    next.done();
    expect(tracker.list(ds, 1, [a, b])).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(5);
  });

  test("work stays with its dataset, panel and unchanged annotation geometry", () => {
    const tracker = createAnnotationWorkTracker();
    tracker.begin(ds, { items: [a], slot: 2 });
    expect(tracker.list(ds, 1, [a])).toEqual([]);
    expect(tracker.list({ id: "other" }, 2, [a])).toEqual([]);
    expect(tracker.list(ds, 2, [a])).toHaveLength(1);
    const moved = { ...a, points: [{ x: 11, y: 20 }, a.points[1]] };
    expect(tracker.list(ds, 2, [moved])).toEqual([]);
  });

  test("point work belongs to its exact pixel and ignores updates after completion", () => {
    const tracker = createAnnotationWorkTracker();
    const point = { x: 10, y: 20 };
    const work = tracker.begin(ds, { point });
    expect(tracker.list(ds, 1, [], point)).toHaveLength(1);
    expect(tracker.list(ds, 1, [], { x: 11, y: 20 })).toEqual([]);
    work.done();
    work.update(1, 2);
    expect(tracker.list(ds, 1, [], point)).toEqual([]);
  });
});
