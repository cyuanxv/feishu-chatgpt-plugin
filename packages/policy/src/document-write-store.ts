import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, DomainError } from './core.js';
import { documentWriteReceipt, writeBinding, type DocumentWritePrincipal, type DocumentWriteReceipt } from '../../schemas/src/document-write.js';

const state = z.enum(['preview','approved','cancelled','executing','pending','succeeded','partial','failed','uncertain']);
const rowSchema = z.object({ id: z.string().uuid(), binding_hash: z.string(), request_hash: z.string(), status: state,
  task_id: z.string().nullable(), receipt: z.unknown().nullable(), expires_ms: z.number().finite(), fresh: z.boolean() });
export type DocumentWriteIntent = z.infer<typeof rowSchema>;
const select = '*,floor(extract(epoch FROM expires_at)*1000)::double precision AS expires_ms,expires_at>now() AS fresh';

/** Durable local at-most-once reservation. Never stores title, body, tokens or confirmation proofs.
 * Executing/uncertain records never acquire a new lease: a crash is not permission to recreate. */
export class PostgresDocumentWriteStore {
  constructor(private readonly db: Pick<Pool,'query'>) {}
  private async query(sql: string, values: unknown[]): Promise<unknown[]> {
    try { return (await this.db.query(sql, values)).rows; }
    catch { throw new DomainError('UPSTREAM_ERROR', 'Document action storage is unavailable.'); }
  }
  private row(rows: unknown[]): DocumentWriteIntent {
    const parsed = rows.length === 1 ? rowSchema.safeParse(rows[0]) : null;
    if (!parsed?.success) throw new DomainError('NOT_FOUND', 'Document action is unavailable for this authorization.');
    return parsed.data;
  }
  async prepare(principal: DocumentWritePrincipal, requestHash: string, key: string): Promise<DocumentWriteIntent> {
    z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(key);
    const binding = writeBinding(principal); const who = principal.identity; const keyHash = digest(key);
    await this.query(`INSERT INTO document_write_intents(id,connection_id,subject,tenant_id,binding_hash,key_hash,request_hash,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'preview',now()+interval '10 minutes') ON CONFLICT(connection_id,key_hash) DO NOTHING RETURNING id`,
    [randomUUID(),who.connectionId,who.subject,who.tenantId,binding,keyHash,requestHash]);
    const result = this.row(await this.query(`SELECT ${select} FROM document_write_intents WHERE connection_id=$1 AND subject=$2 AND tenant_id=$3 AND key_hash=$4`, [who.connectionId,who.subject,who.tenantId,keyHash]));
    if (result.binding_hash !== binding || result.request_hash !== requestHash) throw new DomainError('CONFLICT', 'This idempotency key belongs to a different request or authorization.');
    return result;
  }
  async get(principal: DocumentWritePrincipal, id: string): Promise<DocumentWriteIntent> {
    z.string().uuid().parse(id); const who = principal.identity;
    return this.row(await this.query(`SELECT ${select} FROM document_write_intents WHERE id=$1 AND connection_id=$2 AND subject=$3 AND tenant_id=$4 AND binding_hash=$5`, [id,who.connectionId,who.subject,who.tenantId,writeBinding(principal)]));
  }
  async confirm(principal: DocumentWritePrincipal, id: string, decision: 'approve' | 'cancel'): Promise<DocumentWriteIntent> {
    const status = decision === 'approve' ? 'approved' : 'cancelled';
    await this.query(`UPDATE document_write_intents SET status=$1,updated_at=now() WHERE id=$2 AND binding_hash=$3 AND expires_at>now() AND status=ANY($4::text[]) RETURNING id`, [status,id,writeBinding(principal),decision === 'approve' ? ['preview'] : ['preview','approved']]);
    const current = await this.get(principal,id);
    if (current.status !== status || (decision === 'approve' && !current.fresh)) throw new DomainError('CONFLICT', 'The preview expired, was cancelled or has already advanced.');
    return current;
  }
  async claim(principal: DocumentWritePrincipal, id: string): Promise<boolean> {
    return (await this.query(`UPDATE document_write_intents SET status='executing',updated_at=now() WHERE id=$1 AND binding_hash=$2 AND status='approved' AND expires_at>now() RETURNING id`, [id,writeBinding(principal)])).length === 1;
  }
  async finish(principal: DocumentWritePrincipal, id: string, receipt: DocumentWriteReceipt, taskId: string | null, from: 'execution' | 'poll'): Promise<DocumentWriteIntent> {
    documentWriteReceipt.parse(receipt);
    const expected = from === 'execution' ? ['executing'] : ['pending','uncertain','succeeded','partial','failed'];
    // These are static SQL expressions, never caller-controlled SQL. Merge warning evidence in
    // the same atomic UPDATE so a slower warned poll cannot be lost behind an earlier success.
    const count = "GREATEST(COALESCE((receipt->>'warnings_count')::int,0),$7::int)";
    const terminal = "status IN ('succeeded','partial','failed')";
    const chosen = `CASE WHEN ${terminal} THEN receipt ELSE $2::jsonb END`;
    const status = `CASE WHEN status IN ('succeeded','partial') AND ${count}>0 THEN 'partial' WHEN ${terminal} THEN status WHEN $1='succeeded' AND ${count}>0 THEN 'partial' ELSE $1 END`;
    const reason = `CASE WHEN (${status})='partial' THEN 'provider_warning' WHEN ${terminal} THEN receipt->>'reason' ELSE ($2::jsonb)->>'reason' END`;
    await this.query(`UPDATE document_write_intents SET status=(${status}),
      receipt=jsonb_set(jsonb_set(jsonb_set((${chosen}),'{warnings_count}',to_jsonb(${count})),'{status}',to_jsonb((${status})::text)),'{reason}',to_jsonb((${reason})::text)),
      task_id=$3,updated_at=now() WHERE id=$4 AND binding_hash=$5 AND status=ANY($6::text[]) RETURNING id`,
    [receipt.status,JSON.stringify(receipt),taskId,id,writeBinding(principal),expected,receipt.warnings_count]);
    return this.get(principal,id);
  }
}
