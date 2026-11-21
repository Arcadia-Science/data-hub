import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SortableTableHead,
  type SortOrder,
} from "@/components/sortable-table-head";

function render(props: { active: boolean; order: SortOrder }): string {
  return renderToStaticMarkup(
    createElement(
      "table",
      null,
      createElement(
        "thead",
        null,
        createElement(
          "tr",
          null,
          createElement(SortableTableHead, {
            ...props,
            label: "Size",
            onOrderChange: () => undefined,
            trailing: createElement("span", null, "legend"),
          })
        )
      )
    )
  );
}

describe("SortableTableHead", () => {
  it("tells assistive technology the direction of the sorted column", () => {
    expect(render({ active: true, order: "asc" })).toContain(
      'aria-sort="ascending"'
    );
    expect(render({ active: true, order: "desc" })).toContain(
      'aria-sort="descending"'
    );
  });

  it("leaves aria-sort off a column the table is not sorted by", () => {
    expect(render({ active: false, order: "desc" })).not.toContain("aria-sort");
  });

  it("renders the trailing control beside the sort button", () => {
    const html = render({ active: false, order: "asc" });
    expect(html).toContain(">Size</button>");
    expect(html.indexOf("Size</button>")).toBeLessThan(html.indexOf("legend"));
  });
});
