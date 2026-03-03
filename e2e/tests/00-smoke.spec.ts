import { test, expect } from "../fixtures/test";

test("app loads", async ({ page }) => {
  const baseUrl = process.env.BASE_URL ?? "https://LeanMarketing.vercel.app";
  await page.goto(baseUrl);
  await expect(page).toHaveTitle(/.+/);
});
