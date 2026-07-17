import { z } from "zod";

export const searchQuery = z.object({
  q: z.string().optional(),
  scope: z
    .enum(["all", "runs", "files", "instruments", "users", "comments"])
    .optional(),
});

export const searchResponse = z.object({
  runs: z.array(z.record(z.string(), z.unknown())),
  files: z.array(z.record(z.string(), z.unknown())),
  instruments: z.array(z.record(z.string(), z.unknown())),
  users: z.array(z.record(z.string(), z.unknown())),
  comments: z.array(z.record(z.string(), z.unknown())),
});
