import type { RunDetailProps } from "@/components/runs/run-detail";

import { DefaultRunDetail } from "./default-run-detail";
import { GelDocRunDetail } from "./gel-doc-run-detail";
import { PlateReaderRunDetail } from "./plate-reader-run-detail";

export type RunDetailVariantProps = RunDetailProps;

export function RunDetailVariant(props: RunDetailVariantProps) {
  switch (props.run.instrumentType) {
    case "plate_reader":
      return <PlateReaderRunDetail {...props} />;
    case "gel_doc":
      return <GelDocRunDetail {...props} />;
    default:
      return <DefaultRunDetail {...props} />;
  }
}
