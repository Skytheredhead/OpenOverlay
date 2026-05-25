import { expect, test } from "@playwright/test";

test("soccer and church workflows render in dashboard and overlay", async ({ page, context }) => {
  const email = `e2e-${Date.now()}@openoverlay.local`;
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Layouts" })).toBeVisible();

  page.once("dialog", async (dialog) => {
    await dialog.accept("E2E Soccer");
  });
  await page.getByRole("button", { name: /New layout/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Soccer" })).toBeVisible();
  await expect(page.getByText(/overlay clients/)).toBeVisible();

  await page.getByRole("link", { name: "Media" }).click();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#0f766e"/><text x="60" y="70" text-anchor="middle" font-size="38" fill="white">OO</text></svg>`;
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  await expect(page.getByText("logo.svg")).toBeVisible();

  await page.getByRole("link", { name: "Layouts" }).click();
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("button", { name: "teams" }).click();
  await page.getByLabel("Full name").first().fill("Home Academy");
  await page.getByLabel("Full name").nth(1).fill("Away Academy");
  await page.getByLabel("Abbreviation").first().fill("HOM");
  await page.getByLabel("Abbreviation").nth(1).fill("AWY");
  await page.getByLabel("Roster").first().fill("10 Max Grenham\n11 Avery Stone");
  await page.waitForTimeout(500);

  await page.getByRole("button", { name: "control" }).click();
  await page.getByRole("button", { name: /Start/ }).click();
  await expect(page.getByRole("button", { name: /Pause/ })).toBeVisible();
  await page.getByRole("button", { name: /Pause/ }).click();
  await page.locator(".panel", { hasText: "HOM" }).getByRole("button").first().click();
  await page.locator(".panel", { hasText: "AWY" }).getByRole("button").first().click();

  await page.getByRole("button", { name: "graphics" }).click();
  page.once("dialog", async (dialog) => {
    await dialog.accept("Goal Max");
  });
  await page.getByRole("button", { name: /Goal/ }).click();
  await expect(page.getByText("Goal Max")).toBeVisible();
  await expect(page.getByText("Goal Max")).toBeHidden({ timeout: 7_000 });

  const testLink = page.getByRole("link", { name: "Test" });
  const overlayPagePromise = context.waitForEvent("page");
  await testLink.click();
  const overlayPage = await overlayPagePromise;
  await overlayPage.waitForLoadState("domcontentloaded");
  await expect(overlayPage.getByText("HOM")).toBeVisible();
  await expect(overlayPage.getByText("AWY")).toBeVisible();
  await overlayPage.reload();
  await expect(overlayPage.getByText("HOM")).toBeVisible();
  await overlayPage.close();

  await page.getByRole("link", { name: "Layouts" }).click();
  await expect(page).toHaveURL(/\/dash$/);
  await expect(page.getByRole("heading", { name: "Layouts" })).toBeVisible();
  await page.getByRole("combobox").first().selectOption("church");
  page.once("dialog", async (dialog) => {
    await dialog.accept("E2E Church");
  });
  await page.getByRole("button", { name: /New layout/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Church" })).toBeVisible();
  await page.getByRole("button", { name: "church" }).click();
  await page.getByRole("button", { name: "Text" }).click();
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("Welcome\nE2E Service");
  await expect(page.locator(".preview-frame").getByText("E2E Service")).toBeVisible();
});
