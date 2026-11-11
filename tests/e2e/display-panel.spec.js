import { test, expect } from "@playwright/test";

test("display histogram stays open until its title or outside is clicked", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await page.locator("#filePicker").setInputFiles([
    { name: "histogram.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 10\nlines = 10\nbands = 1\ndata type = 4\ninterleave = bsq\nbyte order = 0\n") },
    { name: "histogram.raw", mimeType: "application/octet-stream", buffer: Buffer.alloc(400) }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
  const panel = page.locator("#displayPanel");
  const title = page.locator("#displayHeader");
  await expect(panel).toHaveAttribute("data-open", "false");
  await expect(page.locator("#btnDisplayPin")).toHaveCount(0);
  await title.click();
  await page.mouse.move(20, 20);
  await page.waitForTimeout(300);
  await expect(panel).toHaveAttribute("data-open", "true");
  await page.locator("#numMin").click();
  await expect(panel).toHaveAttribute("data-open", "true");
  await title.click();
  await expect(panel).toHaveAttribute("data-open", "false");
  await title.click();
  await page.mouse.click(20, 20);
  await expect(panel).toHaveAttribute("data-open", "false");
});
