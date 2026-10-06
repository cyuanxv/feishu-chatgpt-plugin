BEGIN;
-- Server-created browser attempts; raw browser secrets and authorization codes are never stored.
CREATE TABLE mcp_authorization_attempts (
  request_hash text PRIMARY KEY CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  challenge text NOT NULL,
  client_state text,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mcp_authorization_attempts_expiry ON mcp_authorization_attempts(expires_at);
ALTER TABLE oauth_grants ADD COLUMN client_id text;
CREATE TABLE mcp_authorization_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  grant_generation bigint NOT NULL CHECK (grant_generation > 0),
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE mcp_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  grant_generation bigint NOT NULL CHECK (grant_generation > 0),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX mcp_refresh_tokens_grant ON mcp_refresh_tokens(grant_id);
CREATE TABLE mcp_provider_accounts (
  app_id text NOT NULL,
  domain text NOT NULL CHECK (domain='feishu'),
  tenant_id text NOT NULL,
  open_id text NOT NULL,
  subject text NOT NULL UNIQUE,
  connection_id text NOT NULL UNIQUE,
  PRIMARY KEY(app_id,domain,tenant_id,open_id)
);
CREATE TABLE mcp_browser_links (
  browser_hash text PRIMARY KEY CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  request_id text NOT NULL,
  csrf_hash text NOT NULL,
  identity jsonb,
  provider_scopes text[],
  sealed jsonb,
  open_id text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mcp_browser_links_expiry ON mcp_browser_links(expires_at);
-- Retain used hashes until the grant expires/revokes to detect replay across process restarts.
COMMIT;
