// Every docs screenshot the script retakes, in the order it takes them.
//
// To add one: add an entry here, run
// `npm run docs:screenshots -- --only <name>`, then reference
// `/images/<name>.webp` from a docs page. Order matters in two places. The
// integrations shot comes before any feedback shot, because feedback connects
// Linear. The shots that change data come last, and undo their change.

import { eq } from "drizzle-orm";
import type { Locator, Page } from "playwright";
import { personalAccessTokens, watchers } from "@/lib/db/schema";
import {
  addPendingUploadRun,
  insertConsentClient,
  pendingUploadRunPath,
  removePendingUploadRun,
  setRunDeleted,
  type World,
} from "./setup";
import type { ManualShot, Shot } from "./types";

// Shown in the browser frame where the real address holds a random ID.
const EXAMPLE_ID = "3f2a9c1e-7b4d-4e0a-9c55-1d2e8f6a7b90";

// Run pages are long, so they get a taller window than the default.
const RUN_PAGE = { height: 1100 } as const;

const GEL_DOC_RUN = "/instruments/azure-600-gel-doc/runs/26.02.02_10.45.05";
const PLATE_READER_RUN =
  "/instruments/spectramax-id5-plate-reader/runs/260721_OD750_AAA";
const KINETIC_RUN =
  "/instruments/spectramax-id5-plate-reader/runs/260710_OD595_kinetic_EEE";

const DELETED_RUN = {
  instrumentId: "spectramax-id5-plate-reader",
  runId: "260720_OD595_flat_BBB",
} as const;

const TOKEN_NAME = "Gel doc watcher, Lab 204";
// Same length as a real token, so the layout does not change.
const PLACEHOLDER_TOKEN = `dhub_${"0123456789abcdef".repeat(4)}`;

const waitFor = (page: Page, text: string | RegExp) =>
  page.getByText(text).first().waitFor();

const connectLinear = (world: World) => world.ensureLinearConnected();

async function openAccountMenu(page: Page, item: string | RegExp) {
  await page.getByText("Alice Zimmerman").first().click();
  await page.getByRole("menuitem", { name: item }).click();
  await page.getByRole("dialog").waitFor();
}

// Retiring asks for confirmation in an alert dialog, which has its own role.
async function openInstrumentMenu(
  page: Page,
  item: string,
  row: RegExp,
  dialogRole: "dialog" | "alertdialog" = "dialog"
) {
  await page.getByRole("row", { name: row }).getByRole("button").last().click();
  await page.getByRole("menuitem", { name: item }).click();
  await page.getByRole(dialogRole).waitFor();
}

// Tabs are server-rendered, so a click that lands before hydration is lost.
// Clicking again after a short wait gets past that without a fixed delay.
async function clickUntilVisible(
  target: Locator,
  expected: Locator,
  attempts = 5
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await target.click();
    try {
      await expected.first().waitFor({ timeout: 3000 });
      return;
    } catch (err) {
      if (attempt === attempts) {
        throw err;
      }
    }
  }
}

async function scrollToBottom(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
}

async function fillTokenForm(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder(/Plate Reader PC/).fill(TOKEN_NAME);
  await dialog.getByRole("button", { name: "Watcher", exact: true }).click();
}

export const SHOTS: Shot[] = [
  // Web app tour, from Browse and analyze runs.
  {
    name: "home",
    pages: ["browse-runs", "home"],
    path: "/",
    ready: (page) => waitFor(page, "Recent instrument runs"),
  },
  {
    name: "plate-reader-runs-table",
    pages: ["browse-runs"],
    path: "/instruments/spectramax-id5-plate-reader",
    ready: (page) => waitFor(page, "260721_OD750_AAA"),
  },
  {
    name: "my-runs",
    pages: ["browse-runs"],
    path: (world) => `/users/${world.admin.userId}`,
    address: `/users/${EXAMPLE_ID}`,
    ready: (page) => waitFor(page, "Recent instrument runs"),
  },
  {
    name: "search-modal",
    pages: ["browse-runs"],
    path: "/",
    ready: (page) => waitFor(page, "Recent instrument runs"),
    steps: async ({ page }) => {
      await page.keyboard.press("Control+k");
      const input = page.getByPlaceholder(/Search runs, files/);
      await input.fill("colony");
      await waitFor(page, /results for "colony"/);
    },
  },
  {
    name: "gel-doc-run-details",
    pages: ["browse-runs"],
    path: GEL_DOC_RUN,
    viewport: RUN_PAGE,
    ready: (page) => waitFor(page, "Report Data"),
  },
  {
    name: "plate-reader-run-details-1",
    pages: ["browse-runs", "home"],
    path: PLATE_READER_RUN,
    viewport: RUN_PAGE,
    ready: (page) => waitFor(page, "Plate Maps"),
  },
  {
    name: "plate-reader-run-details-2",
    pages: ["browse-runs"],
    path: KINETIC_RUN,
    viewport: RUN_PAGE,
    ready: (page) => waitFor(page, "Plate Maps"),
    steps: async ({ page }) => {
      await waitFor(page, "Comments (1)");
      await scrollToBottom(page);
    },
  },
  {
    name: "bulk-actions",
    pages: ["browse-runs"],
    path: "/instruments/azure-600-gel-doc",
    ready: (page) => waitFor(page, "26.01.26_15.10.30"),
    steps: async ({ page }) => {
      for (const runId of [
        "26.01.26_15.10.30",
        "26.01.05_09.30.00",
        "26.01.12_14.22.18",
      ]) {
        await page
          .getByRole("row", { name: new RegExp(runId.replaceAll(".", "\\.")) })
          .getByRole("checkbox")
          .check();
      }
      await waitFor(page, "3 runs selected");
    },
  },
  {
    name: "gel-doc-run-comments",
    pages: ["browse-runs"],
    path: GEL_DOC_RUN,
    viewport: RUN_PAGE,
    ready: (page) => waitFor(page, "Comments (3)"),
    steps: async ({ page }) => {
      await scrollToBottom(page);
    },
  },
  {
    name: "comments-page",
    pages: ["browse-runs"],
    path: "/comments",
    ready: (page) => waitFor(page, "All comments"),
  },
  {
    name: "csv-preview",
    pages: ["browse-runs"],
    path: PLATE_READER_RUN,
    viewport: RUN_PAGE,
    closeup: (page) => page.getByRole("dialog"),
    ready: (page) => waitFor(page, "260721_OD750_AAA_raw_well_data.csv"),
    steps: async ({ page }) => {
      await page.getByText("260721_OD750_AAA_raw_well_data.csv").click();
      await page.getByRole("dialog").getByRole("table").waitFor();
    },
  },
  {
    name: "notification-bell",
    pages: ["configure-notifications"],
    path: "/",
    closeup: (page) => page.getByRole("dialog"),
    ready: (page) => waitFor(page, "Recent instrument runs"),
    steps: async ({ page }) => {
      await page
        .getByRole("button", { name: /notification/i })
        .first()
        .click();
      await waitFor(page, "Mark all read");
    },
  },
  {
    name: "notifications",
    pages: ["configure-notifications"],
    path: "/settings/notifications",
    ready: (page) => waitFor(page, "Notifications"),
  },

  // Instruments, watchers, and run processing.
  {
    name: "instruments-table",
    pages: ["manage-instruments"],
    path: "/instruments",
    ready: (page) => waitFor(page, "Agilent 4150 TapeStation"),
  },
  {
    name: "instruments-pending",
    pages: ["set-up-an-instrument", "manage-instruments"],
    path: "/instruments?tab=pending",
    ready: (page) => page.getByRole("button", { name: "Confirm" }).waitFor(),
  },
  {
    name: "instrument-edit-dialog",
    pages: ["manage-instruments", "instrument-preprocessing"],
    path: "/instruments",
    address: "/instruments",
    closeup: (page) => page.getByRole("dialog"),
    ready: (page) => waitFor(page, "Azure 600 Gel Doc"),
    steps: async ({ page }) => {
      await openInstrumentMenu(page, "Edit details", /Azure 600 Gel Doc/);
      // The dialog selects the name shortly after it opens. Waiting, then
      // moving the cursor to the end, clears the highlight.
      await page.waitForTimeout(500);
      await page
        .getByRole("dialog")
        .getByRole("textbox")
        .first()
        .evaluate((input: HTMLInputElement) => {
          input.setSelectionRange(input.value.length, input.value.length);
        });
    },
  },
  {
    name: "instrument-retire-dialog",
    pages: ["retire-an-instrument"],
    path: "/instruments",
    closeup: (page) => page.getByRole("alertdialog"),
    ready: (page) => waitFor(page, "Azure 600 Gel Doc"),
    steps: async ({ page }) => {
      await openInstrumentMenu(
        page,
        "Retire",
        /Azure 600 Gel Doc/,
        "alertdialog"
      );
    },
  },
  {
    name: "watchers-list",
    pages: ["manage-watchers"],
    path: "/watchers",
    ready: (page) => waitFor(page, "Azure 600 Gel Doc"),
  },
  {
    name: "watcher-detail",
    pages: ["manage-watchers"],
    path: async (world) => {
      const [watcher] = await world.db
        .select({ id: watchers.id })
        .from(watchers)
        .where(eq(watchers.instrumentId, "azure-600-gel-doc"))
        .limit(1);
      return `/watchers/${watcher.id}`;
    },
    address: `/watchers/${EXAMPLE_ID}`,
    ready: (page) => waitFor(page, "Event Log"),
    steps: async ({ page }) => {
      await clickUntilVisible(
        page.getByText("Status", { exact: true }).first(),
        page.getByText("Connectivity")
      );
    },
  },
  {
    name: "qpcr-run-detail",
    pages: ["instrument-preprocessing"],
    path: "/instruments/azure-cielo-qpcr/runs/Experiment_20260129",
    viewport: { height: 1250 },
    ready: (page) => waitFor(page, "Melting Curves"),
    steps: async ({ page }) => {
      // Channel 1 of the sample file is flat. Channel 2 has real curves.
      await page
        .getByRole("combobox", { name: "Channel", exact: true })
        .click();
      await page.getByRole("option", { name: "Channel2" }).click();
      await page.locator('[data-well="A1"]').waitFor();
    },
  },
  {
    name: "aunty-run-detail",
    pages: ["instrument-preprocessing"],
    path: "/instruments/unchained-labs-aunty/runs/2026-03-15T09-18-44",
    viewport: { height: 1250 },
    ready: (page) => waitFor(page, "Report Data"),
  },

  // Settings.
  {
    name: "workspace-members",
    pages: ["manage-members"],
    path: "/settings/members",
    ready: (page) => waitFor(page, "bob@example.com"),
  },
  {
    name: "watcher-settings",
    pages: ["watcher-releases"],
    path: "/settings/watchers",
    ready: (page) => waitFor(page, "Latest version"),
  },
  {
    name: "tokens-list",
    pages: ["manage-tokens", "set-up-an-instrument"],
    path: "/settings/tokens",
    ready: (page) => waitFor(page, "FPLC watcher, Lab 201"),
  },
  {
    name: "token-create-dialog",
    pages: ["manage-tokens", "set-up-an-instrument"],
    path: "/settings/tokens",
    closeup: (page) => page.getByRole("dialog"),
    ready: (page) => waitFor(page, "FPLC watcher, Lab 201"),
    steps: async ({ page }) => {
      await page.getByRole("button", { name: "Create token" }).click();
      await fillTokenForm(page);
      await waitFor(page, "This token will be able to:");
    },
  },
  {
    name: "token-created",
    pages: ["manage-tokens"],
    path: "/settings/tokens",
    closeup: (page) => page.getByRole("dialog"),
    ready: (page) => waitFor(page, "FPLC watcher, Lab 201"),
    steps: async ({ page }) => {
      await page.getByRole("button", { name: "Create token" }).click();
      await fillTokenForm(page);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Create token" })
        .click();
      const token = page.getByRole("dialog").locator("code");
      await token.waitFor();
      // The real token is a throwaway, but the docs should never show one.
      await token.evaluate((el, text) => {
        el.textContent = text;
      }, PLACEHOLDER_TOKEN);
    },
    // Creating the token wrote a row. Later shots list tokens, so remove it.
    cleanup: async (world) => {
      await world.db
        .delete(personalAccessTokens)
        .where(eq(personalAccessTokens.name, TOKEN_NAME));
    },
  },
  {
    // Before any feedback shot, because those connect Linear.
    name: "integrations",
    pages: ["integrations"],
    path: "/settings/integrations",
    viewport: { height: 1100 },
    prepare: (world) => world.disconnectLinear(),
    ready: (page) => waitFor(page, "Connect your Linear app"),
  },

  // Feedback, which needs Linear connected.
  {
    name: "feedback-send-dialog",
    pages: ["send-feedback"],
    path: "/",
    closeup: (page) => page.getByRole("dialog"),
    prepare: connectLinear,
    ready: (page) => waitFor(page, "Recent instrument runs"),
    steps: async ({ page }) => {
      await openAccountMenu(page, "Feedback");
      const dialog = page.getByRole("dialog");
      await dialog
        .getByPlaceholder(/Export fails/)
        .fill("Plate map colors don't match the legend");
      await dialog
        .getByPlaceholder(/What you expected/)
        .fill(
          "On a 384-well kinetic run the bottom rows use the same blue as the legend's lowest value."
        );
    },
  },
  {
    name: "feedback-review",
    pages: ["send-feedback"],
    path: "/settings/feedback",
    prepare: connectLinear,
    ready: (page) => waitFor(page, "Plate map colors don't match the legend"),
  },
  {
    name: "changelog-dialog",
    pages: ["send-feedback"],
    path: "/",
    closeup: (page) => page.getByRole("dialog"),
    ready: (page) => waitFor(page, "Recent instrument runs"),
    steps: async ({ page }) => {
      await openAccountMenu(page, "Changelog");
      await waitFor(page, /newest first/);
    },
  },
  {
    name: "mcp-consent",
    pages: ["mcp"],
    path: "/consent?client_id=docs-claude&scope=openid%20read%20write",
    address: "/consent",
    viewport: { height: 600 },
    prepare: (world) => insertConsentClient(world, "docs-claude"),
    ready: (page) => waitFor(page, "Authorize application"),
  },

  // These change data, so they run last and undo it.
  {
    name: "manual-upload",
    pages: ["manage-watchers", "browse-runs"],
    path: pendingUploadRunPath(),
    viewport: { height: 900 },
    prepare: addPendingUploadRun,
    cleanup: removePendingUploadRun,
    ready: (page) => waitFor(page, /Files \(6 raw/),
    // Selecting the files opens the bar with Upload and Dismiss. The row
    // buttons only appear on hover, so this is how the screenshot shows them.
    steps: async ({ page }) => {
      await page.getByRole("table").getByRole("checkbox").first().check();
      await page.getByRole("button", { name: "Dismiss" }).first().waitFor();
    },
  },
  {
    name: "deleted-run",
    pages: ["browse-runs"],
    path: `/instruments/${DELETED_RUN.instrumentId}/runs/${DELETED_RUN.runId}`,
    prepare: (world) =>
      setRunDeleted(world, DELETED_RUN.instrumentId, DELETED_RUN.runId, true),
    cleanup: (world) =>
      setRunDeleted(world, DELETED_RUN.instrumentId, DELETED_RUN.runId, false),
    ready: (page) => page.getByRole("button", { name: "Restore" }).waitFor(),
  },
];

export const MANUAL_SHOTS: readonly ManualShot[] = [
  {
    name: "mcp",
    lastTaken: "2026-07-22",
    pages: ["home"],
    note: "The Claude desktop app answering a question about microscope runs over MCP. Retake it by hand when the Claude app or the MCP setup changes.",
  },
];
