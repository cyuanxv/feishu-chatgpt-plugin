import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { constantEquals, digest, READ_SCOPES, type Identity } from '../../policy/src/core.js';

export class OAuthError extends Error {
  constructor(public readonly code: string, message = 'OAuth request could not be completed.') { super(message); }
}
interface Client { clientId: string; redirects: string[] }
interface CodeGrant { clientId: string; redirect: string; challenge: string; identity: Identity; expires: number; resource: string }
interface TokenGrant { clientId: string; identity: Identity; expires: number; resource: string; family: string; used?: boolean }
export interface OAuthTokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }
export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** TEST-ONLY authorization server. It does not authenticate a real human or connect to Feishu. */
export class MockOAuthBroker {
  private clients = new Map<string, Client>();
  private codes = new Map<string, CodeGrant>();
  private access = new Map<string, TokenGrant>();
  private refresh = new Map<string, TokenGrant>();
  constructor(readonly issuer: string, private readonly identities: ReadonlyMap<string, Identity>, private readonly now: () => number = Date.now) {
    const url = new URL(issuer);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/') throw new Error('Mock OAuth is restricted to a loopback HTTP origin.');
  }
  get resource(): string { return `${this.issuer}/mcp`; }
  register(redirects: string[]): Client {
    this.prune();
    if (!redirects.length || redirects.length > 5 || this.clients.size >= 100) throw new OAuthError('invalid_client_metadata');
    for (const redirect of redirects) {
      let url: URL;
      try { url = new URL(redirect); } catch { throw new OAuthError('invalid_redirect_uri'); }
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) throw new OAuthError('invalid_redirect_uri');
    }
    const client = { clientId: randomUUID(), redirects: [...new Set(redirects)] };
    this.clients.set(client.clientId, client);
    return { ...client, redirects: [...client.redirects] };
  }
  authorize(input: { clientId: string; redirect: string; challenge: string; challengeMethod: string; resource: string; scopes: string[]; demoAccount: string }): string {
    this.prune();
    const client = this.clients.get(input.clientId);
    if (!client || !client.redirects.includes(input.redirect)) throw new OAuthError('invalid_client');
    if (input.resource !== this.resource) throw new OAuthError('invalid_target');
    if (input.challengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) throw new OAuthError('invalid_request');
    if (!input.scopes.length || input.scopes.some(scope => !READ_SCOPES.includes(scope as typeof READ_SCOPES[number]))) throw new OAuthError('invalid_scope');
    const identity = this.identities.get(input.demoAccount);
    if (!identity) throw new OAuthError('access_denied');
    if (input.scopes.some(scope => !identity.scopes.includes(scope))) throw new OAuthError('invalid_scope');
    if (this.codes.size >= 1000) throw new OAuthError('temporarily_unavailable');
    const code = randomBytes(32).toString('base64url');
    this.codes.set(digest(code), { clientId: input.clientId, redirect: input.redirect, challenge: input.challenge, identity: { ...identity, scopes: [...new Set(input.scopes)] }, expires: this.now() + 60_000, resource: input.resource });
    return code;
  }
  exchange(input: { code: string; clientId: string; redirect: string; verifier: string; resource: string }): OAuthTokenResponse {
    const grant = this.codes.get(digest(input.code));
    if (!grant || grant.expires <= this.now() || grant.clientId !== input.clientId || grant.redirect !== input.redirect || grant.resource !== input.resource) throw new OAuthError('invalid_grant');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) || !constantEquals(pkceChallenge(input.verifier), grant.challenge)) throw new OAuthError('invalid_grant');
    this.codes.delete(digest(input.code));
    return this.issue(grant.clientId, grant.identity, grant.resource, randomUUID());
  }
  refreshToken(input: { refreshToken: string; clientId: string; resource: string; scopes?: string[] }): OAuthTokenResponse {
    const grant = this.refresh.get(digest(input.refreshToken));
    if (!grant || grant.clientId !== input.clientId || grant.resource !== input.resource || grant.expires <= this.now()) throw new OAuthError('invalid_grant');
    if (grant.used) { this.revokeFamily(grant.family); throw new OAuthError('invalid_grant'); }
    const scopes = input.scopes ?? grant.identity.scopes;
    if (!scopes.length || scopes.some(scope => !grant.identity.scopes.includes(scope))) throw new OAuthError('invalid_scope');
    grant.used = true;
    return this.issue(grant.clientId, { ...grant.identity, scopes }, grant.resource, grant.family);
  }
  authenticate(token: string): Identity | null {
    if (token.length > 1024) return null;
    const grant = this.access.get(digest(token));
    if (!grant || grant.expires <= this.now() || grant.resource !== this.resource) return null;
    return { ...grant.identity, scopes: [...grant.identity.scopes] };
  }
  revoke(token: string, clientId: string): void {
    const key = digest(token); const grant = this.access.get(key) ?? this.refresh.get(key);
    if (grant?.clientId === clientId) this.revokeFamily(grant.family);
  }
  private issue(clientId: string, identity: Identity, resource: string, family: string): OAuthTokenResponse {
    this.prune();
    if (this.access.size >= 5000 || this.refresh.size >= 5000) throw new OAuthError('temporarily_unavailable');
    const access = randomBytes(32).toString('base64url'); const refresh = randomBytes(32).toString('base64url');
    this.access.set(digest(access), { clientId, identity, resource, family, expires: this.now() + 900_000 });
    this.refresh.set(digest(refresh), { clientId, identity, resource, family, expires: this.now() + 3_600_000 });
    return { access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh, scope: identity.scopes.join(' ') };
  }
  private revokeFamily(family: string): void {
    for (const table of [this.access, this.refresh]) for (const [key, grant] of table) if (grant.family === family) table.delete(key);
  }
  private prune(): void {
    for (const table of [this.codes, this.access, this.refresh]) for (const [key, grant] of table) if (grant.expires <= this.now()) table.delete(key);
  }
  metadata(): Record<string, unknown> {
    return { issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`, token_endpoint: `${this.issuer}/oauth/token`, registration_endpoint: `${this.issuer}/oauth/register`, revocation_endpoint: `${this.issuer}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [...READ_SCOPES] };
  }
}
