import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sessions, users } from "./schema";

// Better Auth JWT plugin + `@better-auth/oauth-provider` tables.
// Field names match the 1.6.x plugin schemas (camelCase columns, same as
// `user` / `session` / `account`). Registered on the drizzle adapter under
// the exact Better Auth model keys (`jwks`, `oauthClient`, …).

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull(),
  expiresAt: timestamp("expiresAt", { mode: "date" }),
  // Written by the jwt plugin when minting key pairs; not in the typed
  // schema but required at verify/sign time.
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClients = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId").notNull().unique(),
    clientSecret: text("clientSecret"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skipConsent"),
    enableEndSession: boolean("enableEndSession"),
    subjectType: text("subjectType"),
    scopes: text("scopes").array(),
    userId: text("userId").references(() => users.id),
    createdAt: timestamp("createdAt", { mode: "date" }),
    updatedAt: timestamp("updatedAt", { mode: "date" }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("softwareId"),
    softwareVersion: text("softwareVersion"),
    softwareStatement: text("softwareStatement"),
    redirectUris: text("redirectUris").array().notNull(),
    postLogoutRedirectUris: text("postLogoutRedirectUris").array(),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    grantTypes: text("grantTypes").array(),
    responseTypes: text("responseTypes").array(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("requirePKCE"),
    referenceId: text("referenceId"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauthClient_userId_idx").on(t.userId)]
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClients.clientId),
    sessionId: text("sessionId").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("userId")
      .notNull()
      .references(() => users.id),
    referenceId: text("referenceId"),
    expiresAt: timestamp("expiresAt", { mode: "date" }),
    createdAt: timestamp("createdAt", { mode: "date" }),
    revoked: timestamp("revoked", { mode: "date" }),
    authTime: timestamp("authTime", { mode: "date" }),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauthRefreshToken_clientId_idx").on(t.clientId),
    index("oauthRefreshToken_sessionId_idx").on(t.sessionId),
    index("oauthRefreshToken_userId_idx").on(t.userId),
  ]
);

export const oauthAccessTokens = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClients.clientId),
    sessionId: text("sessionId").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("userId").references(() => users.id),
    referenceId: text("referenceId"),
    refreshId: text("refreshId").references(() => oauthRefreshTokens.id),
    expiresAt: timestamp("expiresAt", { mode: "date" }),
    createdAt: timestamp("createdAt", { mode: "date" }),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauthAccessToken_clientId_idx").on(t.clientId),
    index("oauthAccessToken_sessionId_idx").on(t.sessionId),
    index("oauthAccessToken_userId_idx").on(t.userId),
    index("oauthAccessToken_refreshId_idx").on(t.refreshId),
  ]
);

export const oauthConsents = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClients.clientId),
    userId: text("userId").references(() => users.id),
    referenceId: text("referenceId"),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }),
    updatedAt: timestamp("updatedAt", { mode: "date" }),
  },
  (t) => [
    index("oauthConsent_clientId_idx").on(t.clientId),
    index("oauthConsent_userId_idx").on(t.userId),
  ]
);
