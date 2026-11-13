import { describe, expect, test } from "vitest";
import { createPlotGroups } from "../../src/app/plot-groups.js";
const entry = (id, kind = "line", compatibility = `${kind}:distance`) => ({ id, kind, compatibility, status: "ready" });

describe("all split / all stacked plot layout", () => {
  test("focused plots keep one panel identity while selection, stacking and spectral units change", () => {
    const plots = createPlotGroups();
    plots.upsert(entry("a", "spectrum", "nm")); plots.upsert(entry("b", "spectrum", "nm"));
    plots.upsert(entry("c", "spectrum", "cm-1"));
    plots.present("spectrum", "a", false);
    const id = [...plots.groups.keys()][0];
    expect(plots.groups.get(id)).toMatchObject({ selectedId: "a", stacked: false, ids: ["a", "b"] });
    plots.present("spectrum", "b", true);
    expect([...plots.groups.keys()]).toEqual([id]);
    expect(plots.groups.get(id)).toMatchObject({ selectedId: "b", stacked: true, ids: ["a", "b"] });
    plots.present("spectrum", "c", false);
    expect(plots.groups.get(id)).toMatchObject({ selectedId: "c", ids: ["c"] });
    plots.present("spectrum", null, true);
    expect(plots.groups.get(id)).toMatchObject({ selectedId: null, ids: ["c"] });
    expect(plots.entries.size).toBe(3);
  });

  test("toggles every trace together and preserves stable chart identity on updates", () => {
    const plots = createPlotGroups();
    ["a", "b", "c"].forEach((id) => plots.upsert(entry(id)));
    plots.arrange("line", true);
    const together = [...plots.groups.keys()][0];
    expect(plots.groups.get(together).ids).toEqual(["a", "b", "c"]);
    plots.upsert({ ...entry("b"), data: { values: [42] } });
    plots.arrange("line", true);
    expect([...plots.groups.keys()]).toEqual([together]);
    plots.arrange("line", false);
    expect([...plots.groups.values()].map((group) => group.ids)).toEqual([["a"], ["b"], ["c"]]);
    plots.arrange("line", true);
    expect(plots.groups.size).toBe(1);
    expect(plots.entries.size).toBe(3);
  });

  test("native line windows own split mode and source deletion removes the trace", () => {
    const plots = createPlotGroups();
    plots.upsert(entry("a")); plots.upsert(entry("b"));
    plots.arrange("line", true); plots.remove("b");
    expect([...plots.groups.values()][0].ids).toEqual(["a"]);
    plots.arrange("line", false, true);
    expect(plots.groups.size).toBe(0);
    expect(plots.entries.has("a")).toBe(true);
  });

  test("keeps incompatible axes apart and retains stale trace membership", () => {
    const plots = createPlotGroups();
    plots.upsert(entry("a", "spectrum", "spectrum:nm"));
    plots.upsert(entry("b", "spectrum", "spectrum:cm-1"));
    plots.upsert({ ...entry("c", "spectrum", "spectrum:nm"), status: "changed" });
    plots.arrange("spectrum", true);
    expect([...plots.groups.values()].map((group) => group.ids)).toEqual([["a", "c"], ["b"]]);
  });

  test("layout limits are atomic and visible data cannot be evicted", () => {
    const plots = createPlotGroups({ maxEntries: 3, maxGroups: 1 });
    ["a", "b", "c"].forEach((id) => plots.upsert(entry(id)));
    plots.arrange("line", true);
    expect(() => plots.arrange("line", false)).toThrow("Close a chart");
    expect([...plots.groups.values()][0].ids).toEqual(["a", "b", "c"]);
    expect(plots.upsert(entry("d"))).toBe(false);
    plots.close([...plots.groups.keys()][0]);
    expect(plots.entries.size).toBe(3);
    expect(plots.upsert(entry("d"))).toBe(true);
  });
});
