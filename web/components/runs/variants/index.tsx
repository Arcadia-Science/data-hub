import type { RunDetailProps } from "@/components/runs/run-detail";

import { AuntyRunDetail } from "./aunty-run-detail";
import { DefaultRunDetail } from "./default-run-detail";
import { DishcamRunDetail } from "./dishcam-run-detail";
import { EpsonScannerRunDetail } from "./epson-scanner-run-detail";
import { GelDocRunDetail } from "./gel-doc-run-detail";
import { HinaMicroscopeRunDetail } from "./hina-microscope-run-detail";
import { InstantRamanRunDetail } from "./instant-raman-run-detail";
import { PlateReaderRunDetail } from "./plate-reader-run-detail";
import { QpcrRunDetail } from "./qpcr-run-detail";
import { TapeStationRunDetail } from "./tape-station-run-detail";

export type RunDetailVariantProps = RunDetailProps;

export function RunDetailVariant(props: RunDetailVariantProps) {
  return (
    <div className="flex flex-col gap-6">{renderRunDetailVariant(props)}</div>
  );
}

function renderRunDetailVariant(props: RunDetailVariantProps) {
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
    case "epson_v700_scanner":
      return <EpsonScannerRunDetail {...props} />;
    case "instant_raman":
      return <InstantRamanRunDetail {...props} />;
    case "dishcam":
      return <DishcamRunDetail {...props} />;
    case "aunty":
      return <AuntyRunDetail {...props} />;
    default:
      return <DefaultRunDetail {...props} />;
  }
}
