/**
 * Scopes advertised to MCP clients in the RFC 9728 protected-resource metadata
 * and the `WWW-Authenticate` challenge. Clients copy this list into dynamic
 * client registration, and Better Auth validates every later authorize request
 * against the scopes stored on the client — so anything a client may ask for
 * has to be listed here.
 *
 * `offline_access` is not a resource scope, but Claude Code appends it to the
 * authorize request whenever the authorization server advertises it. Without it
 * on the registered client, that request fails with `invalid_scope`.
 */
export const MCP_ADVERTISED_SCOPES = [
  "read",
  "write",
  "offline_access",
] as const;
