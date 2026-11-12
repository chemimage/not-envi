import { expect, test } from "@playwright/test";

test("pyramid worker preserves projected pixels and statistics across refinement, eviction, view changes and cancellation", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const { pyramidWorkerWorkload } = await import("/tests/fixtures/pyramid-worker-workload.js");
    return pyramidWorkerWorkload();
  });
  expect(report.frames).toBe(8);
  expect(report.stats.mode).toBe("worker");
  expect(report.results.map((result) => result.finalCount)).toEqual([192, 191]);
  expect(report.stats.inputBytes).toBeGreaterThan(0);
  expect(report.stats.outputBytes).toBeGreaterThan(0);
  expect(report.stats.cancelledJobs).toBeGreaterThan(0);
  expect(report.mirrorBytes).toBeLessThanOrEqual(report.mirrorLimit);
  expect(report.cancellation).toBe("AbortError");
});
