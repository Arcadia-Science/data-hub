import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaCarouselReport } from "@/components/runs/media-carousel-report";
import { ReportDataSourceProvider } from "@/components/runs/report-data-source-provider";
import type { ReportItem, ReportItemsPage } from "@/lib/runs/report-items";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

// `peekFileUrl` answers during render, so the server markup already holds
// the URLs the browser would load.
const dataSource: ReportDataSource = {
  fetchReportItems: () => Promise.reject(new Error("not used")),
  fetchTableRows: () => Promise.reject(new Error("not used")),
  peekFileUrl: (fileId) => `/files/${fileId}`,
  resolveFileUrl: (fileId) => `/files/${fileId}`,
};

function render(items: ReportItem[]): string {
  const page: ReportItemsPage = {
    data: items,
    pagination: { limit: 50, offset: 0, total: items.length },
  };
  return renderToStaticMarkup(
    createElement(
      DataSourceProvider,
      { dataSource },
      createElement(MediaCarouselReport, { initialPage: page })
    )
  );
}

// `createElement` takes children as an argument, so the props type leaves
// them optional.
const DataSourceProvider = ReportDataSourceProvider as FunctionComponent<{
  children?: ReactNode;
  dataSource: ReportDataSource;
}>;

describe("MediaCarouselReport", () => {
  it("plays a video with its poster image", () => {
    const html = render([{ id: 5, filename: "well_A1.mp4", poster_id: 4 }]);

    expect(html).toContain("<video");
    expect(html).toContain('src="/files/5"');
    expect(html).toContain('poster="/files/4"');
    expect(html).not.toContain("<img");
  });

  it("plays a video that has no poster", () => {
    const html = render([{ id: 5, filename: "well_A1.mp4", poster_id: null }]);

    expect(html).toContain("<video");
    expect(html).not.toContain("poster=");
  });

  it("shows an image when the file has no video", () => {
    const html = render([{ id: 7, filename: "well_A2.jpg", poster_id: null }]);

    expect(html).toContain("<img");
    expect(html).toContain('src="/files/7"');
    expect(html).not.toContain("<video");
  });
});
