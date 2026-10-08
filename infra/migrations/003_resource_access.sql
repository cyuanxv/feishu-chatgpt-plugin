BEGIN;
-- Actual Feishu consent results are distinct from internal MCP scopes.
ALTER TABLE feishu_connections ADD COLUMN provider_scopes text[] NOT NULL DEFAULT '{}';
CREATE TABLE mcp_access_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  grant_generation bigint NOT NULL CHECK (grant_generation > 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_access_tokens_grant ON mcp_access_tokens(grant_id);
-- Only a reviewed authorization issuer may INSERT. The resource server needs SELECT only.
-- No public endpoint in this development slice creates grants or access tokens.
COMMIT;
