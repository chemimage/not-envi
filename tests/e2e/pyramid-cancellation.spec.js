import { expect, test } from "@playwright/test";
import { instrumentFmapProvider } from "../fixtures/fmap-provider-control.js";

test("panning cancels queued and active pyramid work through the real fmap worker", async ({ page }) => {
  await page.context().route("**/src/io/fmap/fmap.worker.js*", async (route) => {
    if (!route.request().url().includes("worker_file")) return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: instrumentFmapProvider(body) });
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { exercisePyramidFmapCancellation } = await import("/tests/fixtures/pyramid-cancellation.js");
    return exercisePyramidFmapCancellation();
  });
  expect(result.before.active).toBe(1);
  expect(result.before.queued).toBeGreaterThan(0);
  expect(result.outcomes.length).toBeGreaterThanOrEqual(2);
  expect(result.outcomes.every((outcome) => outcome === "AbortError")).toBe(true);
  expect(result.oldTileCached).toBe(false);
  expect(result.workerCancelledRequests).toBeGreaterThan(0);
  expect(result.cancelledTiles).toBeGreaterThanOrEqual(2);
  expect(result.providerReads).toBe(1);
  expect(result.afterAcknowledgement.providerReads).toBe(1);
  expect(result.afterAcknowledgement.pinnedBytes).toBe(4096);
  expect(result.drained).toBe(true);
});
