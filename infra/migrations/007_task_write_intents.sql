BEGIN;
-- Separate operation namespace. No task summary, description, deadline or raw tokens are stored.
CREATE TABLE task_write_intents (
 id uuid PRIMARY KEY,connection_id text NOT NULL,subject text NOT NULL,tenant_id text NOT NULL,
 binding_hash text NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
 key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN('preview','approved','cancelled','executing','succeeded','partial','failed','uncertain')),
 receipt jsonb,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,key_hash),
 FOREIGN KEY(connection_id,subject,tenant_id) REFERENCES feishu_connections(id,subject,tenant_id) ON DELETE CASCADE
);
CREATE INDEX task_write_intents_status ON task_write_intents(status,updated_at);
COMMIT;
