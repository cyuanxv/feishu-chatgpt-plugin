import { createHash } from 'node:crypto';
export interface AuditEvent { requestId: string; tool: string; connectionHash: string; status: 'ok' | 'error'; errorType?: string; durationMs: number }
/** An allowlisted event builder, intentionally incapable of accepting arbitrary log fields. */
export function auditEvent(requestId: string, tool: string, connectionId: string, status: 'ok' | 'error', durationMs: number, errorType?: string): AuditEvent {
  return { requestId, tool, connectionHash: createHash('sha256').update(connectionId).digest('hex').slice(0, 16), status, durationMs: Math.max(0, durationMs), ...(errorType ? { errorType } : {}) };
}
export type AuditSink = (event: AuditEvent) => void;
export const silentAudit: AuditSink = () => {};
