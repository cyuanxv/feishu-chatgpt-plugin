BEGIN;
-- Purpose-bound browser sessions reference existing MCP grants. No new OAuth grant, raw bearer,
-- approval proof or document body is stored. __Host cookie and CSRF values are stored as hashes.
CREATE TABLE document_review_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  handoff_hash text NOT NULL UNIQUE CHECK (handoff_hash ~ '^[a-f0-9]{64}$'),
  token_hash text NOT NULL REFERENCES mcp_access_tokens(token_hash) ON DELETE CASCADE,
  intent_id uuid NOT NULL REFERENCES document_write_intents(id) ON DELETE CASCADE,
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  site_origin text NOT NULL,
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL CHECK (phase IN ('review','submitting','receipt','closed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_review_sessions_expiry ON document_review_sessions(expires_at);
COMMIT;
