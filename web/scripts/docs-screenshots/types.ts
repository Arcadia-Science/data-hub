import type { Page } from "playwright";
import type { World } from "./setup";

export type Theme = "light" | "dark";

export const THEMES: readonly Theme[] = ["light", "dark"];

export interface ShotContext {
  page: Page;
  theme: Theme;
  world: World;
}

export interface Shot {
  /** Address bar text, when the opened path has more than the docs should show. */
  address?: string;
  /** Runs after both themes are captured, to undo what `prepare` changed. */
  cleanup?: (world: World) => Promise<void>;
  /**
   * Crops to this element plus some margin. Leave it out for a full window,
   * which the docs site draws inside a browser frame.
   */
  closeup?: (page: Page) => ReturnType<Page["locator"]>;
  /** File name without the extension. The dark version adds `.dark`. */
  name: string;
  /** The docs pages that show it. Used in reports, not to place images. */
  pages: readonly string[];
  /** The route to open. Computed from the seeded data when it names a run. */
  path: string | ((world: World) => string | Promise<string>);
  /** Runs once, before the first theme. Must be safe to run twice. */
  prepare?: (world: World) => Promise<void>;
  /** Resolves when the page shows what the screenshot is about. */
  ready: (page: Page) => Promise<void>;
  /** Clicks and typing after the page is ready, in each theme. */
  steps?: (context: ShotContext) => Promise<void>;
  /** Taller or wider than the default window, for pages that need it. */
  viewport?: { height?: number; width?: number };
}

export interface ManualShot {
  /** `YYYY-MM-DD`, from the date visible in the image. */
  lastTaken: string;
  name: string;
  /** What the screenshot shows and how to retake it. */
  note: string;
  pages: readonly string[];
}
