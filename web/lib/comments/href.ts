import { createSerializer } from "nuqs/server";
import { commentsSearchParams } from "@/lib/search-params";

const serializeComments = createSerializer(commentsSearchParams);

export function commentsPath(
  values: Partial<{
    author: string | null;
    instrument_id: string[] | null;
    page: number | null;
    ran_by: string | null;
  }> = {}
): string {
  return serializeComments("/comments", values);
}
