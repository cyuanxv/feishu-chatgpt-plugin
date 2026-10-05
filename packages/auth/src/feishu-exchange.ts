import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Client, IAuthorizationCodeParams, IRefreshParams } from '@larksuiteoapi/node-sdk';
import type { Pool } from 'pg';
import { z } from 'zod';
import { digest, DomainError } from '../../policy/src/core.js';
import { pkceChallenge } from './mock-broker.js';
import type { FeishuTokens } from './vault.js';

const attemptSchema = z.object({ subject: z.string().min(1), connectionId: z.string().min(1), domain: z.enum(['feishu', 'lark']), redirectUri: z.string().url(), scopes: z.array(z.string()).min(1), verifier: z.string().min(43).max(128), expiresAt: z.number().finite() }).strict();
export type AuthorizationAttempt = z.infer<typeof attemptSchema>;
export interface AuthorizationStateStore {
  save(state: string, attempt: AuthorizationAttempt): Promise<void>;
  /** Must atomically consume only when the initiating authenticated subject matches. */
  consume(state: string, subject: string): Promise<AuthorizationAttempt | null>;
}
interface SealedAttempt { iv: string; tag: string; ciphertext: string }
export class AuthorizationStateCipher {
  constructor(private readonly key: Buffer) { if (key.length !== 32) throw new Error('A 32-byte state encryption key is required.'); }
  seal(state: string, attempt: AuthorizationAttempt): SealedAttempt {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(digest(state)));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(attempt), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: encrypted.toString('base64url') };
  }
  open(state: string, value: SealedAttempt): AuthorizationAttempt {
    try { const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64url')); cipher.setAAD(Buffer.from(digest(state))); cipher.setAuthTag(Buffer.from(value.tag, 'base64url')); return attemptSchema.parse(JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64url')), cipher.final()]).toString())); }
    catch { throw new DomainError('AUTH_REQUIRED', 'Authorization state is invalid. Start again.'); }
  }
}
export class MemoryAuthorizationStateStore implements AuthorizationStateStore {
  private entries = new Map<string, { subject: string; expiresAt: number; sealed: SealedAttempt }>();
  constructor(private readonly cipher: AuthorizationStateCipher, private readonly now: () => number = Date.now) {}
  async save(state: string, attempt: AuthorizationAttempt): Promise<void> {
    for (const [key, value] of this.entries) if (value.expiresAt <= this.now()) this.entries.delete(key);
    if (this.entries.size >= 1000) throw new DomainError('RATE_LIMITED', 'Too many pending authorization attempts.');
    if (this.entries.has(digest(state))) throw new DomainError('CONFLICT', 'Authorization state already exists.');
    this.entries.set(digest(state), { subject: attempt.subject, expiresAt: attempt.expiresAt, sealed: this.cipher.seal(state, attempt) });
  }
  async consume(state: string, subject: string): Promise<AuthorizationAttempt | null> {
    const key = digest(state); const record = this.entries.get(key);
    if (!record || record.subject !== subject || record.expiresAt <= this.now()) return null;
    this.entries.delete(key); return this.cipher.open(state, record.sealed);
  }
}
export class PostgresAuthorizationStateStore implements AuthorizationStateStore {
  constructor(private readonly db: Pick<Pool, 'query'>, private readonly cipher: AuthorizationStateCipher) {}
  async save(state: string, attempt: AuthorizationAttempt): Promise<void> {
    await this.db.query('INSERT INTO oauth_link_attempts(state_hash, subject, sealed, expires_at) VALUES($1,$2,$3::jsonb,to_timestamp($4))', [digest(state), attempt.subject, JSON.stringify(this.cipher.seal(state, attempt)), attempt.expiresAt / 1000]);
  }
  async consume(state: string, subject: string): Promise<AuthorizationAttempt | null> {
    const result = await this.db.query('DELETE FROM oauth_link_attempts WHERE state_hash=$1 AND subject=$2 AND expires_at>now() RETURNING sealed', [digest(state), subject]);
    return result.rows[0] ? this.cipher.open(state, result.rows[0].sealed as SealedAttempt) : null;
  }
}
export interface FeishuTokenSdk {
  exchange(input: IAuthorizationCodeParams): ReturnType<Client['accessToken']['retrieveByAuthorizationCode']>;
  refresh(input: IRefreshParams): ReturnType<Client['accessToken']['refresh']>;
}
/** Use only a client from createSafeSdkClient: the SDK token helper's default logger can log raw HTTP errors. */
export function bindFeishuTokenSdk(client: Client): FeishuTokenSdk {
  return { exchange: client.accessToken.retrieveByAuthorizationCode.bind(client.accessToken), refresh: client.accessToken.refresh.bind(client.accessToken) };
}

/** Provider exchange core only; not a public login route or production authorization server. No credential is returned to an MCP tool. */
export class FeishuOAuthExchange {
  constructor(private readonly sdk: FeishuTokenSdk, private readonly store: AuthorizationStateStore, private readonly config: { domain: 'feishu' | 'lark'; redirectUri: string; allowedProviderScopes: readonly string[] }, private readonly now: () => number = Date.now) {
    const redirect = new URL(config.redirectUri);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash) throw new Error('An exact HTTPS Feishu callback URL is required.');
    if (!config.allowedProviderScopes.length || config.allowedProviderScopes.some(scope => !scope || /\s/.test(scope))) throw new Error('Verified provider scope allowlist is required.');
  }
  async begin(subject: string, connectionId: string, scopes: string[]) {
    if (!subject || !connectionId || !scopes.length || scopes.some(scope => !this.config.allowedProviderScopes.includes(scope))) throw new DomainError('INVALID_ARGUMENT', 'Authorization scopes are not approved for this integration.');
    const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
    await this.store.save(state, { subject, connectionId, domain: this.config.domain, redirectUri: this.config.redirectUri, scopes: [...new Set(scopes)], verifier, expiresAt: this.now() + 600_000 });
    // The verified provider authorization URL must be configured by the production linker; no URL is guessed here.
    return { state, redirect_uri: this.config.redirectUri, scope: [...new Set(scopes)].join(' '), code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' as const };
  }
  async finish(input: { state: string; subject: string; code: string }): Promise<{ attempt: Omit<AuthorizationAttempt, 'verifier'>; tokens: FeishuTokens; grantedProviderScopes: string[] }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.state) || !input.code || input.code.length > 4096) throw new DomainError('AUTH_REQUIRED', 'Authorization callback is invalid.');
    const attempt = await this.store.consume(input.state, input.subject);
    if (!attempt || attempt.expiresAt <= this.now() || attempt.domain !== this.config.domain || attempt.redirectUri !== this.config.redirectUri) throw new DomainError('AUTH_REQUIRED', 'Authorization state expired or does not match.');
    let response: Awaited<ReturnType<FeishuTokenSdk['exchange']>>;
    try { response = await this.sdk.exchange({ code: input.code, redirectUri: attempt.redirectUri, codeVerifier: attempt.verifier }); }
    catch { throw new DomainError('AUTH_REQUIRED', 'Feishu authorization exchange failed. Start again.'); }
    const validated = this.tokens(response);
    if (validated.scopes.some(scope => !attempt.scopes.includes(scope))) throw new DomainError('PERMISSION_DENIED', 'Feishu returned permissions outside the requested set.');
    const { verifier: _verifier, ...safeAttempt } = attempt;
    return { attempt: safeAttempt, tokens: validated.tokens, grantedProviderScopes: validated.scopes };
  }
  async refresh(tokens: FeishuTokens, allowedScopes: readonly string[]): Promise<{ tokens: FeishuTokens; grantedProviderScopes: string[] }> {
    if (tokens.refreshExpiresAt <= this.now()) throw new DomainError('AUTH_REQUIRED', 'Feishu refresh authorization expired.');
    let response: Awaited<ReturnType<FeishuTokenSdk['refresh']>>;
    try { response = await this.sdk.refresh({ refreshToken: tokens.refreshToken }); }
    catch { throw new DomainError('AUTH_REQUIRED', 'Feishu token refresh failed. Reconnect.'); }
    const validated = this.tokens(response);
    if (validated.scopes.some(scope => !allowedScopes.includes(scope))) throw new DomainError('PERMISSION_DENIED', 'Refreshed permissions exceed the original grant.');
    return { tokens: validated.tokens, grantedProviderScopes: validated.scopes };
  }
  private tokens(response: Awaited<ReturnType<FeishuTokenSdk['exchange']>>) {
    const parsed = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresIn: z.number().finite().positive().max(31_536_000), refreshTokenExpiresIn: z.number().finite().positive().max(31_536_000), scope: z.string().trim().min(1), tokenType: z.string().optional() }).safeParse(response);
    if (!parsed.success || (parsed.data.tokenType && parsed.data.tokenType.toLowerCase() !== 'bearer')) throw new DomainError('AUTH_REQUIRED', 'Feishu did not return a complete refreshable authorization.');
    return { tokens: { accessToken: parsed.data.accessToken, refreshToken: parsed.data.refreshToken, expiresAt: this.now() + parsed.data.expiresIn * 1000, refreshExpiresAt: this.now() + parsed.data.refreshTokenExpiresIn * 1000 }, scopes: [...new Set(parsed.data.scope.split(' ').filter(Boolean))] };
  }
}
