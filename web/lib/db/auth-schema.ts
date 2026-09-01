/**
 * Better Auth JWT + `@better-auth/oauth-provider` tables.
 *
 * DO NOT hand-edit field lists — regenerate:
 *
 *   npm run db:generate-auth-schema
 *
 * That runs `npx auth@latest generate` (requires drizzleAdapter
 * `camelCase: true` on `lib/auth.ts`) and adapts the
 * plugin tables for this repo (snake_case SQL table names, plural exports,
 * FKs into `schema.ts` users/sessions, plus jwks alg/crv).
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sessions, users } from "./schema";

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull(),
  expiresAt: timestamp("expiresAt", { mode: "date" }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClients = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId").notNull().unique(),
    clientSecret: text("clientSecret"),
    clientDiscoveryId: text("clientDiscoveryId"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skipConsent"),
    enableEndSession: boolean("enableEndSession"),
    subjectType: text("subjectType"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("clientCredentialsScopes")
      .array()
      .default([]),
    userId: text("userId").references(() => users.id, { onDelete: "cascade" }),
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
    backchannelLogoutUri: text("backchannelLogoutUri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannelLogoutSessionRequired"
    ),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    applicationType: text("applicationType"),
    jwks: text("jwks"),
    jwksUri: text("jwksUri"),
    grantTypes: text("grantTypes").array(),
    responseTypes: text("responseTypes").array(),
    requirePKCE: boolean("requirePKCE"),
    dpopBoundAccessTokens: boolean("dpopBoundAccessTokens").default(false),
    public: boolean("public"),
    type: text("type"),
    referenceId: text("referenceId"),
    metadata: jsonb("metadata"),
  },
  (table) => [index("oauthClient_userId_idx").on(table.userId)]
);

export const oauthResources = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("accessTokenTtl"),
  refreshTokenTtl: integer("refreshTokenTtl"),
  signingAlgorithm: text("signingAlgorithm"),
  signingKeyId: text("signingKeyId"),
  allowedScopes: text("allowedScopes").array(),
  customClaims: jsonb("customClaims"),
  dpopBoundAccessTokensRequired: boolean(
    "dpopBoundAccessTokensRequired"
  ).default(false),
  disabled: boolean("disabled").default(false),
  createdAt: timestamp("createdAt", { mode: "date" }),
  updatedAt: timestamp("updatedAt", { mode: "date" }),
  policyVersion: integer("policyVersion").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResources = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text("resourceId")
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("createdAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(
      table.clientId,
      table.resourceId
    ),
    index("oauthClientResource_clientId_idx").on(table.clientId),
    index("oauthClientResource_resourceId_idx").on(table.resourceId),
  ]
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("sessionId").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull(),
    revoked: timestamp("revoked", { mode: "date" }),
    rotatedAt: timestamp("rotatedAt", { mode: "date" }),
    rotationReplayResponse: text("rotationReplayResponse"),
    rotationReplayExpiresAt: timestamp("rotationReplayExpiresAt", {
      mode: "date",
    }),
    authTime: timestamp("authTime", { mode: "date" }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauthRefreshToken_clientId_idx").on(table.clientId),
    index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
    index("oauthRefreshToken_userId_idx").on(table.userId),
    index("oauthRefreshToken_authorizationCodeId_idx").on(
      table.authorizationCodeId
    ),
  ]
);

export const oauthAccessTokens = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("sessionId").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("userId").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    refreshId: text("refreshId").references(() => oauthRefreshTokens.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull(),
    revoked: timestamp("revoked", { mode: "date" }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauthAccessToken_clientId_idx").on(table.clientId),
    index("oauthAccessToken_sessionId_idx").on(table.sessionId),
    index("oauthAccessToken_userId_idx").on(table.userId),
    index("oauthAccessToken_authorizationCodeId_idx").on(
      table.authorizationCodeId
    ),
    index("oauthAccessToken_refreshId_idx").on(table.refreshId),
  ]
);

export const oauthConsents = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("userId").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("oauthConsent_clientId_idx").on(table.clientId),
    index("oauthConsent_userId_idx").on(table.userId),
  ]
);

export const oauthClientAssertions = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
});
