import { expect, test } from "@playwright/test";

test("app boots into the empty state and opens the multi-file picker", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.locator("#dropzone")).toBeVisible();
  await expect(page.locator("#btnGrid")).toBeHidden();
  await expect(page.locator("#btnFit")).toBeHidden();
  await expect(page.locator("#drawTools")).toBeHidden();
  await expect(page.locator("#displayDock")).toBeHidden();

  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#dropzone").click();
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(true);
  expect(errors).toEqual([]);
});
