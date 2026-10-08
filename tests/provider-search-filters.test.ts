import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { FeishuProviderWorkflows } from '../packages/feishu/src/provider-workflows.js';
import { FeishuProviderDomains } from '../packages/feishu/src/provider-domains.js';
import { FeishuProviderReads } from '../packages/feishu/src/provider-reads.js';
import { FeishuProviderBases } from '../packages/feishu/src/provider-bases.js';
import { FeishuProviderTasks } from '../packages/feishu/src/provider-tasks.js';
import { FeishuSdkReadGateway, bindSdkReads } from '../packages/feishu/src/sdk-reads.js';
import { createSafeSdkClient } from '../packages/feishu/src/sdk-client.js';
import { ProviderReadRouter } from '../packages/tools/src/provider-router.js';
import { demoIdentity } from '../packages/feishu/src/fixtures.js';
import { Handles } from '../packages/policy/src/core.js';

const timeRange = { start: '2026-10-05T08:00:00+08:00', end: '2026-10-06T08:00:00+08:00' };
const filtered = { query: 'Payment', types: ['message' as const], owner: 'ou_fixture', chat_id: 'oc_fixture', time_range: timeRange, page_size: 2 };
const message = (messageId = 'om_fixture') => ({ id: 'search_hit', display_info: '<b>Payment</b> status', meta_data: { message_id: messageId, chat_id: 'oc_fixture', from_id: 'ou_fixture', create_time: '1791162000000' } });
function setup() {
  const identity = demoIdentity();
  const handles = new Handles(randomBytes(32));
  const request = vi.fn().mockImplementation(async config => {
    if (config.url.endsWith('/messages/search')) return { code: 0, data: { items: [message()], has_more: false } };
    if (config.url.endsWith('/messages/om_fixture')) return { code: 0, data: { items: [{ message_id: 'om_fixture', msg_type: 'text', body: { content: '{"text":"Payment details"}' } }] } };
    throw new Error('Unexpected synthetic endpoint');
  });
  const client = createSafeSdkClient({ appId: 'synthetic', appSecret: 'synthetic', domain: 'feishu', httpInstance: { request } as never });
  const gateway = new FeishuSdkReadGateway({ identity, reads: bindSdkReads(client) }, { get: async () => ({ accessToken: 'synthetic', refreshToken: 'synthetic', expiresAt: Date.now() + 1e6, refreshExpiresAt: Date.now() + 2e6 }) });
  const reads = new FeishuProviderReads(gateway, handles);
  const domains = new FeishuProviderDomains(gateway, handles);
  const workflows = new FeishuProviderWorkflows(reads, domains, gateway, handles);
  const resource = 'https://mcp.example.test/mcp';
  const router = new ProviderReadRouter(resource, identity, { reads, domains, workflows, bases: new FeishuProviderBases(gateway, domains, handles), tasks: new FeishuProviderTasks(gateway, handles) });
  return { identity, request, reads, workflows, router, context: { identity, audience: resource, expiresAt: Date.now() + 60000 } };
}

describe('filtered unified message search over the official SDK', () => {
  it('runs owner, chat and offset-aware time filters through router, workflow and SDK', async () => {
    const s = setup();
    const result = await s.router.call('search', filtered, s.context);
    expect(result).toMatchObject({ ok: true, meta: { source: 'feishu_api', live_verified: false, partial: false, next_cursor: null } });
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.request.mock.calls[0]![0]).toMatchObject({
      url: 'https://open.feishu.cn/open-apis/im/v1/messages/search', method: 'POST',
      data: { query: 'Payment', filter: { from_ids: ['ou_fixture'], chat_ids: ['oc_fixture'], time_range: { start_time: '1791158400', end_time: '1791244800' } } },
      params: { user_id_type: 'open_id', page_size: 2 }, headers: { Authorization: 'Bearer synthetic' },
    });
    const hits = result.data!.results as { result_id: string; type: string; snippet: string }[];
    expect(hits[0]).toMatchObject({ type: 'message', snippet: 'Payment status' });
    const fetched = await s.router.call('fetch', { result_id: hits[0]!.result_id }, s.context);
    expect(fetched).toMatchObject({ ok: true, data: { content: 'Payment details' } });
  });
  it.each([{ owner: 'ou_fixture' }, { chat_id: 'oc_fixture' }, { time_range: timeRange }])('supports an individual message filter %s', async filter => {
    const s = setup();
    const result = await s.router.call('search', { query: 'Payment', types: ['message'], ...filter }, s.context);
    expect(result.ok).toBe(true); expect(s.request).toHaveBeenCalledTimes(1);
    const actual = s.request.mock.calls[0]![0].data.filter;
    expect(Object.keys(actual)).toHaveLength(1);
  });
  it('preserves every filter on empty and nonempty continuation pages', async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: 'page_2' } });
    const first = await s.workflows.search(s.identity, filtered);
    expect(first.results).toEqual([]); expect(first.next_cursor).not.toBeNull();
    const second = await s.workflows.search(s.identity, { ...filtered, cursor: first.next_cursor! });
    expect(second.results).toHaveLength(1); expect(second.next_cursor).toBeNull();
    expect(s.request.mock.calls[1]![0]).toMatchObject({ data: { filter: s.request.mock.calls[0]![0].data.filter }, params: { page_size: 2, page_token: 'page_2' } });
    expect(s.request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { owner: 'ou_other' }, { chat_id: 'oc_other' }, { time_range: { ...timeRange, end: '2026-10-07T08:00:00+08:00' } },
    { owner: undefined }, { chat_id: undefined }, { time_range: undefined }, { page_size: 3 }, { query: 'Other' }, { types: ['doc' as const] },
  ])('rejects changed filters or query before continuing %s', async changed => {
    const s = setup();
    s.request.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: 'page_2' } });
    const first = await s.workflows.search(s.identity, filtered);
    await expect(s.workflows.search(s.identity, { ...filtered, ...changed, cursor: first.next_cursor! })).rejects.toThrow();
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('binds the filtered cursor to its original identity and full scope set', async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: 'page_2' } });
    const first = await s.workflows.search(s.identity, filtered);
    for (const identity of [demoIdentity('beta'), { ...s.identity, scopes: ['search.read', 'im.read'] }]) {
      await expect(s.workflows.search(identity, { ...filtered, cursor: first.next_cursor! })).rejects.toThrow();
    }
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, ['doc'], ['wiki'], ['file'], ['base'], ['doc', 'message']])('rejects unsupported filtered domains without silently narrowing %s', async types => {
    const s = setup();
    const args = { ...filtered, types };
    const result = await s.router.call('search', args, s.context);
    expect(result.error?.type).toBe('UNSUPPORTED_CAPABILITY');
    await expect(s.workflows.search(s.identity, args as never)).rejects.toThrow('types=');
    expect(s.request).not.toHaveBeenCalled();
  });
  it('requires both search and IM scope before any network call', async () => {
    const s = setup();
    for (const scopes of [['search.read'], ['im.read'], []]) {
      const result = await s.router.call('search', filtered, { ...s.context, identity: { ...s.identity, scopes } });
      expect(result.error?.type).toBe('INSUFFICIENT_SCOPE');
    }
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([
    { start: '2026-10-05T00:00:00.100Z', end: '2026-10-06T00:00:00Z' },
    { start: '2026-10-05T00:00:00Z', end: '2026-10-06T00:00:00.900Z' },
    { start: '2026-10-05T00:00:00.100Z', end: '2026-10-05T00:00:00.900Z' },
    { start: '2026-10-05T00:00:00.0001Z', end: '2026-10-06T00:00:00Z' },
    { start: '2026-10-05T08:00:00+08:00', end: '2026-10-06T08:00:00.0000001+08:00' },
  ])('rejects subsecond bounds at every provider entry point before transport %s', async time_range => {
    const s = setup();
    expect((await s.router.call('search', { ...filtered, time_range }, s.context)).error?.type).toBe('INVALID_ARGUMENT');
    await expect(s.workflows.search(s.identity, { ...filtered, time_range })).rejects.toThrow('whole-second');
    await expect(s.reads.searchMessages(s.identity, { query: 'Payment', start: time_range.start, end: time_range.end })).rejects.toThrow('whole-second');
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([
    { start: '2026-10-05T00:00:00.000Z', end: '2026-10-06T00:00:00.000Z' },
    { start: '2026-10-05T08:00:00.0000000+08:00', end: '2026-10-06T08:00:00.0000000+08:00' },
    { start: '2026-10-04T19:00:00.0-05:00', end: '2026-10-05T19:00:00.0-05:00' },
  ])('accepts exact-second timestamps without rounding their boundaries %s', async time_range => {
    const s = setup();
    expect((await s.router.call('search', { ...filtered, time_range }, s.context)).ok).toBe(true);
    expect(s.request.mock.calls[0]![0].data.filter.time_range).toEqual({ start_time: '1791158400', end_time: '1791244800' });
  });
  it.each([
    { start: '2026-10-05T08:00:00', end: timeRange.end }, { start: timeRange.end, end: timeRange.start },
    { start: timeRange.start, end: timeRange.start }, { start: timeRange.start, end: '2028-10-05T00:00:00Z' },
  ])('rejects an invalid time range %s', async time_range => {
    const s = setup();
    expect((await s.router.call('search', { ...filtered, time_range }, s.context)).error?.type).toBe('INVALID_ARGUMENT');
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([{ chat_id: 'oc_other' }, { from_id: 'ou_other' }, { chat_id: undefined }, { from_id: undefined }])('rejects results outside the requested chat or sender %s', async fields => {
    const s = setup();
    s.request.mockResolvedValue({ code: 0, data: { items: [{ ...message(), meta_data: { ...message().meta_data, ...fields } }], has_more: false } });
    const result = await s.router.call('search', filtered, s.context);
    expect(result.error?.type).toBe('UPSTREAM_ERROR'); expect(result.data).toBeUndefined();
  });
  it.each([
    { has_more: false }, { items: [] }, { items: [], has_more: 'false' },
    { items: [], has_more: true }, { items: [message(), message()], has_more: false },
    { items: [message('bad/id')], has_more: false }, { items: [{ id: 'missing' }], has_more: false },
    { items: [message('m1'), message('m2'), message('m3')], has_more: false },
  ])('does not claim malformed or oversized pages are complete %s', async data => {
    const s = setup(); s.request.mockResolvedValue({ code: 0, data });
    const result = await s.router.call('search', filtered, s.context);
    expect(result.error?.type).toBe('UPSTREAM_ERROR'); expect(result.data).toBeUndefined();
  });
  it('detects repeated provider continuation rather than repeating filtered results', async () => {
    const s = setup();
    s.request.mockResolvedValue({ code: 0, data: { items: [], has_more: true, page_token: 'loop' } });
    const first = await s.workflows.search(s.identity, filtered);
    await expect(s.workflows.search(s.identity, { ...filtered, cursor: first.next_cursor! })).rejects.toThrow('repeated');
    expect(s.request).toHaveBeenCalledTimes(2);
  });
});
