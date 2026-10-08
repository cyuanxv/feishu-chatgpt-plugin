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
const warnings = (value: unknown): number | null => value === undefined ? 0 : Array.isArray(value) && value.length <= 131_072 ? value.length : null;
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
    const outerWarnings = warnings(data.warnings);
    const observedTask = object(data.task) ? documentResourceId.safeParse(data.task.task_id) : null;
    const uncertain = { ...unknown(expectedTask ?? (observedTask?.success ? observedTask.data : null)), warningCount: outerWarnings ?? 0 };
    if (outerWarnings === null) return uncertain;
    if (data.task !== undefined) {
      if (!object(data.task) || data.document !== undefined || data.result !== undefined) return uncertain;
      const task = data.task; const id = documentResourceId.safeParse(task.task_id);
      if (!id.success || (expectedTask !== undefined && id.data !== expectedTask)) return uncertain;
      if (task.type !== 'create_document' ||
          (task.status !== 'succeeded' && task.result !== undefined) ||
          (!['failed','expired'].includes(String(task.status)) && task.failure !== undefined)) return uncertain;
      if (task.status === 'processing') return { ...uncertain, status: 'pending' };
      if (task.status === 'failed' || task.status === 'expired') return { ...uncertain, status: 'failed' };
      if (task.status !== 'succeeded' || !object(task.result) || typeof task.result.create_document !== 'string' || task.result.create_document.length > 262_144) return uncertain;
      try {
        const result = this.document(JSON.parse(task.result.create_document),id.data);
        const warningCount = Math.max(result.warningCount,outerWarnings);
        return { ...result,warningCount,status:result.status === 'succeeded' && warningCount > 0 ? 'partial' : result.status };
      } catch { return uncertain; }
    }
    if (expectedTask !== undefined) return uncertain;
    return this.document(data, null);
  }
  private checkToken(token: string): void {
    if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token)) throw new DomainError('AUTH_REQUIRED', 'A current Feishu user credential is required.');
  }
  private document(value: unknown, taskId: string | null): DocumentCreateOutcome {
    if (!object(value)) return unknown(taskId);
    const warningCount = warnings(value.warnings);
    const uncertain = { ...unknown(taskId), warningCount: warningCount ?? 0 };
    if (warningCount === null) return uncertain;
    if (value.result === 'failed') return { ...uncertain, status: 'failed' };
    if (value.result !== undefined || !object(value.document) || value.task !== undefined) return uncertain;
    const id = documentResourceId.safeParse(value.document.document_id);
    const revision = z.number().int().nonnegative().safeParse(value.document.revision_id);
    if (!id.success || !revision.success) return uncertain;
    return { status: warningCount ? 'partial' : 'succeeded', documentId: id.data, revisionId: revision.data,
      url: this.safeUrl(value.document.url, id.data), taskId, warningCount };
  }
  private safeUrl(raw: unknown, id: string): string | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    try {
      const url = new URL(raw); const suffix = this.domain === 'feishu' ? 'feishu.cn' : 'larksuite.com';
      return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash &&
        (url.hostname === suffix || url.hostname.endsWith('.' + suffix)) && url.pathname === '/docx/' + id ? url.href : null;
    } catch { return null; }
  }
}
