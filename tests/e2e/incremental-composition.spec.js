import { expect, test } from "@playwright/test";

test("incremental composition matches every reference frame while processing fewer pixels", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { compositionWorkload } = await import("/tests/fixtures/composition-workload.js");
    return compositionWorkload();
  });
  expect(result.incremental.frameHashes).toEqual(result.full.frameHashes);
  expect(result.incremental.finalChecksum).toBe(result.expectedChecksum);
  expect(result.incremental.composePixels).toBeLessThan(result.full.composePixels / 2);
  expect(result.incremental.colorPixels).toBeLessThan(result.full.colorPixels / 2);
});
