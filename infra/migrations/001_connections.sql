-- PostgreSQL schema draft. Apply with a controlled migration user; runtime is not a schema owner.
BEGIN;
CREATE TABLE feishu_connections (
  id text PRIMARY KEY,
  subject text NOT NULL,
  tenant_id text NOT NULL,
  domain text NOT NULL CHECK (domain IN ('feishu', 'lark')),
  open_id text NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  grant_generation bigint NOT NULL DEFAULT 1 CHECK (grant_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, subject, tenant_id)
);
CREATE TABLE feishu_tokens (
  connection_id text PRIMARY KEY,
  subject text NOT NULL,
  tenant_id text NOT NULL,
  sealed jsonb NOT NULL,
  token_revision bigint NOT NULL DEFAULT 1 CHECK (token_revision > 0),
  expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  FOREIGN KEY (connection_id, subject, tenant_id) REFERENCES feishu_connections(id, subject, tenant_id) ON DELETE CASCADE
);
CREATE TABLE oauth_clients (client_id text PRIMARY KEY, metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE oauth_grants (id text PRIMARY KEY, subject text NOT NULL, connection_id text NOT NULL REFERENCES feishu_connections(id), scopes text[] NOT NULL, resource text NOT NULL, revoked_at timestamptz);
CREATE TABLE idempotency_keys (connection_id text NOT NULL REFERENCES feishu_connections(id), tool text NOT NULL, key_hash text NOT NULL, request_hash text NOT NULL, result_ref text, expires_at timestamptz NOT NULL, PRIMARY KEY(connection_id, tool, key_hash));
CREATE TABLE audit_logs (request_id text PRIMARY KEY, connection_hash text NOT NULL, tool text NOT NULL, status text NOT NULL, latency_ms integer NOT NULL, error_type text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tool_feature_flags (tool_name text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, risk_level text NOT NULL);
COMMIT;
