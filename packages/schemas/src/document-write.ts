import { z } from 'zod';
import { digest, type Identity } from '../../policy/src/core.js';

export const documentResourceId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const markdown = z.string().min(1).max(20_000)
  .refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= 65_536, 'Nonempty Markdown within 64 KiB is required.')
  .refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'Control characters are not supported.')
  .refine(value => !/!\s*\[|<[A-Za-z!/][^>]*>/.test(value), 'Images, media and raw HTML/XML are not supported by this text-only candidate.');
export const createDocumentInput = z.object({
  title: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  markdown,
  folder_token: documentResourceId.optional(),
}).strict();
export type CreateDocumentInput = z.infer<typeof createDocumentInput>;
export interface DocumentWritePrincipal {
  identity: Identity;
  grantId: string;
  generation: string;
  clientId: string;
  resource: string;
}
export const writeBinding = (principal: DocumentWritePrincipal): string => digest(JSON.stringify({
  subject: principal.identity.subject, tenant: principal.identity.tenantId, connection: principal.identity.connectionId,
  domain: principal.identity.domain, grant: principal.grantId, generation: principal.generation,
  client: principal.clientId, resource: principal.resource, operation: 'create_doc',
}));
export const documentRequestHash = (input: CreateDocumentInput): string => digest(JSON.stringify({
  title: input.title, markdown: input.markdown, folder_token: input.folder_token ?? null,
}));
export const documentWriteReceipt = z.object({
  operation: z.literal('create_doc'),
  status: z.enum(['preview', 'approved', 'cancelled', 'expired', 'executing', 'pending', 'succeeded', 'partial', 'failed', 'uncertain']),
  intent_id: z.string().uuid(),
  document_id: documentResourceId.nullable(),
  revision_id: z.number().int().nonnegative().nullable(),
  url: z.string().url().nullable(),
  reason: z.enum(['awaiting_confirmation', 'approved', 'cancelled', 'expired', 'executing', 'provider_processing', 'provider_created', 'provider_warning', 'provider_failed', 'outcome_unknown', 'authorization_changed']),
  warnings_count: z.number().int().nonnegative(),
  may_have_created: z.boolean(),
  automatic_create_retry_allowed: z.literal(false),
  content_verified: z.literal(false),
  replayed: z.boolean(),
  live_verified: z.literal(false),
}).strict();
export type DocumentWriteReceipt = z.infer<typeof documentWriteReceipt>;
