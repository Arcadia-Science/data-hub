import type { LucideIcon } from "lucide-react";
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Cloud,
  CloudUpload,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import type { RunFile } from "@/lib/api/instrument-runs";

export type FileStatusDisplayKey =
  | "pending"
  | "uploading"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed"
  | "dismissed";

export type FileStatusLegendSectionKey =
  | "waiting"
  | "in_motion"
  | "done"
  | "removed";

interface FileStatusConfigEntry {
  className: string;
  description: string;
  Icon: LucideIcon;
  label: string;
  spin?: boolean;
}

export function statusLabel(file: RunFile): string {
  return FILE_STATUS_CONFIG[getFileStatusKey(file)].label;
}

export function getFileStatusKey(file: RunFile): FileStatusDisplayKey {
  if (file.deletedAt !== null) {
    return "dismissed";
  }
  switch (file.status) {
    case "detected":
      return "pending";
    case "upload_requested":
      return "uploading";
    case "uploaded":
      return "uploaded";
    case "processing":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export const FILE_STATUS_CONFIG: Record<
  FileStatusDisplayKey,
  FileStatusConfigEntry
> = {
  pending: {
    label: "Pending",
    description: "found, not yet uploaded",
    Icon: Clock,
    className: "text-muted-foreground",
  },
  uploaded: {
    label: "Uploaded",
    description: "stored, awaiting processing",
    Icon: Cloud,
    className: "text-muted-foreground",
  },
  uploading: {
    label: "Uploading",
    description: "transfer in progress",
    Icon: CloudUpload,
    className: "text-blue-700 dark:text-blue-400",
  },
  processing: {
    label: "Processing",
    description: "being analyzed",
    Icon: LoaderCircle,
    className: "text-blue-700 dark:text-blue-400",
    spin: true,
  },
  completed: {
    label: "Completed",
    description: "processed OK",
    Icon: CircleCheck,
    className: "text-green-700 dark:text-green-500",
  },
  failed: {
    label: "Failed",
    description: "error, can retry",
    Icon: CircleAlert,
    className: "text-destructive",
  },
  dismissed: {
    label: "Dismissed",
    description: "removed from queue",
    Icon: Trash2,
    className: "text-muted-foreground opacity-60",
  },
};

export const FILE_STATUS_LEGEND_SECTIONS: {
  key: FileStatusLegendSectionKey;
  title: string;
  statuses: FileStatusDisplayKey[];
}[] = [
  {
    key: "waiting",
    title: "Waiting",
    statuses: ["pending", "uploaded"],
  },
  {
    key: "in_motion",
    title: "In motion",
    statuses: ["uploading", "processing"],
  },
  {
    key: "done",
    title: "Done",
    statuses: ["completed", "failed"],
  },
  {
    key: "removed",
    title: "Removed",
    statuses: ["dismissed"],
  },
];
