import { z } from "zod";

// Shared `ActorUser` wire shape: retired/deregistered/deleted-by actors and
// run attributions all round-trip the same four fields.
export const mcpActorUserSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
});

// A personal access token that acted on its own. Sits beside the matching
// `*ByUser` field, which is null for token-written rows.
export const mcpActorTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
});
