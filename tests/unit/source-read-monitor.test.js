import { describe, expect, test } from "vitest";
import { createSourceReadMonitor, resolveSourceReadStats } from "../../src/core/source-read-monitor.js";

function harness() {
  let time = 0, offset = 0;
  const monitor = createSourceReadMonitor({ now: () => time });
  const reads = (count, ms = 30, ids = [1], length = 65536, overlap = false) => {
    for (let i = 0; i < count; i++) {
      const startMs = overlap ? 0 : time;
      if (!overlap) time += ms;
      monitor.read({ offset: offset++ * 262144, length, startMs, endMs: overlap ? ms : time }, ids);
    }
  };
  return { monitor, reads, advance: (ms) => { time += ms; } };
}

describe("source file latency detector", () => {
  test("requires two distinct slow windows and more than one second of real foreground I/O", () => {
    const { monitor, reads } = harness();
    monitor.begin(1, true);
    reads(39);
    expect(monitor.snapshot().sourceReadSlowWindows).toBe(1);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
    reads(1);
    expect(monitor.snapshot().sourceReadWarning).toBe(0); // Wait for successful settlement.
    monitor.finish(1);
    expect(monitor.snapshot()).toMatchObject({ sourceReadWarning: 1, sourceReadMedianMs: 30,
      sourceReadWaitMs: 1200, sourceReadQualifiedSamples: 40 });
    monitor.clear();
    expect(monitor.snapshot()).toMatchObject({ sourceReadWarning: 1, sourceReadWarningWaitMs: 1200,
      sourceReadQualifiedSamples: 0 });
  });

  test("slow reads without visible I/O waiting, fast reads, and computation gaps cannot warn", () => {
    const { monitor, reads, advance } = harness();
    monitor.begin(1, true); reads(40, 4); advance(10000); monitor.finish(1);
    expect(monitor.snapshot().sourceReadWaitMs).toBe(160);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
    advance(300);
    monitor.begin(2, true); reads(80, 0.5, [2]); monitor.finish(2);
    expect(monitor.snapshot().sourceReadSlowWindows).toBe(0);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
  });

  test("background, failure, clear, and canceled shared work cannot qualify", () => {
    const { monitor, reads } = harness();
    monitor.begin(1, false); reads(50); monitor.finish(1);
    expect(monitor.snapshot().sourceReadQualifiedSamples).toBe(0);
    monitor.begin(2, true); reads(40, 30, [2]); monitor.finish(2, false);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
    monitor.begin(3, true); reads(40, 30, [3]); monitor.clear(); monitor.finish(3);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
    monitor.begin(4, true); monitor.begin(5, true);
    reads(40, 30, [4, 5]); monitor.finish(4); monitor.finish(5, false);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
  });

  test("parallel reads are counted once and repeated offsets do not manufacture evidence", () => {
    const { monitor, reads } = harness();
    monitor.begin(1, true);
    reads(40, 30, [1], 65536, true);
    monitor.finish(1);
    expect(monitor.snapshot().sourceReadWaitMs).toBe(30);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
    monitor.clear(); monitor.begin(2, true);
    for (let i = 0; i < 40; i++) monitor.read({ offset: 0, length: 65536, startMs: i * 30, endMs: (i + 1) * 30 }, [2]);
    monitor.finish(2);
    expect(monitor.snapshot().sourceReadQualifiedSamples).toBe(1);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
  });

  test("tiny and bulk reads contribute waiting but not small-read latency evidence", () => {
    const { monitor, reads } = harness();
    monitor.begin(1, true); reads(40, 30, [1], 4096); reads(40, 30, [1], 1048576); monitor.finish(1);
    expect(monitor.snapshot().sourceReadWaitMs).toBe(2400);
    expect(monitor.snapshot().sourceReadQualifiedSamples).toBe(0);
    expect(monitor.snapshot().sourceReadWarning).toBe(0);
  });

  test("follows live TIFF source stats rather than an older wrapper snapshot", () => {
    const stats = { sourceReadQualifiedSamples: 40, sourceReadWarning: 1 };
    const source = { stats: { sourceReadQualifiedSamples: 0 }, rawSource: { source: { stats } } };
    expect(resolveSourceReadStats(source)).toBe(stats);
    expect(resolveSourceReadStats(null)).toBeNull();
    source.rawSource.source.rawSource = source;
    expect(resolveSourceReadStats(source)).toBe(stats);
  });
});
