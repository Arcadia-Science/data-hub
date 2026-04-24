import type { RunDetailProps } from "@/components/runs/run-detail";

import { DefaultRunDetail } from "./default-run-detail";
import { GelDocRunDetail } from "./gel-doc-run-detail";
import { HinaMicroscopeRunDetail } from "./hina-microscope-run-detail";
import { PlateReaderRunDetail } from "./plate-reader-run-detail";
import { QpcrRunDetail } from "./qpcr-run-detail";
import { TapeStationRunDetail } from "./tape-station-run-detail";

export type RunDetailVariantProps = RunDetailProps;

export function RunDetailVariant(props: RunDetailVariantProps) {
  switch (props.run.instrumentType) {
    case "plate_reader":
      return <PlateReaderRunDetail {...props} />;
    case "gel_doc":
      return <GelDocRunDetail {...props} />;
    case "qpcr":
      return <QpcrRunDetail {...props} />;
    case "tape_station":
      return <TapeStationRunDetail {...props} />;
    case "hina_microscope":
      return <HinaMicroscopeRunDetail {...props} />;
    default:
      return <DefaultRunDetail {...props} />;
  }
}
