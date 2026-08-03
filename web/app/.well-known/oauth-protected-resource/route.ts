import { createProtectedResourceHandlers } from "@/lib/mcp/protected-resource-metadata";

export const { GET, OPTIONS } = createProtectedResourceHandlers();
