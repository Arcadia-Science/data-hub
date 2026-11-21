import type { FileDeleteOutcome } from "@/lib/api/file-batch";
import type { TokenRef } from "@/lib/api/file-deleters";
import type {
  DeletedLinkedFile,
  FileActionFailure,
  LinkedFile,
  RestoredLinkedFile,
  RestoreFileResult,
} from "@/lib/api/file-deletion";
import type { LinkedFileRelation } from "@/lib/runs/file-links";

// The REST shape of deleting and restoring files. A person and a token sit in
// separate fields, the way the runs API reports who deleted a run: `deleted_by`
// is the person's user ID, and `deleted_by_token` is the token's `{ id, name }`.
// At most one is set, and both are null for a file deleted before Data Hub
// recorded who did it.
//
// One shape serves every route that acts on files. A route for one file answers
// with the file's own fields, and a failure is its HTTP error. A route for
// several files lists a result for each, where a failure keeps the fields of
// that HTTP error under `error` and its status under `status`.

export interface FileErrorWire {
  code: string;
  details?: Record<string, unknown>;
  message: string;
}

export interface FileFailureWire {
  error: FileErrorWire;
  // The file's name when the file exists, and null when it doesn't.
  filename: string | null;
  id: number;
  ok: false;
  status: number;
}

export interface FileDeletedWire {
  already_applied: boolean;
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_token: TokenRef | null;
  filename: string;
  id: number;
}

export type FileDeleteResultWire =
  | ({ ok: true } & FileDeletedWire)
  | FileFailureWire;

export interface FileRestoredWire {
  already_applied: boolean;
  // Always null: a restored file is not deleted any more.
  deleted_at: null;
  filename: string;
  id: number;
}

export type FileRestoreResultWire =
  | ({ ok: true } & FileRestoredWire)
  | FileFailureWire;

// A file that went along with the one asked for, and how it fared.
export interface LinkedDeleteWire {
  already_applied: false;
  deleted_at: string;
  filename: string;
  id: number;
  ok: true;
  relation: LinkedFileRelation;
}

export type LinkedRestoreWire = FileRestoreResultWire & {
  relation: LinkedFileRelation;
};

export interface LinkedFileWire {
  category: LinkedFile["category"];
  deleted_at: string | null;
  filename: string;
  id: number;
  relation: LinkedFileRelation;
  size_bytes: number | null;
}

export interface LinkedFilesGroupWire {
  file_id: number;
  linked: LinkedFileWire[];
}

// A file that couldn't be changed. The MCP tools use this shape too: it has no
// key that would change in camelCase.
export function fileFailureToWire(failure: FileActionFailure): FileFailureWire {
  return {
    ok: false,
    id: failure.id,
    filename: failure.filename ?? null,
    status: failure.status,
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.details && { details: failure.details }),
    },
  };
}

type DeleteSuccess = Extract<FileDeleteOutcome, { ok: true }>;

export function deletedFileToWire(result: DeleteSuccess): FileDeletedWire {
  return {
    id: result.id,
    filename: result.filename,
    deleted_at: result.deletedAt.toISOString(),
    deleted_by: result.deletedBy,
    deleted_by_token: result.deletedByToken,
    already_applied: result.alreadyApplied,
  };
}

export function deleteResultToWire(
  result: FileDeleteOutcome
): FileDeleteResultWire {
  return result.ok
    ? { ok: true, ...deletedFileToWire(result) }
    : fileFailureToWire(result);
}

export function linkedDeleteToWire(file: DeletedLinkedFile): LinkedDeleteWire {
  return {
    ok: true,
    id: file.id,
    filename: file.filename,
    relation: file.relation,
    already_applied: false,
    deleted_at: file.deletedAt.toISOString(),
  };
}

type RestoreSuccess = Extract<RestoreFileResult, { ok: true }>;

export function restoredFileToWire(result: RestoreSuccess): FileRestoredWire {
  return {
    id: result.id,
    filename: result.filename,
    deleted_at: null,
    already_applied: result.alreadyApplied,
  };
}

export function restoreResultToWire(
  result: RestoreFileResult
): FileRestoreResultWire {
  return result.ok
    ? { ok: true, ...restoredFileToWire(result) }
    : fileFailureToWire(result);
}

export function linkedRestoreToWire(
  file: RestoredLinkedFile
): LinkedRestoreWire {
  return { ...restoreResultToWire(file), relation: file.relation };
}

export function linkedFilesToWire(
  groups: readonly {
    fileId: number;
    linked: readonly LinkedFile[];
  }[]
): LinkedFilesGroupWire[] {
  return groups.map((group) => ({
    file_id: group.fileId,
    linked: group.linked.map((file) => ({
      id: file.id,
      filename: file.filename,
      size_bytes: file.sizeBytes,
      category: file.category,
      relation: file.relation,
      deleted_at: file.deletedAt?.toISOString() ?? null,
    })),
  }));
}
