BEGIN;
-- Preview text is never persisted. A key remains consumed after ambiguous writes/crashes;
-- there is deliberately no lease expiry that can repeat a possibly completed remote create.
CREATE TABLE document_write_intents (
  id uuid PRIMARY KEY,
  connection_id text NOT NULL,
  subject text NOT NULL,
  tenant_id text NOT NULL,
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('preview','approved','cancelled','executing','pending','succeeded','partial','failed','uncertain')),
  task_id text,
  receipt jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,key_hash),
  FOREIGN KEY(connection_id,subject,tenant_id) REFERENCES feishu_connections(id,subject,tenant_id) ON DELETE CASCADE
);
CREATE INDEX document_write_intents_pending ON document_write_intents(status,updated_at);
COMMIT;
