import { expect, request as playwrightRequest, test, type BrowserContext, type Page } from "@playwright/test";

const backendPort = Number(process.env.OPENOVERLAY_E2E_BACKEND_PORT) || 8734;
const backendUrl = process.env.OPENOVERLAY_E2E_BACKEND_URL || `http://127.0.0.1:${backendPort}`;
const browserErrors = new WeakMap<BrowserContext, string[]>();
let accountSequence = 0;
const sharedAccount = {
  email: `e2e-shared-${Date.now()}-${process.pid}@openoverlay.local`,
  password: "password123"
};

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext({ baseURL: backendUrl });
  try {
    const response = await api.post("/api/v1/auth/signup", {
      data: sharedAccount,
      headers: { "X-OpenOverlay-Api-Version": "v1" }
    });
    expect(response.status()).toBe(201);
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ context }) => {
  const errors: string[] = [];
  const monitoredPages = new WeakSet<Page>();
  browserErrors.set(context, errors);

  const monitor = (page: Page) => {
    if (monitoredPages.has(page)) return;
    monitoredPages.add(page);
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // Chromium also mirrors every HTTP failure as a generic console message.
      // The response listener below records those with their precise URL/status.
      if (message.text().startsWith("Failed to load resource:")) return;
      errors.push(`console: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const pathname = new URL(response.url()).pathname;
      const expectedSignedOutProbe = response.status() === 401 && pathname.endsWith("/api/v1/auth/me");
      if (!expectedSignedOutProbe) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    });
  };

  for (const page of context.pages()) monitor(page);
  context.on("page", monitor);
});

test.afterEach(async ({ context }) => {
  expect.soft(browserErrors.get(context) || [], "the browser should not report page, console, or unexpected HTTP errors").toEqual([]);
});

function uniqueEmail(label: string): string {
  accountSequence += 1;
  return `e2e-${label}-${Date.now()}-${process.pid}-${accountSequence}@openoverlay.local`;
}

async function signUp(page: Page, label: string): Promise<{ email: string; password: string }> {
  const account = { email: uniqueEmail(label), password: "password123" };
  await page.goto("/signup");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
  return account;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(sharedAccount.email);
  await page.getByLabel("Password").fill(sharedAccount.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
}

async function createGame(page: Page, name: string, type: "soccer" | "church" = "soccer"): Promise<string> {
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
  await page.getByRole("button", { name: /New game/i }).click();
  if (type !== "soccer") await page.getByLabel("Game type").selectOption(type);
  await page.getByLabel("Game name").fill(name);
  await page.getByRole("button", { name: "Create game" }).click();
  await expect(page.locator("main h1")).toHaveText(name);
  const match = new URL(page.url()).pathname.match(/^\/dash\/presets\/([^/]+)$/);
  expect(match, `expected the ${name} editor URL to include a preset id`).toBeTruthy();
  return match![1];
}

async function assertNoHorizontalClipping(page: Page, width: number): Promise<void> {
  const report = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflow = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll<HTMLElement>(".app-shell, .main, .live-game-page, .editor-layout, .soccer-bottom-control-panel")
    ]
      .filter((element, index, all) => all.indexOf(element) === index)
      .map((element) => ({
        element: element === document.documentElement ? "html" : element === document.body ? "body" : element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth
      }))
      .filter(({ clientWidth, scrollWidth }) => clientWidth > 0 && scrollWidth > clientWidth + 1);

    const clippedControls = [
      ...document.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([type='file']):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role='tab']"
      )
    ]
      .filter((element) => {
        if (element.closest("[aria-hidden='true'], [inert]")) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
      })
      .slice(0, 20)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 80) || element.tagName,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          viewportWidth
        };
      });

    return { overflow, clippedControls };
  });

  expect(report.overflow, `${width}px layout should not hide content in overflowing root/editor containers`).toEqual([]);
  expect(report.clippedControls, `${width}px layout should keep interactive controls inside the viewport`).toEqual([]);
}

test("protected routes redirect to login and return to the requested URL", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/dash/teams?source=protected-route");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(sharedAccount.email);
  await page.getByLabel("Password").fill(sharedAccount.password);
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page).toHaveURL(/\/dash\/teams\?source=protected-route$/);
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
});

test("new-game dialog traps keyboard focus, closes with Escape, and restores focus", async ({ page }) => {
  await signIn(page);
  const opener = page.getByRole("button", { name: /New game/i });
  await opener.click();

  const dialog = page.getByRole("dialog", { name: "New game" });
  const gameType = page.getByLabel("Game type");
  const gameName = page.getByLabel("Game name");
  const cancel = page.getByRole("button", { name: "Cancel" });
  const submit = page.getByRole("button", { name: "Create game" });
  await expect(dialog).toBeVisible();
  await expect(gameName).toBeFocused();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");

  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(gameType).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(submit).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#root")).not.toHaveAttribute("aria-hidden", "true");
});

test("a delayed autosave remains bound to its preset during rapid route navigation", async ({ page }) => {
  await signIn(page);
  const firstPresetId = await createGame(page, "Route Race A");
  await createGame(page, "Route Race B");
  await page.goto(`/dash/presets/${firstPresetId}`);
  await expect(page.getByRole("heading", { name: "Route Race A" })).toBeVisible();
  await page.getByRole("button", { name: "Setup" }).click();

  let delayedPatchObserved = false;
  await page.route(`**/api/v1/presets/${firstPresetId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      delayedPatchObserved = true;
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    await route.continue();
  });
  const firstSave = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/presets/${firstPresetId}`));

  let navigationWarning = "";
  page.once("dialog", async (dialog) => {
    navigationWarning = dialog.message();
    await dialog.accept();
  });
  await page.getByLabel("Team name").first().fill("Route A Edited");
  await page.getByRole("link", { name: "Route Race B", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Route Race B" })).toBeVisible();
  expect(navigationWarning).toContain("unsaved or staged changes");
  expect((await firstSave).status()).toBe(200);
  expect(delayedPatchObserved).toBe(true);

  await page.getByRole("button", { name: "Setup" }).click();
  await expect(page.getByLabel("Team name").first()).not.toHaveValue("Route A Edited");
  await page.reload();
  await page.getByRole("button", { name: "Setup" }).click();
  await expect(page.getByLabel("Team name").first()).not.toHaveValue("Route A Edited");

  await page.goto(`/dash/presets/${firstPresetId}`);
  await page.getByRole("button", { name: "Setup" }).click();
  await expect(page.getByLabel("Team name").first()).toHaveValue("Route A Edited");
});

test("an action waits for the pending autosave and preserves both changes", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Ordered Mutations");
  let patchFinished = false;
  let actionStartedBeforePatchFinished = false;

  await page.route(new RegExp(`/api/v1/presets/${presetId}(?:$|/)`), async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "PATCH" && pathname.endsWith(`/presets/${presetId}`)) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      const response = await route.fetch();
      patchFinished = true;
      await route.fulfill({ response });
      return;
    }
    if (method === "POST" && pathname.includes(`/presets/${presetId}/actions/`)) {
      actionStartedBeforePatchFinished = !patchFinished;
    }
    await route.continue();
  });

  const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/presets/${presetId}`));
  const actionResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/v1/presets/${presetId}/actions/home-score-plus`)
  );
  await page.getByLabel("Period", { exact: true }).fill("RACE");
  await page.getByRole("button", { name: "Add point to OOU" }).click();

  expect((await saveResponse).status()).toBe(200);
  expect((await actionResponse).status()).toBe(200);
  expect(actionStartedBeforePatchFinished).toBe(false);
  await expect(page.locator(".score-control").first().locator("strong")).toHaveText("1");

  await page.reload();
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("RACE");
  await expect(page.locator(".score-control").first().locator("strong")).toHaveText("1");
});

test("a failed autosave stays dirty and blocks actions until a successful retry", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Autosave Recovery");
  let patchAttempts = 0;
  let actionAttempts = 0;

  await page.route(new RegExp(`/api/v1/presets/${presetId}(?:$|/)`), async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "PATCH" && pathname.endsWith(`/presets/${presetId}`)) {
      patchAttempts += 1;
      if (patchAttempts === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}"
        });
        return;
      }
    }
    if (method === "POST" && pathname.includes(`/presets/${presetId}/actions/home-score-plus`)) {
      actionAttempts += 1;
    }
    await route.continue();
  });

  await page.getByLabel("Period", { exact: true }).fill("RECOVERED");
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  expect(patchAttempts).toBe(1);

  await page.getByRole("button", { name: "Add point to OOU" }).click();
  await expect(page.getByRole("alert")).toContainText("Unsaved game changes must be saved");
  expect(actionAttempts).toBe(0);
  await expect(page.locator(".score-control").first().locator("strong")).toHaveText("0");

  let navigationWarning = "";
  page.once("dialog", async (dialog) => {
    navigationWarning = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "Games", exact: true }).click();
  await expect.poll(() => navigationWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(new RegExp(`/dash/presets/${presetId}$`));

  let backWarning = "";
  page.once("dialog", async (dialog) => {
    backWarning = dialog.message();
    await dialog.dismiss();
  });
  await page.evaluate(() => window.history.back());
  await expect.poll(() => backWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(new RegExp(`/dash/presets/${presetId}$`));

  let logoutWarning = "";
  page.once("dialog", async (dialog) => {
    logoutWarning = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Logout" }).click();
  await expect.poll(() => logoutWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(new RegExp(`/dash/presets/${presetId}$`));

  const retryResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/presets/${presetId}`));
  await page.getByRole("button", { name: "Retry save" }).click();
  expect((await retryResponse).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Retry save" })).toBeHidden();

  const actionResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/v1/presets/${presetId}/actions/home-score-plus`)
  );
  await page.getByRole("button", { name: "Add point to OOU" }).click();
  expect((await actionResponse).status()).toBe(200);
  expect(actionAttempts).toBe(1);

  await page.reload();
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("RECOVERED");
  await expect(page.locator(".score-control").first().locator("strong")).toHaveText("1");
});

test("failed and delayed sidebar duplication cannot bypass or hijack dirty navigation", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Dirty Duplicate Guard");
  let patchAttempts = 0;
  let duplicateAttempts = 0;
  let markSecondDuplicateStarted!: () => void;
  let releaseSecondDuplicate!: () => void;
  const secondDuplicateStarted = new Promise<void>((resolve) => {
    markSecondDuplicateStarted = resolve;
  });
  const secondDuplicateGate = new Promise<void>((resolve) => {
    releaseSecondDuplicate = resolve;
  });

  await page.route(new RegExp(`/api/v1/presets/${presetId}(?:$|/)`), async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "PATCH" && pathname.endsWith(`/presets/${presetId}`)) {
      patchAttempts += 1;
      if (patchAttempts === 1) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
    }
    if (method === "POST" && pathname.endsWith(`/presets/${presetId}/duplicate`)) {
      duplicateAttempts += 1;
      if (duplicateAttempts === 1) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      markSecondDuplicateStarted();
      await secondDuplicateGate;
      const response = await route.fetch();
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  await page.getByLabel("Period", { exact: true }).fill("DIRTY");
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();

  const sidebarGame = page.getByRole("link", { name: "Dirty Duplicate Guard", exact: true });
  await sidebarGame.focus();
  await page.keyboard.press("Shift+F10");
  let firstDuplicateWarning = "";
  page.once("dialog", async (dialog) => {
    firstDuplicateWarning = dialog.message();
    await dialog.accept();
  });
  const failedDuplicateResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/presets/${presetId}/duplicate`)
  );
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  expect((await failedDuplicateResponse).status()).toBe(200);
  expect(firstDuplicateWarning).toContain("unsaved or staged changes");
  await expect(page.locator(".shell-error")).toHaveText("Server response did not include a valid preset");

  let afterFailureWarning = "";
  page.once("dialog", async (dialog) => {
    afterFailureWarning = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "Games", exact: true }).click();
  await expect.poll(() => afterFailureWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(new RegExp(`/dash/presets/${presetId}$`));

  await sidebarGame.focus();
  await page.keyboard.press("Shift+F10");
  page.once("dialog", async (dialog) => dialog.accept());
  const delayedDuplicateResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/presets/${presetId}/duplicate`)
  );
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await secondDuplicateStarted;

  let navigationWarning = "";
  page.once("dialog", async (dialog) => {
    navigationWarning = dialog.message();
    await dialog.accept();
  });
  await page.getByRole("link", { name: "Games", exact: true }).click();
  await expect.poll(() => navigationWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(/\/dash$/);

  releaseSecondDuplicate();
  expect((await delayedDuplicateResponse).status()).toBe(201);
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(/\/dash$/);
  expect(duplicateAttempts).toBe(2);
});

test("soccer operator tools update output, clear graphics, rotate keys, and expose events", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Operator Tools");
  const output = page.frameLocator(".output-preview-iframe");

  const sidebarGame = page.getByRole("link", { name: "Operator Tools", exact: true });
  await sidebarGame.focus();
  await page.keyboard.press("Shift+F10");
  const gameMenu = page.getByRole("menu", { name: "Operator Tools actions" });
  const duplicateMenuItem = gameMenu.getByRole("menuitem", { name: "Duplicate" });
  const deleteMenuItem = gameMenu.getByRole("menuitem", { name: "Delete" });
  await expect(gameMenu).toBeVisible();
  await expect(duplicateMenuItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(deleteMenuItem).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(duplicateMenuItem).toBeFocused();
  await page.keyboard.press("End");
  await expect(deleteMenuItem).toBeFocused();
  await page.keyboard.press("Home");
  await expect(duplicateMenuItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(gameMenu).toBeHidden();
  await expect(sidebarGame).toBeFocused();

  const statSave = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/presets/${presetId}`));
  await page.getByRole("button", { name: "Add one to OOU shots" }).click();
  expect((await statSave).status()).toBe(200);
  const savedStats = await page.request.get(`${backendUrl}/api/v1/presets/${presetId}`);
  expect((await savedStats.json()).preset.state.stats.shots.home).toBe(1);
  await expect(output.locator(".statbug")).toHaveCount(0);

  await page.getByLabel("Graphic title (optional)").fill("E2E GOAL");
  await page.getByLabel("Subtitle / player (optional)").fill("Player 9");
  const goalResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/v1/presets/${presetId}/actions/trigger-goal`)
  );
  await page.getByRole("button", { name: "Goal", exact: true }).click();
  expect((await goalResponse).status()).toBe(200);
  await expect(output.getByRole("heading", { name: "E2E GOAL" })).toBeVisible();
  await expect(output.getByText("Player 9", { exact: true })).toBeVisible();

  const clearResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/v1/presets/${presetId}/actions/clear`)
  );
  await page.getByRole("button", { name: "Panic clear" }).click();
  expect((await clearResponse).status()).toBe(200);
  await expect(output.getByRole("heading", { name: "E2E GOAL" })).toBeHidden();

  let confirmMessage = "";
  page.once("dialog", async (dialog) => {
    confirmMessage = dialog.message();
    await dialog.accept();
  });
  const actionKeyResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/presets/${presetId}/action-key`)
  );
  await page.getByRole("button", { name: "Rotate action key" }).click();
  expect((await actionKeyResponse).status()).toBe(200);
  expect(confirmMessage).toContain("Existing Stream Deck and automation keys will stop working immediately");
  await expect(page.locator(".action-key-notice code")).toHaveText(/^ooa_[A-Za-z0-9_-]{32}$/);

  const initialEventResponse = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().endsWith(`/api/v1/presets/${presetId}/events`)
  );
  await page.getByRole("button", { name: "Event log" }).click();
  expect((await initialEventResponse).status()).toBe(200);
  const eventLog = page.getByRole("region", { name: "Preset event log" });
  await expect(eventLog).toBeVisible();
  await expect(eventLog.getByText("action.trigger-goal", { exact: true })).toBeVisible();
  await expect(eventLog.getByText("action.clear", { exact: true })).toBeVisible();
  await expect(eventLog.getByText("preset.action-key.rotate", { exact: true })).toBeVisible();

  const refreshResponse = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().endsWith(`/api/v1/presets/${presetId}/events`)
  );
  await eventLog.getByRole("button", { name: "Refresh" }).click();
  expect((await refreshResponse).status()).toBe(200);
  await expect(eventLog.getByText("preset.action-key.rotate", { exact: true })).toBeVisible();
});

test("rapid sidebar duplicate clicks create only one copy", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Duplicate Guard");
  let duplicateRequests = 0;
  await page.route(`**/api/v1/presets/${presetId}/duplicate`, async (route) => {
    duplicateRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });

  const sidebarGame = page.getByRole("link", { name: "Duplicate Guard", exact: true });
  await sidebarGame.focus();
  await page.keyboard.press("Shift+F10");
  const duplicate = page.getByRole("menuitem", { name: "Duplicate" });
  await duplicate.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  await expect(page.getByRole("heading", { name: "Duplicate Guard Copy" })).toBeVisible();
  expect(duplicateRequests).toBe(1);
});

test("a long desktop sidebar keeps its first and last navigation items reachable", async ({ page }) => {
  await signIn(page);
  const updatedAt = "2026-08-11T12:00:00.000Z";
  const presets = Array.from({ length: 100 }, (_, index) => ({
    id: `sidebar-preset-${index + 1}`,
    publicId: `sidebar-public-${index + 1}`,
    name: `Sidebar Game ${String(index + 1).padStart(3, "0")}`,
    type: "soccer",
    revision: 1,
    updatedAt,
    overlayClientCount: 0
  }));
  await page.route("**/api/v1/presets", async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname.endsWith("/api/v1/presets")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ presets }) });
      return;
    }
    await route.continue();
  });

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/dash");
  await expect(page.locator(".sidebar-subnav a")).toHaveCount(100);

  const reachability = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".sidebar-nav");
    const firstGame = document.querySelector<HTMLElement>(".sidebar-subnav a");
    const media = document.querySelector<HTMLElement>("a[href='/dash/media']");
    if (!nav || !firstGame || !media) throw new Error("sidebar navigation elements are missing");

    nav.scrollTop = 0;
    const navAtTop = nav.getBoundingClientRect();
    const firstAtTop = firstGame.getBoundingClientRect();
    const firstReachable = firstAtTop.top >= navAtTop.top - 1 && firstAtTop.bottom <= navAtTop.bottom + 1;

    nav.scrollTop = nav.scrollHeight;
    const navAtBottom = nav.getBoundingClientRect();
    const mediaAtBottom = media.getBoundingClientRect();
    const lastReachable = mediaAtBottom.top >= navAtBottom.top - 1 && mediaAtBottom.bottom <= navAtBottom.bottom + 1;

    return {
      firstReachable,
      lastReachable,
      scrollable: nav.scrollHeight > nav.clientHeight,
      maxScrollTop: nav.scrollTop
    };
  });

  expect(reachability.scrollable).toBe(true);
  expect(reachability.maxScrollTop).toBeGreaterThan(0);
  expect(reachability.firstReachable).toBe(true);
  expect(reachability.lastReachable).toBe(true);
});

test("the preset editor renders before optional media and team libraries finish loading", async ({ page }) => {
  await signIn(page);
  let releaseOptionalRequests!: () => void;
  const optionalRequestGate = new Promise<void>((resolve) => {
    releaseOptionalRequests = resolve;
  });
  const optionalRequests = new Set<string>();

  for (const endpoint of ["media", "teams"]) {
    await page.route(new RegExp(`/api/v1/${endpoint}(?:\\?.*)?$`), async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      optionalRequests.add(endpoint);
      await optionalRequestGate;
      await route.continue();
    });
  }

  await page.getByRole("button", { name: /New game/i }).click();
  await page.getByLabel("Game name").fill("Optional Data Latency");
  await page.getByRole("button", { name: "Create game" }).click();

  try {
    await expect.poll(() => optionalRequests.size).toBe(2);
    await expect(page.getByRole("heading", { name: "Optional Data Latency" })).toBeVisible({ timeout: 1_500 });
  } finally {
    releaseOptionalRequests();
  }
});

test("dashboard, teams, and soccer editor avoid horizontal clipping at responsive widths", async ({ page }) => {
  await signIn(page);
  const responsiveWidths = [280, 320, 430, 768, 1101, 1280, 1281, 1920];

  for (const width of responsiveWidths) {
    await test.step(`dashboard at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/dash");
      await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
      await assertNoHorizontalClipping(page, width);
    });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dash/teams");
  await page.getByRole("button", { name: "New Team" }).click();
  const teamDialog = page.getByRole("dialog", { name: "New team" });
  await teamDialog.getByRole("textbox", { name: "Team name" }).fill("Responsive Team");
  await teamDialog.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByRole("heading", { name: "Responsive Team" })).toBeVisible();
  for (const width of responsiveWidths) {
    await test.step(`team editor at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await assertNoHorizontalClipping(page, width);
    });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await createGame(page, "Responsive Editor");
  for (const width of responsiveWidths) {
    await test.step(`soccer editor at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("heading", { name: "Responsive Editor" })).toBeVisible();
      await assertNoHorizontalClipping(page, width);
    });
  }
});

test("deleting a live preset clears connected editor and overlay clients", async ({ page, context }) => {
  await signIn(page);
  const presetId = await createGame(page, "Realtime Delete");
  await expect(page.locator(".status-pill", { hasText: "connected" }).first()).toBeVisible();

  const presetResponse = await page.request.get(`${backendUrl}/api/v1/presets/${presetId}`, {
    headers: { "X-OpenOverlay-Api-Version": "v1" }
  });
  expect(presetResponse.status()).toBe(200);
  const presetBody = (await presetResponse.json()) as { preset: { publicId: string; revision: number } };

  const overlayPage = await context.newPage();
  await overlayPage.goto(`/overlay-test/${presetBody.preset.publicId}`);
  await expect(overlayPage.getByText(`${presetBody.preset.publicId} · connected`)).toBeVisible();
  await expect(overlayPage.locator(".overlay-viewport")).toBeVisible();

  const deleteResponse = await page.request.delete(`${backendUrl}/api/v1/presets/${presetId}`, {
    headers: {
      "X-OpenOverlay-Api-Version": "v1",
      "If-Match": `"${presetBody.preset.revision}"`
    }
  });
  expect(deleteResponse.status()).toBe(200);

  await expect(page.getByRole("heading", { name: "Game deleted" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to games" })).toBeVisible();
  await expect(overlayPage.getByRole("alert")).toHaveText("This overlay was deleted and is no longer available.");
  await expect(overlayPage.locator(".overlay-viewport")).toHaveCount(0);
  await overlayPage.close();
});

test("soccer and church workflows render in dashboard and overlay", async ({ page, context }) => {
  await signUp(page, "happy-path");

  await page.getByRole("button", { name: /New game/i }).click();
  await page.getByLabel("Game name").fill("E2E Soccer");
  await page.getByRole("button", { name: "Create game" }).click();
  await expect(page.getByRole("heading", { name: "E2E Soccer" })).toBeVisible();
  await expect(page.getByText(/overlay clients/)).toBeVisible();

  await page.getByRole("link", { name: "Media" }).click();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#0f766e"/><text x="60" y="70" text-anchor="middle" font-size="38" fill="white">OO</text></svg>`;
  await page.getByLabel("Upload media files").setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  await expect(page.getByText("logo.svg")).toBeVisible();

  await page.getByRole("link", { name: "Games" }).click();
  await page.getByRole("link", { name: "Open E2E Soccer" }).click();
  await page.getByRole("button", { name: "Setup" }).click();
  const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && /\/api\/v\d+\/presets\//.test(response.url()));
  await page.getByLabel("Team name").first().fill("Home Academy");
  await page.getByLabel("Team name").nth(1).fill("Away Academy");
  await page.getByLabel("Abbreviation").first().fill("HOM");
  await page.getByLabel("Abbreviation").nth(1).fill("AWY");
  await page.getByLabel("Roster").first().fill("10 Max Grenham\n11 Avery Stone");
  await saveResponse;

  await page.getByRole("button", { name: "Live" }).click();
  const homeScore = page.locator(".score-control", { hasText: "HOM" });
  await homeScore.getByRole("button", { name: "Add point to HOM" }).click();
  await expect(homeScore.locator("strong")).toHaveText("1");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(homeScore.locator("strong")).toHaveText("0");
  await homeScore.getByRole("button", { name: "Add point to HOM" }).click();
  await page.locator(".score-control", { hasText: "AWY" }).getByRole("button", { name: "Add point to AWY" }).click();

  const previewSrc = await page.locator(".output-preview-iframe").getAttribute("src");
  expect(previewSrc).toBeTruthy();
  const overlayPage = await context.newPage();
  const publicAuthRequests: string[] = [];
  overlayPage.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/v1/auth/me")) publicAuthRequests.push(request.url());
  });
  await overlayPage.goto(previewSrc!.replace(/[?&]client=preview/, ""));
  const soccerPackage = overlayPage.frameLocator(".lab-frame");
  await expect(soccerPackage.getByText("Home Academy")).toBeVisible();
  await expect(soccerPackage.getByText("Away Academy")).toBeVisible();
  expect(publicAuthRequests, "public overlays should not make a private session probe").toEqual([]);
  await overlayPage.reload();
  await expect(soccerPackage.getByText("Home Academy")).toBeVisible();
  await overlayPage.close();

  await page.getByRole("link", { name: "Games" }).click();
  await page.getByRole("button", { name: /New game/i }).click();
  await page.getByLabel("Game type").selectOption("church");
  await page.getByLabel("Game name").fill("E2E Church");
  await page.getByRole("button", { name: "Create game" }).click();
  await expect(page.getByRole("heading", { name: "E2E Church" })).toBeVisible();
  await page.getByRole("button", { name: "slides" }).click();
  await page.getByRole("button", { name: "Text" }).click();
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("Welcome\nE2E Service");
  await expect(page.frameLocator(".output-preview-iframe").getByText("E2E Service")).toBeVisible();
});

test("live output survives concurrent scores, capture clock skew, reconnect, and 16:9 resizing", async ({ page, browser }, testInfo) => {
  await signIn(page);
  const presetId = await createGame(page, "Live Stress");
  const capture = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await capture.addInitScript(() => {
    const wallClock = Date.now;
    Date.now = () => wallClock() + 120_000;
  });
  const output = await capture.newPage();
  try {
    const src = (await page.locator(".output-preview-iframe").getAttribute("src"))!.replace(/[?&]client=preview/, "");
    await output.goto(src);
    await expect(output.locator(".overlay-stage")).toBeVisible();
    const action = async (name: string, data = {}) => {
      const response = await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/${name}`, { data });
      expect(response.status()).toBe(200);
      return (await response.json()).preset;
    };
    await action("show-overlay", { overlay: "scorebug" });
    const score = output.frameLocator(".lab-frame").locator("[data-bind-score]").first();
    await expect(score).toHaveText("0");
    await Promise.all(Array.from({ length: 20 }, () => action("home-score-plus")));
    await expect(score).toHaveText("20");
    await expect(page.locator(".score-control strong").first()).toHaveText("20");
    // Browser clicks wait for the existing mutation lock; none may be lost.
    for (let index = 0; index < 6; index += 1) await page.getByRole("button", { name: "Add point to OOU" }).click();
    await expect(score).toHaveText("26");
    await output.reload();
    await expect(score).toHaveText("26");
    await expect(output.frameLocator(".lab-frame").locator(".overlay-entering")).toHaveCount(0);

    for (const width of [1280, 1920, 2560, 3840]) {
      const height = (width * 9) / 16;
      await output.setViewportSize({ width, height });
      await expect.poll(async () => Math.round((await output.locator(".overlay-stage").boundingBox())!.width)).toBe(width);
      const box = (await output.locator(".overlay-stage").boundingBox())!;
      expect(Math.round(box.height)).toBe(height);
      expect(Math.round(box.x)).toBe(0);
      expect(Math.round(box.y)).toBe(0);
      expect(await output.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      await output.screenshot({ path: testInfo.outputPath(`capture-${width}.png`), omitBackground: true });
    }
    await capture.setOffline(true);
    await action("away-score-plus");
    await expect(score).toHaveText("26");
    await capture.setOffline(false);
    await expect(output.frameLocator(".lab-frame").locator("[data-bind-score]").nth(1)).toHaveText("1", { timeout: 15_000 });
    await action("countdown-start", { durationSeconds: 5 });
    const timer = output.frameLocator(".lab-frame").locator(".timer-value");
    await expect(timer).toHaveText(/00:0[1-5]/);
    await expect(timer).toHaveText("00:00", { timeout: 8_000 });
    await action("trigger-goal", { title: "Expires offline", durationSeconds: 2 });
    await expect(output.getByRole("heading", { name: "Expires offline" })).toBeVisible();
    await capture.setOffline(true);
    await expect(output.getByRole("heading", { name: "Expires offline" })).toBeHidden({ timeout: 5_000 });
    await capture.setOffline(false);
  } finally {
    await capture.close();
  }
});

test("overlay falls back to HTTP polling when WebSocket transport is blocked", async ({ page, browser }) => {
  await signIn(page);
  const presetId = await createGame(page, "Polling Fallback");
  const capture = await browser.newContext();
  await capture.addInitScript(() => {
    window.WebSocket = class extends WebSocket {
      constructor() {
        super("blocked://capture-policy");
      }
    };
  });
  const output = await capture.newPage();
  try {
    const polling = output.waitForResponse((response) => response.url().includes("transport=polling") && response.status() === 200);
    const src = (await page.locator(".output-preview-iframe").getAttribute("src"))!;
    await output.goto(src);
    await polling;
    const response = await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/trigger-goal`, {
      data: { title: "Polling is live", durationSeconds: 0 }
    });
    expect(response.status()).toBe(200);
    await expect(output.getByRole("heading", { name: "Polling is live" })).toBeVisible();
  } finally {
    await capture.close();
  }
});

test("teams, media deletion, sharing, church output, and accessible controls work end to end", async ({ page, browser }, testInfo) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  await signUp(page, "library-owner");
  const checkAccessibility = async () => {
    const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(report.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))).toEqual([]);
  };
  await checkAccessibility();
  await page.getByRole("link", { name: "Teams", exact: true }).click();
  await page.getByRole("button", { name: "New Team" }).click();
  await page.getByRole("dialog").getByLabel("Team name").fill("Audit United");
  await page.getByRole("button", { name: "Create team" }).click();
  await page.getByLabel("Abbreviation", { exact: true }).fill("AUC");
  await expect(page.locator(".autosave-status")).toContainText("Saved");
  await page.reload();
  await expect(page.getByLabel("Abbreviation", { exact: true })).toHaveValue("AUC");
  await checkAccessibility();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audit United" })).toBeHidden();

  await page.getByRole("link", { name: "Media", exact: true }).click();
  await page
    .getByLabel("Upload media files")
    .setInputFiles({
      name: "audit.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>')
    });
  await expect(page.getByText("audit.svg")).toBeVisible();
  await checkAccessibility();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Delete/ }).click();
  await expect(page.getByText("audit.svg")).toBeHidden();

  await createGame(page, "Shared Service", "church");
  const previewWidth = (await page.locator(".preview-frame").boundingBox())!.width;
  const columnWidth = (await page.locator(".preview-column").boundingBox())!.width;
  expect(previewWidth).toBeGreaterThan(columnWidth * 0.9);
  await page.getByLabel("Show full-screen slide").uncheck();
  await page.getByRole("button", { name: "Show selected lower third" }).click();
  const output = page.frameLocator(".output-preview-iframe");
  await expect(output.locator(".church-lower-third")).toBeVisible();
  await page.getByLabel("Countdown length").fill("00:03");
  await page.getByLabel("Countdown length").blur();
  await page.getByRole("button", { name: "Start countdown" }).click();
  await expect(output.locator(".countdown-element")).toBeVisible();
  await expect(output.locator(".countdown-element")).toBeHidden({ timeout: 6_000 });
  await expect(page.getByRole("button", { name: "Start countdown", exact: true })).toBeVisible();
  await checkAccessibility();
  await page.screenshot({ path: testInfo.outputPath("church-controls.png") });

  const recipientContext = await browser.newContext();
  const recipient = await recipientContext.newPage();
  try {
    const account = await signUp(recipient, "share-recipient");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByLabel("Recipient account email").fill(account.email);
    await page.getByRole("button", { name: "Share copy", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /A copy was shared/ })).toBeVisible();
    await recipient.reload();
    await expect(recipient.getByRole("link", { name: /Open Shared Service/ })).toBeVisible();
    await recipient.getByRole("link", { name: /Open Shared Service/ }).click();
    await expect(recipient.locator("main h1")).toContainText("Shared Service");
  } finally {
    await recipientContext.close();
  }
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(page.getByRole("button", { name: "Login", exact: true })).toBeVisible();
});
