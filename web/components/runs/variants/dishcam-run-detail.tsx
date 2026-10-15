import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";
import { posterFileIdsByVideoFilename } from "@/lib/runs/run-file-types";

export function DishcamRunDetail(props: RunDetailProps) {
  return (
    <RunDetailLayout {...props}>
      <RunDetail.VideoCarousel
        initialPage={props.reportItems}
        posterFileIds={posterFileIdsByVideoFilename(props.reportFiles)}
      />
    </RunDetailLayout>
  );
}
