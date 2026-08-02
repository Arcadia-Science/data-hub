import { toNextJsHandler } from "better-auth/next-js";
import { authInstance } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(authInstance);
