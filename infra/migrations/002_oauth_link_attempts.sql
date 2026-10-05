-- Encrypted PKCE verifier + provider-linking context; consume with one DELETE ... RETURNING.
-- Application owners must decide production retention and runtime permissions before enabling this store.
BEGIN;
CREATE TABLE oauth_link_attempts (
  state_hash text PRIMARY KEY,
  subject text NOT NULL,
  sealed jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_link_attempts_expiry ON oauth_link_attempts(expires_at);
COMMIT;
