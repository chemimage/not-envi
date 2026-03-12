import { expect, test } from "@playwright/test";

test("app boots and core controls are present", async ({ page }) => {
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
  await expect(page.locator("#rightDock")).toBeHidden();
  expect(errors).toEqual([]);
});

test("clicking dropzone opens file picker dialog", async ({ page }) => {
  await page.goto("/");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#dropzone").click();
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(true);
});
