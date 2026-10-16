// Takes a screenshot of each shot in a light and a dark browser window, signed
// in as the seeded admin. Every capture gets a fresh window, because the app
// remembers things in the browser (such as which instruments were visited
// last) and a shot should not depend on the ones before it.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import {
  CLOSEUP_VIEWPORT,
  DEVICE_SCALE_FACTOR,
  WINDOW_VIEWPORT,
} from "./constants";
import { TIME_ZONE, WORK_DIR } from "./environment";
import type { World } from "./setup";
import type { Shot, Theme } from "./types";

// The dev server's build indicator and any toast would otherwise end up in the
// image. The indicator also sits over the account menu and would block clicks
// on it, so this applies for the whole session and not only the capture.
const HIDE_CSS = `
  nextjs-portal,
  [data-nextjs-toast],
  [data-sonner-toaster] { display: none !important; }
`;

// Runs in the browser before the page's own scripts. React removes elements it
// did not render when it hydrates, so the style is added again whenever it goes
// missing. It is a string because `tsx` wraps named functions in a helper that
// does not exist in the browser, which makes a function version fail silently.
const HIDE_OVERLAYS_SCRIPT = `
  (() => {
    const id = "docs-screenshots-hide";
    const css = ${JSON.stringify(HIDE_CSS)};
    const ensure = () => {
      // At document start there is no <html> yet. The observer calls this
      // again once it exists.
      const target = document.head ?? document.documentElement;
      if (!target || document.getElementById(id)) {
        return;
      }
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      target.appendChild(style);
    };
    ensure();
    new MutationObserver(ensure).observe(document, {
      childList: true,
      subtree: true,
    });
  })();
`;

// Breathing room around a close-up, in CSS pixels.
const CLOSEUP_MARGIN = 32;

// The first visit to a route makes the dev server compile it.
const NAVIGATION_TIMEOUT_MS = 180_000;

export async function launchBrowser(): Promise<Browser> {
  return await chromium.launch();
}

// Waits for fonts, images, and the network to go quiet. The app polls, so a
// quiet network is a best effort and never fails the shot.
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // Polling kept the network busy. The next checks still apply.
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((image) =>
        image.complete ? undefined : image.decode().catch(() => undefined)
      )
    );
  });
  await page.waitForTimeout(400);
}

// The app prints its own origin in a few places, such as the Linear callback
// URL. The port changes on every run, so the docs show the placeholder host.
async function maskOrigin(page: Page, origin: string): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeValue?.includes(from)) {
          node.nodeValue = node.nodeValue.replaceAll(from, to);
        }
      }
      for (const input of document.querySelectorAll("input, textarea")) {
        const field = input as HTMLInputElement;
        if (field.value.includes(from)) {
          field.value = field.value.replaceAll(from, to);
        }
      }
    },
    { from: origin, to: "https://datahub.example.com" }
  );
}

export async function captureShot(
  browser: Browser,
  shot: Shot,
  theme: Theme,
  world: World
): Promise<Buffer> {
  const base = shot.closeup ? CLOSEUP_VIEWPORT : WINDOW_VIEWPORT;
  const viewport = {
    width: shot.viewport?.width ?? base.width,
    height: shot.viewport?.height ?? base.height,
  };
  const context = await browser.newContext({
    viewport,
    // The app's content security policy blocks the injected style that hides
    // the dev server's overlays. Those overlays also block clicks.
    bypassCSP: true,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: theme,
    locale: "en-US",
    timezoneId: TIME_ZONE,
  });
  const cookie = await world.cookieFor(world.admin.userId);
  await context.addCookies([
    { name: cookie.name, value: cookie.value, url: world.baseUrl },
  ]);
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await context.addInitScript({ content: HIDE_OVERLAYS_SCRIPT });
  const page = await context.newPage();

  try {
    const route =
      typeof shot.path === "string" ? shot.path : await shot.path(world);
    await page.goto(`${world.baseUrl}${route}`, { waitUntil: "load" });
    await shot.ready(page);
    // A click before the page's scripts have loaded does nothing. That happens
    // on the first visit to a route, while the dev server is still compiling.
    await settle(page);
    await shot.steps?.({ page, theme, world });
    await settle(page);
    await maskOrigin(page, world.baseUrl);

    const options = {
      type: "png",
      animations: "disabled",
      caret: "hide",
      style: HIDE_CSS,
    } as const;

    if (!shot.closeup) {
      return await page.screenshot(options);
    }

    const box = await shot.closeup(page).boundingBox();
    if (!box) {
      throw new Error("The close-up element is not on screen");
    }
    const x = Math.max(0, box.x - CLOSEUP_MARGIN);
    const y = Math.max(0, box.y - CLOSEUP_MARGIN);
    return await page.screenshot({
      ...options,
      clip: {
        x,
        y,
        width: Math.min(viewport.width - x, box.width + CLOSEUP_MARGIN * 2),
        height: Math.min(viewport.height - y, box.height + CLOSEUP_MARGIN * 2),
      },
    });
  } catch (err) {
    await saveDebugScreenshot(page, shot.name, theme);
    throw err;
  } finally {
    await context.close();
  }
}

// A failed shot leaves its page behind in the scratch folder, because the
// error message rarely says what was on screen.
async function saveDebugScreenshot(
  page: Page,
  name: string,
  theme: Theme
): Promise<void> {
  const dir = path.join(WORK_DIR, "failures");
  mkdirSync(dir, { recursive: true });
  await page
    .screenshot({ path: path.join(dir, `${name}.${theme}.png`) })
    .catch(() => {
      // The page may already be closed.
    });
}
