import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
export const owners = sqliteTable(
  "owners",
  {
    site: text("site").notNull(),
    user: text("user_id").notNull(),
    epoch: text("epoch").notNull(),
  },
  (t) => [primaryKey({ columns: [t.site, t.user] })],
);
export const connections = sqliteTable(
  "connections",
  {
    site: text("site").notNull(),
    user: text("user_id").notNull(),
    grant: text("grant_id").notNull(),
    tenant: text("tenant_key").notNull(),
    openId: text("open_id").notNull(),
    unionId: text("union_id"),
    display: text("display_name").notNull(),
    credentials: text("credentials"),
    scopes: text("scopes").notNull(),
    expires: integer("expires").notNull(),
    refreshExpires: integer("refresh_expires").notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull().default(1),
    lease: text("lease"),
    leaseUntil: integer("lease_until").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.site, t.user] })],
);
export const states = sqliteTable(
  "oauth_states",
  {
    hash: text("state_hash").primaryKey(),
    site: text("site").notNull(),
    user: text("user_id").notNull(),
    cookie: text("cookie_hash").notNull(),
    verifier: text("verifier").notNull(),
    epoch: text("epoch").notNull(),
    expires: integer("expires").notNull(),
  },
  (t) => [index("oauth_expiry").on(t.expires)],
);
export const limits = sqliteTable("rate_limits", {
  key: text("rate_key").primaryKey(),
  window: integer("window").notNull(),
  count: integer("count").notNull(),
});
export const oauthFormSubmissions = sqliteTable(
  "oauth_form_submissions",
  {
    site: text("site").notNull(),
    user: text("user_id").notNull(),
    csrfHash: text("csrf_hash").notNull(),
    expires: integer("expires").notNull(),
  },
  (t) => [primaryKey({ columns: [t.site, t.user, t.csrfHash] })],
);
export const syntheticState = sqliteTable(
  "synthetic_state",
  {
    site: text("site").notNull(),
    user: text("user_id").notNull(),
    fixture: text("fixture_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.site, t.user] })],
);
export const appRegistry = sqliteTable(
  "app_registry",
  {
    site: text("site").notNull(),
    owner: text("owner").notNull(),
    appId: text("app_id").notNull(),
    label: text("label").notNull(),
    secret: text("secret").notNull(),
    scopes: text("scopes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.site, t.owner, t.appId] })],
);
export const writeIntents = sqliteTable(
  "write_intents",
  {
    site: text("site").notNull(),
    owner: text("owner").notNull(),
    id: text("intent_id").notNull(),
    requestId: text("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    connectionId: text("connection_id").notNull(),
    scopedUser: text("scoped_user").notNull(),
    grantId: text("grant_id").notNull(),
    operation: text("operation").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull(),
    receipt: text("receipt"),
    executionStarted: integer("execution_started"),
    expires: integer("expires").notNull(),
    created: integer("created").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.site, t.owner, t.id] }),
    uniqueIndex("write_request_lookup").on(t.site, t.owner, t.requestId),
  ],
);

export const downloadedAttachments = sqliteTable("downloaded_attachments", {
  site:text("site").notNull(), owner:text("owner").notNull(), fileId:text("file_id").notNull(), connectionId:text("connection_id").notNull(), grantId:text("grant_id").notNull(), payload:text("payload").notNull(), expires:integer("expires").notNull(),
}, t=>[primaryKey({columns:[t.site,t.owner,t.fileId]})]);
