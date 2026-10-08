import { withUserAccessToken, type Client } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { createDocumentInput, documentResourceId, type CreateDocumentInput } from '../../schemas/src/document-write.js';
import { silentSdkLogger } from './sdk-client.js';
import { DomainError } from '../../policy/src/core.js';

export interface DocumentCreateOutcome {
  status: 'pending' | 'succeeded' | 'partial' | 'failed' | 'uncertain';
  documentId: string | null;
  revisionId: number | null;
  url: string | null;
  taskId: string | null;
  warningCount: number;
}
const unknown = (taskId: string | null = null): DocumentCreateOutcome => ({ status: 'uncertain', documentId: null, revisionId: null, url: null, taskId, warningCount: 0 });
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Fixed official-CLI-backed endpoints; not a generic HTTP executor. One POST at most.
 * Tested only with injected transport. This module is not imported by a live entrypoint. */
export class DocumentCreateProvider {
  private readonly origin: string;
  constructor(private readonly client: Client, readonly domain: 'feishu' | 'lark') {
    if (!['feishu', 'lark'].includes(domain)) throw new Error('Unsupported document provider.');
    this.origin = domain === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com';
    client.logger = silentSdkLogger;
  }
  async create(raw: CreateDocumentInput, userToken: string): Promise<DocumentCreateOutcome> {
    const input = createDocumentInput.parse(raw);
    this.checkToken(userToken);
    try {
      const response = await this.client.request<unknown>({
        method: 'POST', url: this.origin + '/open-apis/docs_ai/v1/documents',
        data: { format: 'markdown', content: '<title>' + xml(input.title) + '</title>\n' + input.markdown,
          extra_param: '{"open_create_async":true}',
          ...(input.folder_token ? { parent_token: input.folder_token } : { parent_position: 'my_library' }) },
        timeout: 15_000, maxContentLength: 262_144, maxBodyLength: 131_072,
      }, withUserAccessToken(userToken));
      return this.decode(response);
    } catch { return unknown(); } // Transport/business ambiguity must never repeat the POST.
  }
  async poll(taskId: string, userToken: string): Promise<DocumentCreateOutcome> {
    documentResourceId.parse(taskId);
    this.checkToken(userToken);
    try {
      const response = await this.client.request<unknown>({
        method: 'GET', url: this.origin + '/open-apis/docs_ai/v1/async_tasks/' + encodeURIComponent(taskId),
        timeout: 15_000, maxContentLength: 262_144,
      }, withUserAccessToken(userToken));
      return this.decode(response, taskId);
    } catch { return unknown(taskId); } // A later explicit receipt refresh may retry this GET only.
  }
  private decode(response: unknown, expectedTask?: string): DocumentCreateOutcome {
    if (!object(response) || response.code !== 0 || !object(response.data)) return unknown(expectedTask ?? null);
    try { if (Buffer.byteLength(JSON.stringify(response)) > 262_144) return unknown(expectedTask ?? null); } catch { return unknown(expectedTask ?? null); }
    const data = response.data;
    if (data.task !== undefined) {
      if (!object(data.task) || data.document !== undefined || data.result !== undefined) return unknown(expectedTask ?? null);
      const task = data.task; const id = documentResourceId.safeParse(task.task_id);
      if (!id.success || (expectedTask !== undefined && id.data !== expectedTask)) return unknown(expectedTask ?? null);
      if (task.type !== 'create_document') return unknown(id.data);
      if (task.status === 'processing') return { ...unknown(id.data), status: 'pending' };
      if (task.status === 'failed' || task.status === 'expired') return { ...unknown(id.data), status: 'failed' };
      if (task.status !== 'succeeded' || !object(task.result) || typeof task.result.create_document !== 'string' || task.result.create_document.length > 262_144) return unknown(id.data);
      try { return this.document(JSON.parse(task.result.create_document), id.data); } catch { return unknown(id.data); }
    }
    if (expectedTask !== undefined) return unknown(expectedTask);
    return this.document(data, null);
  }
  private checkToken(token: string): void {
    if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token)) throw new DomainError('AUTH_REQUIRED', 'A current Feishu user credential is required.');
  }
  private document(value: unknown, taskId: string | null): DocumentCreateOutcome {
    if (!object(value)) return unknown(taskId);
    if (value.result === 'failed') return { ...unknown(taskId), status: 'failed' };
    if (value.result !== undefined || !object(value.document) || value.task !== undefined) return unknown(taskId);
    const id = documentResourceId.safeParse(value.document.document_id);
    const revision = z.number().int().nonnegative().safeParse(value.document.revision_id);
    if (!id.success || !revision.success || (value.warnings !== undefined && !Array.isArray(value.warnings))) return unknown(taskId);
    const warningCount = Array.isArray(value.warnings) ? value.warnings.length : 0;
    return { status: warningCount ? 'partial' : 'succeeded', documentId: id.data, revisionId: revision.data,
      url: this.safeUrl(value.document.url, id.data), taskId, warningCount };
  }
  private safeUrl(raw: unknown, id: string): string | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    try {
      const url = new URL(raw); const suffix = this.domain === 'feishu' ? 'feishu.cn' : 'larksuite.com';
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
        (url.hostname === suffix || url.hostname.endsWith('.' + suffix)) && url.pathname === '/docx/' + id ? url.href : null;
    } catch { return null; }
  }
}
