import { DomainError, RateLimiter } from '../../policy/src/core.js';
import { WriteConfirmationAuthority } from '../../policy/src/write-confirmation.js';
import { PostgresDocumentWriteStore, type DocumentWriteIntent } from '../../policy/src/document-write-store.js';
import { createDocumentInput, documentRequestHash, documentWriteReceipt, writeBinding, type DocumentWritePrincipal, type DocumentWriteReceipt } from '../../schemas/src/document-write.js';
import type { DocumentWriteAccess } from '../../auth/src/document-write-access.js';
import { DocumentCreateProvider, type DocumentCreateOutcome } from '../../feishu/src/document-create-provider.js';

/** Stateful create_doc candidate: preview -> trusted confirmation -> one mutation -> receipt.
 * Deliberately absent from every MCP/HTTP entrypoint and disabled unless explicitly constructed
 * for an authorized synthetic test. A boolean model argument can never substitute for approval. */
export class CreateDocumentWorkflow {
  constructor(
    private readonly access: DocumentWriteAccess,
    private readonly store: PostgresDocumentWriteStore,
    private readonly confirmation: WriteConfirmationAuthority,
    private readonly providerFor: (principal: DocumentWritePrincipal) => DocumentCreateProvider,
    private readonly options: { enabled?: boolean } = {},
    private readonly limiter = new RateLimiter(60),
  ) {}
  private enabled(): void {
    if (this.options.enabled !== true) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Document creation remains disabled.');
  }
  private provider(principal: DocumentWritePrincipal): DocumentCreateProvider {
    const provider = this.providerFor(principal);
    if (provider.domain !== principal.identity.domain) throw new DomainError('PERMISSION_DENIED', 'Document provider does not match the authorized account.');
    return provider;
  }
  async preview(bearer: string, raw: unknown, idempotencyKey: string) {
    this.enabled(); const input = createDocumentInput.parse(raw); const principal = await this.access.authenticate(bearer);
    this.limiter.check(writeBinding(principal));
    const intent = await this.store.prepare(principal, documentRequestHash(input), idempotencyKey);
    return {
      receipt: this.receipt(intent, false),
      requires_confirmation: intent.status === 'preview' && intent.fresh,
      review: { operation: 'create_doc' as const, title: input.title, markdown: input.markdown,
        destination: input.folder_token ? { kind: 'drive_folder' as const, folder_token: input.folder_token } : { kind: 'my_library' as const },
        permission_notice: 'The destination existing permissions apply. No permission changes, messages or media uploads are included.' },
      confirmation_request: { intent: intent.id, binding: writeBinding(principal), request: intent.request_hash, expires: intent.expires_ms },
    };
  }
  async confirm(bearer: string, intentId: string, trustedHostProof: string): Promise<DocumentWriteReceipt> {
    this.enabled(); const principal = await this.access.authenticate(bearer); const intent = await this.store.get(principal,intentId);
    const claim = this.confirmation.verify(trustedHostProof,{ intent: intent.id, binding: writeBinding(principal), request: intent.request_hash });
    return this.receipt(await this.store.confirm(principal,intentId,claim.decision),false);
  }
  async execute(bearer: string, intentId: string, raw: unknown): Promise<DocumentWriteReceipt> {
    this.enabled(); const input = createDocumentInput.parse(raw); const principal = await this.access.authenticate(bearer);
    const initial = await this.store.get(principal,intentId);
    if (initial.request_hash !== documentRequestHash(input)) throw new DomainError('CONFLICT', 'The content or destination changed. Create and confirm a new preview.');
    if (initial.status === 'preview') throw new DomainError('PERMISSION_DENIED', 'Explicit confirmation is required before creating the document.');
    if (initial.status !== 'approved' || !initial.fresh) return this.receipt(initial,true);
    const provider = this.provider(principal);
    if (!await this.store.claim(principal,intentId)) return this.receipt(await this.store.get(principal,intentId),true);
    // The durable claim precedes any possible remote mutation; it is never released after a crash.
    let token: string;
    try { token = (await this.access.token(bearer,principal)).accessToken; }
    catch {
      const receipt = this.base(intentId,'failed','authorization_changed',false);
      return this.receipt(await this.store.finish(principal,intentId,receipt,null,'execution'),false);
    }
    let outcome: DocumentCreateOutcome;
    try { outcome = await provider.create(input,token); }
    catch { outcome = { status:'uncertain',documentId:null,revisionId:null,url:null,taskId:null,warningCount:0 }; }
    const receipt = this.outcome(intentId,outcome,false);
    return this.receipt(await this.store.finish(principal,intentId,receipt,outcome.taskId,'execution'),false);
  }
  async getReceipt(bearer: string, intentId: string, refresh = false): Promise<DocumentWriteReceipt> {
    this.enabled(); if (typeof refresh !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'Receipt refresh must be a boolean.');
    const principal = await this.access.authenticate(bearer); const current = await this.store.get(principal,intentId);
    if (!refresh || !current.task_id || !['pending','uncertain'].includes(current.status)) return this.receipt(current,true);
    this.limiter.check(writeBinding(principal));
    const provider = this.provider(principal); const token = (await this.access.token(bearer,principal)).accessToken;
    const outcome = await provider.poll(current.task_id,token);
    return this.receipt(await this.store.finish(principal,intentId,this.outcome(intentId,outcome,true),current.task_id,'poll'),true);
  }
  private base(intentId: string,status: DocumentWriteReceipt['status'],reason: DocumentWriteReceipt['reason'],mayHaveCreated: boolean): DocumentWriteReceipt {
    return { operation:'create_doc',status,intent_id:intentId,document_id:null,revision_id:null,url:null,reason,warnings_count:0,warning_count_mode:'max_observed',
      may_have_created:mayHaveCreated,automatic_create_retry_allowed:false,content_verified:false,replayed:false,live_verified:false };
  }
  private outcome(intentId: string,outcome: DocumentCreateOutcome,replayed: boolean): DocumentWriteReceipt {
    const reasons = { pending:'provider_processing',succeeded:'provider_created',partial:'provider_warning',failed:'provider_failed',uncertain:'outcome_unknown' } as const;
    return documentWriteReceipt.parse({ ...this.base(intentId,outcome.status,reasons[outcome.status],true),
      document_id:outcome.documentId,revision_id:outcome.revisionId,url:outcome.url,warnings_count:outcome.warningCount,replayed });
  }
  private receipt(intent: DocumentWriteIntent,replayed: boolean): DocumentWriteReceipt {
    if (intent.receipt !== null) return documentWriteReceipt.parse({ ...documentWriteReceipt.parse(intent.receipt),replayed });
    const status = ['preview','approved'].includes(intent.status) && !intent.fresh ? 'expired' : intent.status;
    const reasons = { preview:'awaiting_confirmation',approved:'approved',cancelled:'cancelled',expired:'expired',executing:'executing',pending:'provider_processing',succeeded:'provider_created',partial:'provider_warning',failed:'provider_failed',uncertain:'outcome_unknown' } as const;
    return { ...this.base(intent.id,status,reasons[status],['executing','pending','succeeded','partial','failed','uncertain'].includes(status)),replayed };
  }
}
