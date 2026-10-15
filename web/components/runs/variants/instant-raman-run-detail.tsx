import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";

export function InstantRamanRunDetail(props: RunDetailProps) {
  return (
    <RunDetailLayout {...props}>
      <RunDetail.RamanReport initialPage={props.reportItems} />
    </RunDetailLayout>
  );
}
