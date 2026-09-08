import { z } from "zod";

// Caps keep a single dispatch bounded: 50 recipients per call, 500 chars of
// message (the bell preview-truncates to 240 either way).
export const dispatchNotificationsBody = z.object({
  user_ids: z.array(z.string().min(1)).min(1).max(50),
  message: z.string().trim().min(1).max(500),
  // Optional run anchor, by natural key — external callers know instrument
  // IDs and run display IDs from the API, not internal UUIDs.
  run: z
    .object({
      instrument_id: z.string().min(1),
      run_id: z.string().min(1),
    })
    .optional(),
});

export const dispatchNotificationsResult = z
  .object({
    notified_user_ids: z.array(z.string()),
    skipped_user_ids: z.array(z.string()),
  })
  .openapi("DispatchNotificationsResult");
