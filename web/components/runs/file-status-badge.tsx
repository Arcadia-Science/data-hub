import { Badge } from "@/components/ui/badge";

type FileStatus =
  | "detected"
  | "upload_requested"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";

const statusConfig: Record<
  FileStatus,
  {
    label: string;
    variant: "default" | "outline" | "secondary" | "destructive";
  }
> = {
  detected: { label: "Detected", variant: "outline" },
  upload_requested: { label: "Upload Requested", variant: "secondary" },
  uploaded: { label: "Uploaded", variant: "secondary" },
  processing: { label: "Processing", variant: "default" },
  completed: { label: "Completed", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
};

export function FileStatusBadge({ status }: { status: string }) {
  const config = statusConfig[status as FileStatus] ?? {
    label: status,
    variant: "outline" as const,
  };

  return (
    <Badge className="text-[10px]" variant={config.variant}>
      {config.label}
    </Badge>
  );
}
