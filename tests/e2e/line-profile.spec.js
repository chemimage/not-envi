import { expect, test } from "@playwright/test";

test("ruler profile opens, switches units, refreshes bands, and reopens after editing", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const data = Buffer.alloc(100 * 80 * 2 * 4);
  for (let i = 0; i < 16000; i++) data.writeFloatLE(i % 100 + Math.floor(i % 8000 / 100) * 2 + Math.floor(i / 8000) * 100, i * 4);
  await page.locator("#filePicker").setInputFiles([
    { name: "profile.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 100\nlines = 80\nbands = 2\nheader offset = 0\nfile type = ENVI Standard\ndata type = 4\ninterleave = bsq\nbyte order = 0\npixel size = {2, 3}\nunits = um\nband names = {First, Second}\n") },
    { name: "profile.raw", mimeType: "application/octet-stream", buffer: data }
  ]);
  await page.locator("#toolRuler").click();
  await page.mouse.move(350, 350);
  await page.mouse.down();
  await page.mouse.move(620, 440, { steps: 10 });
  await page.mouse.up();
  const panel = page.locator("#lineProfilePanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#lineProfileStatus")).toContainText("Hover");
  await expect(page.locator("#btnLineProfilePx")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#btnLineProfileUm").click();
  await expect(page.locator("#btnLineProfileUm")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#bandSelector").focus();
  await page.locator("#bandSelector").press("ArrowRight");
  await expect(page.locator("#lineProfileBand")).toHaveText("Second");
  await page.locator("#btnLineProfileClose").click();
  await expect(panel).toBeHidden();
  await page.mouse.move(620, 440);
  await page.mouse.down();
  await page.mouse.move(660, 420, { steps: 10 });
  await page.mouse.up();
  await expect(panel).toBeVisible();
  await page.locator("#toolEraser").dblclick();
  await expect(panel).toBeHidden();
});
