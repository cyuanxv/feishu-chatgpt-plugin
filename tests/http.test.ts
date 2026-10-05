import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDemoServer, type DemoServer } from '../apps/mcp-server/src/server.js';
import { pkceChallenge } from '../packages/auth/src/mock-broker.js';
import { READ_SCOPES } from '../packages/policy/src/core.js';

let app: DemoServer;
beforeEach(async () => { app = await startDemoServer(); });
afterEach(async () => { await app.close(); });
async function login(scopes: string[] = [...READ_SCOPES]): Promise<string> {
  const redirect = 'http://127.0.0.1:7777/callback';
  const registration = await fetch(`${app.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) });
  const client = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url'); const state = randomBytes(16).toString('base64url');
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '), state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', resource: `${app.issuer}/mcp`, demo_account: 'alpha' });
  const authorization = await fetch(`${app.issuer}/oauth/authorize?${params}`, { redirect: 'manual' });
  expect(authorization.status).toBe(302);
  const location = new URL(authorization.headers.get('location')!); expect(location.searchParams.get('state')).toBe(state);
  const exchange = await fetch(`${app.issuer}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, code: location.searchParams.get('code')!, redirect_uri: redirect, code_verifier: verifier, grant_type: 'authorization_code', resource: `${app.issuer}/mcp` }) });
  expect(exchange.status).toBe(200); return ((await exchange.json()) as { access_token: string }).access_token;
}
describe('HTTP and MCP integration using official SDK client', () => {
  it('reports truthful health and OAuth discovery', async () => { const response = await fetch(`${app.issuer}/health`); const health = await response.json(); expect(health).toMatchObject({ mode: 'synthetic_mock', live_feishu: false, persistence: 'ephemeral', read_tools: 17 }); const discovery = await (await fetch(`${app.issuer}/.well-known/oauth-protected-resource/mcp`)).json(); expect(discovery.resource).toBe(`${app.issuer}/mcp`); });
  it('requires authentication and supplies a standard challenge', async () => { const response = await fetch(`${app.issuer}/mcp`, { method: 'POST' }); expect(response.status).toBe(401); expect(response.headers.get('www-authenticate')).toContain('oauth-protected-resource/mcp'); });
  it('blocks hostile browser origins and DNS rebinding host headers', async () => {
    expect((await fetch(`${app.issuer}/health`, { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
    // Fetch normalizes Host; use Node's raw HTTP client to test the actual wire header.
    const status = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(`${app.issuer}/health`, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); request.end(); });
    expect(status).toBe(403);
  });
  it('rejects oversized and malformed JSON requests', async () => { const token = await login(); const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }; expect((await fetch(`${app.issuer}/mcp`, { method: 'POST', headers, body: 'x'.repeat(70_000) })).status).toBe(413); expect((await fetch(`${app.issuer}/mcp`, { method: 'POST', headers, body: '{' })).status).toBe(400); });
  it('rejects duplicate OAuth parameters and unregistered redirect attempts', async () => { const response = await fetch(`${app.issuer}/oauth/authorize?state=abcdefghijklmnop&state=second&response_type=code`); expect(response.status).toBe(400); });
  it('initializes, lists all read tools, and calls profile/search/fetch through real MCP transport', async () => {
    const token = await login(); const client = new Client({ name: 'synthetic-test-client', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${app.issuer}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const tools = await client.listTools(); expect(tools.tools).toHaveLength(17);
      for (const tool of tools.tools) { expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }); expect(tool.outputSchema).toBeDefined(); }
      const profile = await client.callTool({ name: 'get_profile', arguments: {} }); expect(profile.isError).toBe(false); expect(profile.structuredContent?.ok).toBe(true);
      const search = await client.callTool({ name: 'search', arguments: { query: 'Payment', types: ['doc'] } });
      const data = search.structuredContent?.data as { results: { result_id: string }[] };
      const fetched = await client.callTool({ name: 'fetch', arguments: { result_id: data.results[0]!.result_id } }); expect(fetched.isError).toBe(false); expect(JSON.stringify(fetched.structuredContent)).toContain('Synthetic payment design');
    } finally { await client.close(); }
  });
  it('reports missing scope as a tool error with incremental authorization challenge', async () => {
    const token = await login(['profile.read']); const client = new Client({ name: 'scope-test', version: '1' });
    try { await client.connect(new StreamableHTTPClientTransport(new URL(`${app.issuer}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } })); const result = await client.callTool({ name: 'list_tasks', arguments: {} }); expect(result.isError).toBe(true); expect(result._meta?.['mcp/www_authenticate']).toBeDefined(); } finally { await client.close(); }
  });
});
