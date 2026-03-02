import { expect, test } from "@playwright/test";

test("app boots and core controls are present", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.locator("#statusBadge")).toBeVisible();
  await expect(page.locator("#dropzone")).toBeVisible();
  await expect(page.locator("#btnFit")).toBeVisible();
  await expect(page.locator("#zoom")).toBeVisible();
  await expect(page.locator("#bandTree")).toBeVisible();
  expect(errors).toEqual([]);
});
