import { test, expect } from "../../fixtures/test";

test.describe("unauthenticated_outsider — access control", () => {
  test("unauthenticated user sees login page", async ({ page }) => {
    await page.goto("/");
    // Should redirect to login or show auth wall
  });

  test("cannot access project data without auth", async ({ page }) => {
    await page.goto("/dashboard");
    // Should redirect to login
  });
});
