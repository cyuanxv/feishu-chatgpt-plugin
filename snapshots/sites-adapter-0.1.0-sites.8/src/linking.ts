import {
  AppError,
  safeError,
  assert,
  aad,
  hash,
  random,
  Vault,
  type Env,
  type Principal,
} from "./security.ts";
import { Store, type Grant } from "./store.ts";
import { Feishu, SCOPES, requestedScopes, type Tokens } from "./feishu.ts";
import { AUTHORIZE_ENDPOINT, checkAuthorizationWire } from "./oauth-wire.ts";
export class Linking {
  constructor(
    private env: Env,
    readonly store: Store,
    readonly vault: Vault,
    readonly api: Feishu,
    private now = Date.now,
  ) {}
  async begin(p: Principal) {
    const scope = requestedScopes(this.env).join(" ");
    const state = random(),
      cookie = random(),
      verifier = random();
    const epoch = await this.store.epoch(p);
    const stateHash = await hash(state);
    const challenge = await hash(verifier);
    const redirectUri = p.site + "/api/feishu/callback";
    const clientId = this.env.FEISHU_APP_ID!;
    await this.store.begin(p, {
      state_hash: stateHash,
      site: p.site,
      user_id: p.user,
      cookie_hash: await hash(cookie),
      verifier: await this.vault.seal(
        { version: 2, verifier, challenge, redirectUri, clientId, scope },
        aad(p, "oauth", stateHash),
      ),
      epoch,
      expires: this.now() + 600000,
    });
    const url = new URL(AUTHORIZE_ENDPOINT);
    Object.entries({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      state,
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const serialized = url.href;
    checkAuthorizationWire(
      serialized,
      { clientId, redirectUri, challenge, scope },
      state,
    );
    return { url: serialized, cookie };
  }
  async callback(p: Principal, state: string, cookie: string, code: string) {
    assert(
      /^[A-Za-z0-9_-]{43}$/.test(state) &&
        /^[A-Za-z0-9_-]{43}$/.test(cookie) &&
        code.length > 0 &&
        code.length <= 4096,
      "invalid_callback",
    );
    const stateHash = await hash(state);
    const pending = await this.store.consume(
      p,
      stateHash,
      await hash(cookie),
      this.now(),
    );
    const secret = await this.vault.open<{
      version?: number;
      scope?: string;
      verifier: string;
      challenge?: string;
      redirectUri?: string;
      clientId?: string;
    }>(pending.verifier, aad(p, "oauth", stateHash));
    assert(/^[A-Za-z0-9_-]{43}$/.test(secret.verifier), "invalid_callback");
    const challengeMatches = secret.challenge === (await hash(secret.verifier));
    const redirectMatches =
      secret.redirectUri === p.site + "/api/feishu/callback";
    const clientMatches = secret.clientId === this.env.FEISHU_APP_ID;
    const versionMatches = secret.version === 2;
    // Fixed schema only: no identifiers, PKCE values, codes or request bodies.
    console.info(
      JSON.stringify({
        event: "feishu_oauth_binding_check",
        diagnostic_version: 1,
        endpoint: "feishu_oauth_v2_pkce",
        version_matches: versionMatches,
        challenge_matches: challengeMatches,
        redirect_matches: redirectMatches,
        client_matches: clientMatches,
        verifier_length: secret.verifier.length,
      }),
    );
    assert(
      versionMatches && challengeMatches && redirectMatches && clientMatches,
      "oauth_binding_mismatch",
    );
    const tokens = await this.api.exchangeCode({
      code,
      verifier: secret.verifier,
      binding: {
        clientId: secret.clientId!,
        redirectUri: secret.redirectUri!,
        challenge: secret.challenge!,
        scope: secret.scope ?? SCOPES.join(" "),
      },
    });
    const profile = await this.api.profile(tokens.access_token);
    const grantId = random();
    return this.store.save(
      p,
      {
        grant_id: grantId,
        tenant_key: profile.tenant_key,
        open_id: profile.open_id,
        display_name: profile.name ?? "飞书账户",
        credentials: await this.vault.seal(
          tokens,
          aad(p, "credentials", grantId),
        ),
        scopes: JSON.stringify(tokens.scopes),
        expires: tokens.access_expires,
        refresh_expires: tokens.refresh_expires,
        status: "active",
      },
      pending.epoch,
    );
  }
  async access(
    p: Principal,
    grantId: string,
    forceRefresh = false,
  ): Promise<{ token: string; row: Grant }> {
    let row = await this.store.current(p, grantId);
    let scopes: unknown;
    try {
      scopes = JSON.parse(row.scopes);
    } catch {
      throw new AppError("provider_scope_changed", 401);
    }
    assert(
      Array.isArray(scopes) && SCOPES.every((s) => scopes.includes(s)),
      "provider_scope_changed",
      401,
    );
    if (row.refresh_expires <= this.now()) {
      await this.store.invalidate(p, row);
      throw new AppError("connection_required", 401);
    }
    let tokens = await this.vault.open<Tokens>(
      row.credentials!,
      aad(p, "credentials", row.grant_id),
    );
    if (forceRefresh || row.expires <= this.now() + 30000) {
      row = await this.store.lease(p, row, this.now());
      try {
        tokens = await this.api.token(
          { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
          scopes as string[],
        );
        row = await this.store.rotate(
          p,
          row,
          await this.vault.seal(tokens, aad(p, "credentials", row.grant_id)),
          JSON.stringify(tokens.scopes),
          tokens.access_expires,
          tokens.refresh_expires,
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "feishu_refresh_failure",
            error_code: safeError(error).code,
          }),
        );
        await this.store.invalidate(p, row);
        throw new AppError("connection_required", 401);
      }
    }
    assert(
      tokens.access_expires > this.now() &&
        typeof tokens.access_token === "string",
      "connection_required",
      401,
    );
    await this.store.current(p, grantId);
    return { token: tokens.access_token, row };
  }
}
