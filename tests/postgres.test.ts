import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PostgresConnectionRepository } from '../packages/auth/src/connection-repository.js';
import { PostgresTokenStore, TokenCipher } from '../packages/auth/src/vault.js';
import { AuthorizationStateCipher, PostgresAuthorizationStateStore } from '../packages/auth/src/feishu-exchange.js';
import { demoIdentity } from '../packages/feishu/src/fixtures.js';
import { TokenRefreshCoordinator } from '../packages/feishu/src/adapter.js';

// Runs the actual PostgreSQL SQL engine compiled to WASM, entirely in memory.
// It does not test production network, native roles, backups or multi-connection locking.
let db: PGlite;
const query = async (sql: string, values?: unknown[]) => { const result = await db.query(sql, values); return { ...result, rowCount: result.affectedRows ?? result.rows.length }; };
const pool = { connect: async () => ({ query, release: () => {} }) };
const key = randomBytes(32);
const cipher = new TokenCipher(new Map([['test-v1', key]]), 'test-v1');
const connections = new PostgresConnectionRepository(pool as never, cipher);
const store = new PostgresTokenStore({ query } as never, cipher);
const identity = demoIdentity();
const tokens = { accessToken: 'synthetic-access-db', refreshToken: 'synthetic-refresh-db', expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 86_400_000 };
beforeAll(async () => {
  db = await PGlite.create();
  for (const file of ['001_connections.sql', '002_oauth_link_attempts.sql']) await db.exec(await readFile(new URL(`../infra/migrations/${file}`, import.meta.url), 'utf8'));
}, 30_000);
beforeEach(async () => { await db.exec('TRUNCATE feishu_connections, oauth_link_attempts CASCADE'); });
afterAll(async () => { await db.close(); });

describe('embedded PostgreSQL migration and repository integration', () => {
  it('applies both migrations and writes only ciphertext to the token table', async () => {
    await connections.link(identity, { openId: 'ou_fixture', tenantId: identity.tenantId }, tokens);
    const result = await db.query('SELECT sealed FROM feishu_tokens');
    expect(result.rows).toHaveLength(1); expect(JSON.stringify(result.rows).includes(tokens.accessToken)).toBe(false);
    expect(await store.get(identity)).toEqual(tokens);
  });
  it('enforces composite foreign key and domain/status checks', async () => {
    await expect(db.query("INSERT INTO feishu_tokens(connection_id,subject,tenant_id,sealed,expires_at,refresh_expires_at) VALUES('missing','x','y','{}',now(),now())")).rejects.toThrow();
    await expect(db.query("INSERT INTO feishu_connections(id,subject,tenant_id,domain,open_id,scopes,status) VALUES('c','s','t','invalid','o',ARRAY['profile.read'],'active')")).rejects.toThrow();
  });
  it('cannot read or overwrite another subject even within the same tenant', async () => {
    await connections.link(identity, { openId: 'ou_fixture', tenantId: identity.tenantId }, tokens);
    const other = { ...identity, subject: 'subject-foreign' };
    expect(await store.get(other)).toBeNull();
    await expect(store.put(other, tokens)).rejects.toThrow('identity');
    await expect(connections.link(other, { openId: 'ou_other', tenantId: other.tenantId }, tokens)).rejects.toThrow('another');
    expect(await store.get(identity)).toEqual(tokens);
  });
  it('rejects a same-ID cross-tenant reconnect without corrupting prior state', async () => {
    await connections.link(identity, { openId: 'ou_fixture', tenantId: identity.tenantId }, tokens);
    const other = { ...identity, tenantId: 'different-tenant' };
    await expect(connections.link(other, { openId: 'ou_fixture', tenantId: other.tenantId }, tokens)).rejects.toThrow();
    expect(await store.get(identity)).toEqual(tokens);
    expect((await db.query('SELECT count(*)::int AS count FROM feishu_connections')).rows).toEqual([{ count: 1 }]);
  });
  it('disconnects atomically and prevents a late token refresh from resurrecting it', async () => {
    await connections.link(identity, { openId: 'ou_fixture', tenantId: identity.tenantId }, tokens);
    await db.query('INSERT INTO oauth_grants(id,subject,connection_id,scopes,resource) VALUES($1,$2,$3,$4,$5)', ['grant-test', identity.subject, identity.connectionId, identity.scopes, 'https://mcp.example.test/mcp']);
    await connections.disconnect(identity);
    expect(await store.get(identity)).toBeNull();
    await expect(store.put(identity, tokens)).rejects.toThrow();
    expect((await db.query('SELECT revoked_at IS NOT NULL AS revoked FROM oauth_grants')).rows).toEqual([{ revoked: true }]);
    expect((await db.query('SELECT count(*)::int AS count FROM feishu_tokens')).rows).toEqual([{ count: 0 }]);
  });
  it('consumes encrypted PKCE state once, only for the original subject', async () => {
    const states = new PostgresAuthorizationStateStore({ query } as never, new AuthorizationStateCipher(randomBytes(32)));
    const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
    await states.save(state, { subject: identity.subject, connectionId: identity.connectionId, domain: 'feishu', redirectUri: 'https://callback.example.test', scopes: ['fixture:read'], verifier, expiresAt: Date.now() + 600_000 });
    const raw = await db.query('SELECT * FROM oauth_link_attempts'); expect(JSON.stringify(raw.rows).includes(verifier)).toBe(false); expect(JSON.stringify(raw.rows).includes(state)).toBe(false);
    expect(await states.consume(state, 'other-subject')).toBeNull();
    const attempt = await states.consume(state, identity.subject); expect(attempt?.subject).toBe(identity.subject);
    expect(await states.consume(state, identity.subject)).toBeNull();
  });
  it('conditionally refuses a stale token revision without deleting a newer token', async () => {
    await connections.link(identity, { openId: 'ou_fixture', tenantId: identity.tenantId }, tokens);
    const snapshot = (await store.snapshot(identity))!;
    const newer = { ...tokens, accessToken: 'synthetic-newer-revision' };
    expect(await store.compareAndPut(identity, newer, snapshot.revision)).toBe(true);
    expect(await store.compareAndPut(identity, tokens, snapshot.revision)).toBe(false);
    await store.revokeIfCurrent(identity, snapshot.revision);
    expect((await store.get(identity))?.accessToken === newer.accessToken).toBe(true);
  });
  it('a failing pre-disconnect refresh cannot revoke a subsequently relinked grant', async () => {
    await connections.link(identity, { openId: 'ou_fixture', tenantId: identity.tenantId }, { ...tokens, expiresAt: 0 });
    let fail!: (error: Error) => void; let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const coordinator = new TokenRefreshCoordinator(store, () => { start(); return new Promise((_resolve, reject) => { fail = reject; }); });
    const pending = coordinator.get(identity); await started;
    await connections.disconnect(identity);
    const fresh = { ...tokens, accessToken: 'synthetic-relinked' };
    await connections.link(identity, { openId: 'ou_fixture', tenantId: identity.tenantId }, fresh);
    fail(new Error('synthetic provider failure'));
    await expect(pending).rejects.toThrow('Reconnect');
    expect((await store.get(identity))?.accessToken === fresh.accessToken).toBe(true);
  });
  it('rejects expired stored authorization state without exchanging any code', async () => {
    const states = new PostgresAuthorizationStateStore({ query } as never, new AuthorizationStateCipher(randomBytes(32)));
    const state = randomBytes(32).toString('base64url');
    await states.save(state, { subject: identity.subject, connectionId: identity.connectionId, domain: 'feishu', redirectUri: 'https://callback.example.test', scopes: ['fixture:read'], verifier: randomBytes(32).toString('base64url'), expiresAt: Date.now() - 1 });
    expect(await states.consume(state, identity.subject)).toBeNull();
  });
});
