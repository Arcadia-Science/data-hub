import { RamanSpectrumViewer } from "@/components/runs/raman-spectrum-viewer";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Card, CardContent } from "@/components/ui/card";

export interface RamanSpectrumFileRef {
  fileId: number;
  filename: string;
}

export function RamanReportSection({
  spectra,
}: {
  spectra: RamanSpectrumFileRef[];
}) {
  if (spectra.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <RunSectionHeading title="Report Data" />
        <Card size="sm">
          <CardContent>
            <p className="text-muted-foreground text-sm">
              No report data has been generated for this run.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <RunSectionHeading countLabel={spectra.length} title="Report Data" />
      <Card size="sm">
        <CardContent>
          <RamanSpectrumViewer spectra={spectra} />
        </CardContent>
      </Card>
    </div>
  );
}
