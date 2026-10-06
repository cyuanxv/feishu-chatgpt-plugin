import { withUserAccessToken, type Client } from '@larksuiteoapi/node-sdk';
import { DomainError, requireScope, type Identity } from '../../policy/src/core.js';
import type { FeishuTokens } from '../../auth/src/vault.js';
import { silentSdkLogger } from './sdk-client.js';

export interface SearchPeopleInput { data: { query: string }; params: { page_size: number } }
export interface SearchPeopleResponse { code?: number; msg?: string; data?: { items: { id: string; display_info?: string; meta_data?: { i18n_names?: Record<string, string>; is_cross_tenant?: boolean } }[]; has_more: boolean; notice?: string } }
export interface BaseSearchInput { data: { query: string; page_size: number; page_token?: string } }
export interface BaseWikiResponse { code?: number; msg?: string; data?: { node?: { obj_type: 'bitable'; obj_token: string; title?: string } } }

/** Every binding is a concrete read endpoint from the installed official SDK. Never expose this map as a generic MCP executor. */
export interface SdkReadBindings {
  profile: Client['authen']['v1']['userInfo']['get'];
  searchDocs: Client['search']['v2']['docWiki']['search'];
  listChats: Client['im']['v1']['chat']['list'];
  searchChats: Client['im']['v1']['chat']['search'];
  searchMessages: Client['im']['v1']['message']['search'];
  getMessages: Client['im']['v1']['message']['get'];
  listMessages: Client['im']['v1']['message']['list'];
  getDocument: Client['docx']['v1']['document']['get'];
  readDocument: Client['docx']['v1']['document']['rawContent'];
  getWikiNode: Client['wiki']['v2']['space']['getNode'];
  listDocComments: Client['drive']['v1']['fileComment']['list'];
  listCommentReplies: Client['drive']['v1']['fileCommentReply']['list'];
  batchMetadata: Client['drive']['v1']['meta']['batchQuery'];
  listBaseTables: Client['bitable']['v1']['appTable']['list'];
  listBaseFields: Client['bitable']['v1']['appTableField']['list'];
  searchBaseRecords: Client['bitable']['v1']['appTableRecord']['search'];
  listCalendars: Client['calendar']['v4']['calendar']['list'];
  listEvents: Client['calendar']['v4']['calendarEvent']['list'];
  agendaInstances: Client['calendar']['v4']['calendarEvent']['instanceView'];
  freeBusy: Client['calendar']['v4']['freebusy']['batch'];
  roomBusy: Client['calendar']['v4']['freebusy']['list'];
  searchRooms: Client['vc']['v1']['room']['search'];
  listTasks: Client['task']['v2']['task']['list'];
  getTask: Client['task']['v2']['task']['get'];
  searchTasks: Client['task']['v2']['task']['search'];
  listTasklists: Client['task']['v2']['tasklist']['list'];
  listTasklistTasks: Client['task']['v2']['tasklist']['tasks'];
  lookupPeopleByEmail: Client['contact']['v3']['user']['batchGetId'];
  searchPeople: (payload: SearchPeopleInput, options?: Parameters<Client['authen']['v1']['userInfo']['get']>[1]) => Promise<SearchPeopleResponse>;
  searchBases: (payload: BaseSearchInput, options?: Parameters<Client['search']['v2']['docWiki']['search']>[1]) => ReturnType<Client['search']['v2']['docWiki']['search']>;
  resolveBaseWiki: (payload: { params: { token: string } }, options?: Parameters<Client['authen']['v1']['userInfo']['get']>[1]) => Promise<BaseWikiResponse>;
}
export function bindSdkReads(client: Client): SdkReadBindings {
  // SDK read methods can log raw Axios failures. Never allow those logs to expose credentials.
  client.logger = silentSdkLogger;
  return {
    profile: client.authen.v1.userInfo.get.bind(client.authen.v1.userInfo),
    searchDocs: client.search.v2.docWiki.search.bind(client.search.v2.docWiki),
    listChats: client.im.v1.chat.list.bind(client.im.v1.chat),
    searchChats: client.im.v1.chat.search.bind(client.im.v1.chat),
    searchMessages: client.im.v1.message.search.bind(client.im.v1.message),
    getMessages: client.im.v1.message.get.bind(client.im.v1.message),
    listMessages: client.im.v1.message.list.bind(client.im.v1.message),
    getDocument: client.docx.v1.document.get.bind(client.docx.v1.document),
    readDocument: client.docx.v1.document.rawContent.bind(client.docx.v1.document),
    getWikiNode: client.wiki.v2.space.getNode.bind(client.wiki.v2.space),
    listDocComments: client.drive.v1.fileComment.list.bind(client.drive.v1.fileComment),
    listCommentReplies: client.drive.v1.fileCommentReply.list.bind(client.drive.v1.fileCommentReply),
    batchMetadata: client.drive.v1.meta.batchQuery.bind(client.drive.v1.meta),
    listBaseTables: client.bitable.v1.appTable.list.bind(client.bitable.v1.appTable),
    listBaseFields: client.bitable.v1.appTableField.list.bind(client.bitable.v1.appTableField),
    searchBaseRecords: client.bitable.v1.appTableRecord.search.bind(client.bitable.v1.appTableRecord),
    listCalendars: client.calendar.v4.calendar.list.bind(client.calendar.v4.calendar),
    listEvents: client.calendar.v4.calendarEvent.list.bind(client.calendar.v4.calendarEvent),
    agendaInstances: client.calendar.v4.calendarEvent.instanceView.bind(client.calendar.v4.calendarEvent),
    freeBusy: client.calendar.v4.freebusy.batch.bind(client.calendar.v4.freebusy),
    roomBusy: client.calendar.v4.freebusy.list.bind(client.calendar.v4.freebusy),
    searchRooms: client.vc.v1.room.search.bind(client.vc.v1.room),
    listTasks: client.task.v2.task.list.bind(client.task.v2.task),
    getTask: client.task.v2.task.get.bind(client.task.v2.task),
    searchTasks: client.task.v2.task.search.bind(client.task.v2.task),
    listTasklists: client.task.v2.tasklist.list.bind(client.task.v2.tasklist),
    listTasklistTasks: client.task.v2.tasklist.tasks.bind(client.task.v2.tasklist),
    lookupPeopleByEmail: client.contact.v3.user.batchGetId.bind(client.contact.v3.user),
    // This new endpoint is present in the official CLI but not the installed generated Node resource tree.
    // Keep a fixed URL and payload contract rather than exposing arbitrary SDK requests.
    searchPeople: (payload, options) => client.request<SearchPeopleResponse>({ method: 'POST', url: `${client.domain}/open-apis/contact/v3/users/search`, data: payload.data, params: payload.params }, options),
    // Narrow Base-only operations do not require or expose DOCX read capability.
    searchBases: async (payload, options) => {
      const response = await client.search.v2.docWiki.search({ data: { query: payload.data.query, page_size: payload.data.page_size, ...(payload.data.page_token ? { page_token: payload.data.page_token } : {}), doc_filter: { doc_types: ['BITABLE'] }, wiki_filter: { doc_types: ['BITABLE'] } } }, options);
      if (response.code === 0 && (!Array.isArray(response.data?.res_units) || response.data.res_units.some(item => item.result_meta?.doc_types !== 'BITABLE'))) throw new Error('Provider Base response crossed the requested resource domain.');
      return response;
    },
    resolveBaseWiki: async (payload, options) => {
      // Official CLI uses node_by_token. Do not infer a Base app token from a Wiki node token.
      const response = await client.request<BaseWikiResponse>({ method: 'GET', url: `${client.domain}/open-apis/wiki/v2/spaces/node_by_token`, params: { token: payload.params.token } }, options);
      if (response.code !== 0) return response;
      const node = response.data?.node;
      if (node?.obj_type !== 'bitable' || typeof node.obj_token !== 'string' || !node.obj_token) throw new Error('Wiki node did not resolve to a Base.');
      return { code: 0, data: { node: { obj_type: 'bitable', obj_token: node.obj_token, ...(typeof node.title === 'string' ? { title: node.title } : {}) } } };
    },
  };
}
export type SdkReadOperation = keyof SdkReadBindings;
export type SdkReadInput<K extends SdkReadOperation> = Parameters<SdkReadBindings[K]>[0];
export type SdkReadResponse<K extends SdkReadOperation> = Awaited<ReturnType<SdkReadBindings[K]>>;
export type SdkReadData<K extends SdkReadOperation> = NonNullable<SdkReadResponse<K>['data']>;
export const operationScopes: Record<SdkReadOperation, string> = {
  agendaInstances:'calendar.read',
  listCommentReplies: 'docs.read', batchMetadata: 'docs.read',
  searchTasks: 'task.read', listTasklists: 'task.read', listTasklistTasks: 'task.read',
  searchBases: 'base.read', resolveBaseWiki: 'base.read',
  profile: 'profile.read', searchDocs: 'docs.read', listChats: 'im.read', searchChats: 'im.read', searchMessages: 'im.read', getMessages: 'im.read', listMessages: 'im.read', getDocument: 'docs.read', readDocument: 'docs.read', getWikiNode: 'docs.read', listDocComments: 'docs.read', listBaseTables: 'base.read', listBaseFields: 'base.read', searchBaseRecords: 'base.read', listCalendars: 'calendar.read', listEvents: 'calendar.read', freeBusy: 'calendar.read', roomBusy: 'calendar.read', searchRooms: 'calendar.read', listTasks: 'task.read', getTask: 'task.read', lookupPeopleByEmail: 'people.read', searchPeople: 'people.read',
};

/** Endpoint-independent failures are safe. Unknown provider codes are not guessed into a permission or token failure. */
export class ProviderError extends DomainError {
  constructor(type: ConstructorParameters<typeof DomainError>[0], public readonly providerCode?: number, public readonly retryable = false, public readonly retryAfterMs = 0) {
    super(type, type === 'RATE_LIMITED' ? 'Feishu rate limit reached.' : type === 'AUTH_REQUIRED' ? 'Feishu authorization is required.' : type === 'PERMISSION_DENIED' ? 'Feishu denied access.' : type === 'NOT_FOUND' ? 'Feishu resource was not found.' : 'Feishu could not complete the request.');
  }
}
export function providerFailure(raw: unknown): ProviderError {
  // Axios stores HTTP status in response.status; never retain response.data, config or headers.
  const object = typeof raw === 'object' && raw !== null ? raw as { status?: unknown; response?: { status?: unknown; headers?: { 'retry-after'?: unknown } } } : {};
  const status = Number(object.response?.status ?? object.status);
  const retrySeconds = Number(object.response?.headers?.['retry-after'] ?? 0);
  const retryAfter = Number.isFinite(retrySeconds) ? Math.min(10_000, Math.max(0, retrySeconds * 1000)) : 0;
  if (status === 401) return new ProviderError('AUTH_REQUIRED');
  if (status === 403) return new ProviderError('PERMISSION_DENIED');
  if (status === 404) return new ProviderError('NOT_FOUND');
  if (status === 429) return new ProviderError('RATE_LIMITED', undefined, true, retryAfter);
  return new ProviderError('UPSTREAM_ERROR', undefined, status >= 500 && status <= 599);
}

export interface IdentityTokenProvider { get(identity: Identity): Promise<FeishuTokens> }
export interface BoundReadSession { identity: Pick<Identity, 'subject' | 'tenantId' | 'connectionId' | 'domain'>; reads: SdkReadBindings }
/** New provider transport slice, deliberately not wired into the synthetic ToolEngine or public listener. */
export class FeishuSdkReadGateway {
  constructor(private readonly session: BoundReadSession, private readonly tokenProvider: IdentityTokenProvider, private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}
  async call<K extends SdkReadOperation>(operation: K, payload: SdkReadInput<K>, identity: Identity): Promise<SdkReadData<K>> {
    if (!Object.hasOwn(operationScopes, operation)) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Unknown provider read operation.');
    for (const key of ['subject', 'tenantId', 'connectionId', 'domain'] as const) if (this.session.identity[key] !== identity[key]) throw new DomainError('PERMISSION_DENIED', 'Provider session belongs to a different connection.');
    requireScope(identity, operationScopes[operation]);
    if (payload !== undefined) {
      if (typeof payload !== 'object' || payload === null || Object.keys(payload).some(key => !['params', 'data', 'path'].includes(key))) throw new DomainError('INVALID_ARGUMENT', 'Provider request shape is invalid.');
      const path = 'path' in payload ? payload.path : undefined;
      if (path && (typeof path !== 'object' || Object.values(path).some(value => typeof value !== 'string' || value === '.' || value === '..' || !/^[A-Za-z0-9_.@+-]{1,256}$/.test(value)))) throw new DomainError('INVALID_ARGUMENT', 'Provider resource ID is invalid.');
    }
    const tokens = await this.tokenProvider.get(identity);
    if (!tokens.accessToken || tokens.expiresAt <= Date.now()) throw new DomainError('AUTH_REQUIRED', 'A valid user authorization is required.');
    const method = this.session.reads[operation];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // SDK method signatures remain the authority for payload/response fields. All calls force user identity, with no bot fallback.
        const response = await Reflect.apply(method, undefined, [payload, withUserAccessToken(tokens.accessToken)]) as SdkReadResponse<K>;
        if (!response || typeof response.code !== 'number') throw new ProviderError('UPSTREAM_ERROR');
        if (response.code !== 0) throw new ProviderError('UPSTREAM_ERROR', response.code);
        if (response.data === undefined || response.data === null || typeof response.data !== 'object') throw new ProviderError('UPSTREAM_ERROR');
        return response.data as SdkReadData<K>;
      } catch (raw) {
        const failure = raw instanceof ProviderError ? raw : providerFailure(raw);
        if (!failure.retryable || attempt === 2) throw failure;
        await this.sleep(Math.max(failure.retryAfterMs, 200 * 2 ** attempt));
      }
    }
    throw new ProviderError('UPSTREAM_ERROR');
  }
}
