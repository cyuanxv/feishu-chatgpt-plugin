import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MockOAuthBroker, OAuthError, pkceChallenge } from '../packages/auth/src/mock-broker.js';
import { MemoryTokenStore, PostgresTokenStore, TokenCipher } from '../packages/auth/src/vault.js';
import { demoAccounts, demoIdentity } from '../packages/feishu/src/fixtures.js';
import { TokenRefreshCoordinator, mapUpstreamError, retryRead } from '../packages/feishu/src/adapter.js';
import { Handles, RateLimiter } from '../packages/policy/src/core.js';

function setup() {
  let time = 1_000_000;
  const broker = new MockOAuthBroker('http://127.0.0.1:3333', demoAccounts(), () => time);
  const redirect = 'http://127.0.0.1:8888/callback'; const client = broker.register([redirect]); const verifier = randomBytes(32).toString('base64url');
  const authorization = { clientId: client.clientId, redirect, challenge: pkceChallenge(verifier), challengeMethod: 'S256', resource: broker.resource, scopes: ['profile.read'], demoAccount: 'alpha' };
  const authorize = () => broker.authorize(authorization);
  const exchange = (code: string) => broker.exchange({ code, clientId: client.clientId, redirect, verifier, resource: broker.resource });
  return { broker, client, redirect, verifier, authorization, authorize, exchange, advance: (ms: number) => { time += ms; } };
}
describe('loopback mock OAuth security', () => {
  it('does not allow a public issuer', () => expect(() => new MockOAuthBroker('https://example.test', demoAccounts())).toThrow());
  it.each(['https://attacker.example/cb', 'http://localhost.evil/cb', 'http://127.0.0.1/cb#fragment', 'http://user:pass@127.0.0.1/cb'])('rejects an unapproved redirect %s', redirect => { const s = setup(); expect(() => s.broker.register([redirect])).toThrow(OAuthError); });
  it('issues only scoped, audience-bound demo identity and consumes codes', () => {
    const s = setup(); const code = s.authorize(); const tokens = s.exchange(code);
    expect(s.broker.authenticate(tokens.access_token)?.scopes).toEqual(['profile.read']);
    expect(() => s.exchange(code)).toThrow(OAuthError);
  });
  it('requires PKCE S256', () => { const s = setup(); expect(() => s.broker.authorize({ ...s.authorization, challengeMethod: 'plain' })).toThrow(OAuthError); });
  it('rejects the wrong verifier without issuing a token', () => { const s = setup(); expect(() => s.broker.exchange({ code: s.authorize(), clientId: s.client.clientId, redirect: s.redirect, verifier: randomBytes(32).toString('base64url'), resource: s.broker.resource })).toThrow(OAuthError); });
  it('rejects a changed audience at authorization and exchange', () => { const s = setup(); expect(() => s.broker.authorize({ ...s.authorization, resource: 'https://other.test/mcp' })).toThrow(OAuthError); expect(() => s.broker.exchange({ code: s.authorize(), clientId: s.client.clientId, redirect: s.redirect, verifier: s.verifier, resource: 'https://other.test/mcp' })).toThrow(OAuthError); });
  it('rejects write scopes', () => { const s = setup(); expect(() => s.broker.authorize({ ...s.authorization, scopes: ['im.write'] })).toThrow(OAuthError); });
  it('rejects expired authorization codes', () => { const s = setup(); const code = s.authorize(); s.advance(60_001); expect(() => s.exchange(code)).toThrow(OAuthError); });
  it('expires access tokens', () => { const s = setup(); const token = s.exchange(s.authorize()); s.advance(900_001); expect(s.broker.authenticate(token.access_token)).toBeNull(); });
  it('rotates refresh tokens and revokes the family on replay', () => { const s = setup(); const old = s.exchange(s.authorize()); const next = s.broker.refreshToken({ refreshToken: old.refresh_token, clientId: s.client.clientId, resource: s.broker.resource }); expect(s.broker.authenticate(next.access_token)).not.toBeNull(); expect(() => s.broker.refreshToken({ refreshToken: old.refresh_token, clientId: s.client.clientId, resource: s.broker.resource })).toThrow(OAuthError); expect(s.broker.authenticate(next.access_token)).toBeNull(); });
  it('does not permit refresh scope escalation', () => { const s = setup(); const token = s.exchange(s.authorize()); expect(() => s.broker.refreshToken({ refreshToken: token.refresh_token, clientId: s.client.clientId, resource: s.broker.resource, scopes: ['im.read'] })).toThrow(OAuthError); });
  it('binds revocation to the client', () => { const s = setup(); const token = s.exchange(s.authorize()); s.broker.revoke(token.access_token, 'different-client'); expect(s.broker.authenticate(token.access_token)).not.toBeNull(); s.broker.revoke(token.access_token, s.client.clientId); expect(s.broker.authenticate(token.access_token)).toBeNull(); });
});

describe('token isolation and refresh', () => {
  const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 1_200_000, refreshExpiresAt: 9_000_000 };
  const cipher = () => new TokenCipher(new Map([['v1', randomBytes(32)]]), 'v1');
  it('encrypts with randomized AES-GCM nonces and roundtrips', () => { const c = cipher(); const a = demoIdentity(); const x = c.seal(a, tokens); const y = c.seal(a, tokens); expect(x.ciphertext).not.toBe(y.ciphertext); expect(JSON.stringify(x)).not.toContain('synthetic-access'); expect(c.open(a, x)).toEqual(tokens); });
  it('cryptographically binds ciphertext to tenant, user and connection', () => { const c = cipher(); const a = demoIdentity(); const sealed = c.seal(a, tokens); for (const mutation of [{ tenantId: 'different' }, { subject: 'different' }, { connectionId: 'different' }]) expect(() => c.open({ ...a, ...mutation }, sealed)).toThrow(); });
  it('detects ciphertext modification', () => { const c = cipher(); const a = demoIdentity(); const sealed = c.seal(a, tokens); expect(() => c.open(a, { ...sealed, tag: randomBytes(16).toString('base64url') })).toThrow(); });
  it('supports decrypting old keys during explicit key rotation', () => { const oldKey = randomBytes(32); const old = new TokenCipher(new Map([['old', oldKey]]), 'old'); const next = new TokenCipher(new Map([['old', oldKey], ['new', randomBytes(32)]]), 'new'); const a = demoIdentity(); expect(next.open(a, old.seal(a, tokens))).toEqual(tokens); expect(next.seal(a, tokens).keyId).toBe('new'); });
  it('prevents replacing or reading another connection owner', async () => { const store = new MemoryTokenStore(cipher()); const a = demoIdentity(); await store.put(a, tokens); const forged = { ...demoIdentity('beta'), connectionId: a.connectionId }; await expect(store.get(forged)).rejects.toThrow(); await expect(store.put(forged, tokens)).rejects.toThrow(); await expect(store.revoke(forged)).rejects.toThrow(); expect(await store.get(a)).toEqual(tokens); await store.revoke(a); expect(await store.get(a)).toBeNull(); });
  it('uses parameterized SQL and encrypted fields, without opening a database', async () => { const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }); const store = new PostgresTokenStore({ query } as never, cipher()); const identity = demoIdentity(); await store.put(identity, tokens); expect(query.mock.calls[0]![0]).toContain('$1'); expect(query.mock.calls[0]![0]).toContain("status='active' FOR UPDATE"); const parameters = query.mock.calls[0]![1] as unknown[]; expect(JSON.stringify(parameters)).not.toContain(tokens.accessToken); await store.get(identity); expect(query.mock.calls[1]![0]).toContain('t.subject=$2 AND t.tenant_id=$3'); expect(query.mock.calls[1]![0]).toContain("c.status='active'"); });
  it('does not resurrect a revoked connection when an in-flight refresh completes', async () => { const store = new MemoryTokenStore(cipher()); const identity = demoIdentity(); await store.put(identity, tokens); await store.revoke(identity); await expect(store.put(identity, tokens)).rejects.toThrow('revoked'); expect(await store.get(identity)).toBeNull(); });
  it('coalesces concurrent refresh and saves only encrypted refreshed values', async () => { const store = new MemoryTokenStore(cipher()); const identity = demoIdentity(); await store.put(identity, { ...tokens, expiresAt: 0 }); const refresh = vi.fn().mockResolvedValue(tokens); const coordinator = new TokenRefreshCoordinator(store, refresh, () => 1_000_000); await Promise.all([coordinator.get(identity), coordinator.get(identity), coordinator.get(identity)]); expect(refresh).toHaveBeenCalledTimes(1); });
  it('revokes stale credentials after refresh failure without leaking details', async () => { const store = new MemoryTokenStore(cipher()); const identity = demoIdentity(); await store.put(identity, { ...tokens, expiresAt: 0 }); const coordinator = new TokenRefreshCoordinator(store, async () => { throw new Error('private upstream content'); }, () => 1_000_000); await expect(coordinator.get(identity)).rejects.toThrow('Reconnect'); expect(await store.get(identity)).toBeNull(); });
});

describe('adapter safety primitives', () => {
  it('backs off retryable reads within a bounded budget', async () => { const run = vi.fn().mockRejectedValueOnce({ status: 429, retryAfterMs: 999999 }).mockRejectedValueOnce({ status: 503 }).mockResolvedValue('ok'); const sleep = vi.fn().mockResolvedValue(undefined); expect(await retryRead(run, { sleep, jitter: () => 0 })).toBe('ok'); expect(run).toHaveBeenCalledTimes(3); expect(sleep.mock.calls[0]![0]).toBe(10_000); });
  it('does not retry access denial or expose upstream text', async () => { const run = vi.fn().mockRejectedValue({ status: 403, message: 'private upstream data' }); await expect(retryRead(run)).rejects.toThrow('denied'); expect(run).toHaveBeenCalledTimes(1); expect(mapUpstreamError({ status: 500 }).message).not.toContain('private'); });
  it('binds references and cursors to purpose, connection and query', () => { const h = new Handles(randomBytes(32)); const a = demoIdentity(); const reference = h.encode('resource', a, { id: 'doc-1' }); expect(() => h.decode('cursor', a, reference)).toThrow(); expect(() => h.decode('resource', demoIdentity('beta'), reference)).toThrow(); expect(() => h.decode('resource', a, `${reference}x`)).toThrow(); const page = h.paginate([1, 2], a, { query: 'one' }, 1); expect(() => h.paginate([1, 2], a, { query: 'two' }, 1, page.next_cursor!)).toThrow(); });
  it('expires signed handles', () => { let now = 0; const h = new Handles(randomBytes(32), () => now); const id = h.encode('resource', demoIdentity(), { id: 'doc-1' }); now = 3_600_001; expect(() => h.decode('resource', demoIdentity(), id)).toThrow(); });
  it('enforces isolated request windows', () => { let now = 0; const limiter = new RateLimiter(1, 1000, () => now); limiter.check('a'); limiter.check('b'); expect(() => limiter.check('a')).toThrow(); now = 1001; expect(() => limiter.check('a')).not.toThrow(); });
});
