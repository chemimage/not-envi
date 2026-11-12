import { describe, expect, test } from "vitest";
import { createPlotGroups } from "../../src/app/plot-groups.js";

const entry = (id, compatibility = "line:distance") => ({ id, compatibility, status: "ready" });

describe("plot membership", () => {
  test("splits one of three traces, then recombines without duplication", () => {
    const plots = createPlotGroups();
    ["a", "b", "c"].forEach((id) => plots.upsert(entry(id)));
    const together = plots.combine(["a", "b", "c"]);
    const apart = plots.split(together, "b");
    expect(plots.groups.get(together).ids).toEqual(["a", "c"]);
    expect(plots.groups.get(apart).ids).toEqual(["b"]);
    plots.combine(["b", "a", "c", "b"], apart);
    expect(plots.groups.size).toBe(1);
    expect(plots.groups.get(apart).ids).toEqual(["b", "a", "c"]);
    expect(plots.entries.size).toBe(3);
  });

  test("chart removal preserves the source while source deletion updates every chart", () => {
    const plots = createPlotGroups();
    ["a", "b"].forEach((id) => plots.upsert(entry(id)));
    const group = plots.combine(["a", "b"]);
    plots.detach(group, "a");
    expect(plots.entries.has("a")).toBe(true);
    expect(plots.groups.get(group).ids).toEqual(["b"]);
    plots.remove("b");
    expect(plots.groups.size).toBe(0);
    const single = plots.combine(["a"]);
    plots.close(single);
    expect(plots.entries.has("a")).toBe(true);
  });

  test("incompatible and stale plots are rejected without changing existing charts", () => {
    const plots = createPlotGroups();
    plots.upsert(entry("a")); plots.upsert(entry("b", "spectrum:nm"));
    plots.upsert({ ...entry("c"), status: "changed" });
    const group = plots.combine(["a"]);
    expect(() => plots.combine(["a", "b"])).toThrow("matching axis units");
    expect(() => plots.combine(["a", "c"])).toThrow("Calculate");
    expect(plots.groups.get(group).ids).toEqual(["a"]);
  });

  test("limits are atomic and retained comparison data cannot be evicted", () => {
    const plots = createPlotGroups({ maxEntries: 3, maxGroups: 1 });
    ["a", "b", "c"].forEach((id) => plots.upsert(entry(id)));
    const group = plots.combine(["a", "b"]);
    expect(() => plots.split(group, "a")).toThrow("Close a chart");
    expect(plots.groups.get(group).ids).toEqual(["a", "b"]);
    plots.upsert(entry("d"));
    expect([...plots.entries.keys()]).toEqual(["a", "b", "d"]);
    plots.combine(["a", "b", "d"], group);
    expect(plots.upsert(entry("e"))).toBe(false);
    expect(plots.entries.size).toBe(3);
  });
});
