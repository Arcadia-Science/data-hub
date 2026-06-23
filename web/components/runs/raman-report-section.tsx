import { RamanSpectrumViewer } from "@/components/runs/raman-spectrum-viewer";
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
        <h2 className="font-semibold text-sm">Report Data</h2>
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
      <h2 className="font-semibold text-sm">
        Report Data{" "}
        <span className="ml-1 font-mono font-normal text-muted-foreground text-xs">
          {spectra.length} {spectra.length === 1 ? "spectrum" : "spectra"}
        </span>
      </h2>
      <Card size="sm">
        <CardContent>
          <RamanSpectrumViewer spectra={spectra} />
        </CardContent>
      </Card>
    </div>
  );
}
