import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { MockOAuthBroker, OAuthError } from '../../../packages/auth/src/mock-broker.js';
import { MockFeishuAdapter } from '../../../packages/feishu/src/adapter.js';
import { demoAccounts, demoWorkspaces } from '../../../packages/feishu/src/fixtures.js';
import { Handles, RateLimiter, READ_SCOPES, type Identity } from '../../../packages/policy/src/core.js';
import { descriptions, inputSchemas, outputSchema, readToolNames, scopeForTool } from '../../../packages/schemas/src/catalog.js';
import { ToolEngine } from '../../../packages/tools/src/engine.js';
import type { AuditSink } from '../../../packages/observability/src/audit.js';

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
class HttpError extends Error { constructor(readonly status: number) { super('Invalid HTTP request.'); } }
async function readBody(request: IncomingMessage): Promise<string> {
  if (Number(request.headers['content-length'] ?? 0) > 65_536) { request.resume(); throw new HttpError(413); }
  return new Promise((resolve, reject) => {
    let size = 0; const parts: Buffer[] = []; let rejected = false;
    request.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65_536) { if (!rejected) reject(new HttpError(413)); rejected = true; parts.length = 0; } else if (!rejected) parts.push(chunk); });
    request.on('end', () => { if (!rejected) resolve(Buffer.concat(parts).toString('utf8')); });
    request.on('error', () => reject(new HttpError(400)));
    request.on('aborted', () => reject(new HttpError(400)));
  });
}
function single(params: URLSearchParams, key: string, optional = false): string {
  const values = params.getAll(key);
  if (values.length > 1 || (!optional && values.length !== 1) || (values[0]?.length ?? 0) > 4096) throw new OAuthError('invalid_request');
  return values[0] ?? '';
}
function parseJson(body: string): unknown { try { return JSON.parse(body) as unknown; } catch { throw new HttpError(400); } }
function mcpServer(engine: ToolEngine, identity: Identity, issuer: string): McpServer {
  const server = new McpServer({ name: 'feishu-chatgpt-plugin-mock', version: '0.1.0-dev.4' });
  for (const name of readToolNames) {
    server.registerTool(name, {
      title: name.replaceAll('_', ' '), description: descriptions[name],
      inputSchema: inputSchemas[name], outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scopeForTool[name]] }], ...(name === 'get_profile' ? { 'openai/profile': true } : {}) },
    }, async (args: unknown) => {
      const result = await engine.call(name, args, identity);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: !result.ok,
        ...(result.error?.type === 'INSUFFICIENT_SCOPE' ? { _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="${result.error.required_scope}"`] } } : {}) };
    });
  }
  return server;
}
export interface DemoServer { server: Server; issuer: string; broker: MockOAuthBroker; engine: ToolEngine; close: () => Promise<void> }

/** Creates a synthetic development listener. Non-loopback binding and live mode are deliberately unavailable. */
export async function startDemoServer(options: { port?: number; audit?: AuditSink } = {}): Promise<DemoServer> {
  const engine = new ToolEngine(new MockFeishuAdapter(demoWorkspaces()), new Handles(randomBytes(32)), options.audit);
  const oauthLimiter = new RateLimiter(120, 60_000);
  let broker: MockOAuthBroker;
  let issuer = '';
  const server = createServer((request, response) => { void handle(request, response).catch(error => {
    if (response.headersSent) { response.end(); return; }
    if (error instanceof OAuthError) json(response, 400, { error: error.code });
    else if (error instanceof HttpError) json(response, error.status, { error: 'invalid_request' });
    else json(response, 500, { error: 'internal_error' });
  }); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== new URL(issuer).host || (request.headers.origin && request.headers.origin !== issuer)) { json(response, 403, { error: 'untrusted_origin' }); return; }
    const url = new URL(request.url ?? '/', issuer);
    if (url.origin !== issuer) throw new HttpError(400);
    if (request.method === 'GET' && url.pathname === '/health') { json(response, 200, { status: 'ok', mode: 'synthetic_mock', live_feishu: false, persistence: 'ephemeral', read_tools: readToolNames.length }); return; }
    if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
      json(response, 200, { resource: broker.resource, authorization_servers: [issuer], scopes_supported: [...READ_SCOPES], bearer_methods_supported: ['header'] }); return;
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') { json(response, 200, broker.metadata()); return; }
    if (url.pathname.startsWith('/oauth/')) {
      try { oauthLimiter.check(request.socket.remoteAddress ?? 'unknown'); } catch { json(response, 429, { error: 'temporarily_unavailable' }); return; }
      if (request.method === 'POST' && url.pathname === '/oauth/register') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415);
        const input = z.object({ redirect_uris: z.array(z.string().max(2048)).min(1).max(5), token_endpoint_auth_method: z.literal('none').optional() }).strict().safeParse(parseJson(await readBody(request)));
        if (!input.success) throw new OAuthError('invalid_client_metadata');
        const client = broker.register(input.data.redirect_uris);
        json(response, 201, { client_id: client.clientId, redirect_uris: client.redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }); return;
      }
      if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
        const p = url.searchParams; const state = single(p, 'state');
        if (state.length < 16 || state.length > 512 || single(p, 'response_type') !== 'code') throw new OAuthError('invalid_request');
        const redirect = single(p, 'redirect_uri');
        const code = broker.authorize({ clientId: single(p, 'client_id'), redirect, challenge: single(p, 'code_challenge'), challengeMethod: single(p, 'code_challenge_method'), resource: single(p, 'resource'), scopes: single(p, 'scope').split(' '), demoAccount: single(p, 'demo_account') });
        const destination = new URL(redirect); destination.searchParams.set('code', code); destination.searchParams.set('state', state);
        response.writeHead(302, { Location: destination.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end(); return;
      }
      if (request.method === 'POST' && ['/oauth/token', '/oauth/revoke'].includes(url.pathname)) {
        if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415);
        const params = new URLSearchParams(await readBody(request));
        const clientId = single(params, 'client_id');
        if (url.pathname === '/oauth/revoke') { broker.revoke(single(params, 'token'), clientId); json(response, 200, {}); return; }
        const grantType = single(params, 'grant_type');
        if (grantType === 'authorization_code') { json(response, 200, broker.exchange({ clientId, code: single(params, 'code'), redirect: single(params, 'redirect_uri'), verifier: single(params, 'code_verifier'), resource: single(params, 'resource') })); return; }
        if (grantType === 'refresh_token') { const scope = single(params, 'scope', true); json(response, 200, broker.refreshToken({ clientId, refreshToken: single(params, 'refresh_token'), resource: single(params, 'resource'), ...(scope ? { scopes: scope.split(' ') } : {}) })); return; }
        throw new OAuthError('unsupported_grant_type');
      }
    }
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); json(response, 405, { error: 'method_not_allowed' }); return; }
      const authorization = request.headers.authorization ?? '';
      const identity = /^Bearer [A-Za-z0-9_-]+$/.test(authorization) ? broker.authenticate(authorization.slice(7)) : null;
      if (!identity) { response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`); json(response, 401, { error: 'authorization_required' }); return; }
      if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415);
      const body = parseJson(await readBody(request));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = mcpServer(engine, identity, issuer);
      response.once('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport); await transport.handleRequest(request, response, body); return;
    }
    json(response, 404, { error: 'not_found' });
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Unable to open the loopback demo.'); }
  issuer = `http://127.0.0.1:${address.port}`;
  broker = new MockOAuthBroker(issuer, demoAccounts());
  return { server, issuer, broker, engine, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
