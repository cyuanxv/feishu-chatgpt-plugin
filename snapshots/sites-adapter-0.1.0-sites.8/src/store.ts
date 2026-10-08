import {
  AppError,
  assert,
  random,
  type Database,
  type Principal,
} from "./security.ts";
// Cleanup and claim use the same database clock, evaluated during each statement.
// A captured Worker timestamp cannot authorize a queued request after expiry.
const sqliteNowMs =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
export interface Grant {
  site: string;
  user_id: string;
  grant_id: string;
  tenant_key: string;
  open_id: string;
  display_name: string;
  credentials: string | null;
  scopes: string;
  expires: number;
  refresh_expires: number;
  status: string;
  version: number;
  lease: string | null;
  lease_until: number;
}
export interface OAuthState {
  state_hash: string;
  site: string;
  user_id: string;
  cookie_hash: string;
  verifier: string;
  epoch: string;
  expires: number;
}
export class Store {
  constructor(readonly db: Database) {}
  async epoch(p: Principal) {
    await this.db
      .prepare(
        "INSERT INTO owners(site,user_id,epoch) VALUES(?,?,?) ON CONFLICT(site,user_id) DO NOTHING",
      )
      .bind(p.site, p.user, random())
      .run();
    const row = await this.db
      .prepare("SELECT epoch FROM owners WHERE site=? AND user_id=?")
      .bind(p.site, p.user)
      .first<{ epoch: string }>();
    assert(row, "storage_unavailable", 503);
    return row.epoch;
  }
  async get(p: Principal) {
    return this.db
      .prepare("SELECT * FROM connections WHERE site=? AND user_id=?")
      .bind(p.site, p.user)
      .first<Grant>();
  }
  async begin(p: Principal, state: OAuthState) {
    await this.db
      .prepare(
        "DELETE FROM oauth_states WHERE site=? AND user_id=? AND expires<=?",
      )
      .bind(p.site, p.user, Date.now())
      .run();
    const row = await this.db
      .prepare(
        `INSERT INTO oauth_states(state_hash,site,user_id,cookie_hash,verifier,epoch,expires) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM owners WHERE site=? AND user_id=? AND epoch=?) RETURNING state_hash`,
      )
      .bind(
        state.state_hash,
        p.site,
        p.user,
        state.cookie_hash,
        state.verifier,
        state.epoch,
        state.expires,
        p.site,
        p.user,
        state.epoch,
      )
      .first();
    assert(row, "authorization_cancelled", 409);
  }
  async claimForm(
    p: Principal,
    csrfHash: string,
    expires: number,
    now: number,
  ) {
    assert(Number.isSafeInteger(expires) && expires > now, "csrf_expired");
    await this.db
      .prepare(
        `DELETE FROM oauth_form_submissions WHERE site=? AND user_id=? AND expires<=${sqliteNowMs}`,
      )
      .bind(p.site, p.user)
      .run();
    const row = await this.db
      .prepare(
        `INSERT INTO oauth_form_submissions(site,user_id,csrf_hash,expires) SELECT ?,?,?,? WHERE ? > ${sqliteNowMs} ON CONFLICT DO NOTHING RETURNING csrf_hash`,
      )
      .bind(p.site, p.user, csrfHash, expires, expires)
      .first();
    if (!row) {
      const clock = await this.db
        .prepare(`SELECT ${sqliteNowMs} AS now`)
        .first<{ now: number }>();
      assert(clock && expires > clock.now, "csrf_expired");
    }
    assert(row, "connection_already_started", 409);
  }
  async consume(
    p: Principal,
    stateHash: string,
    cookieHash: string,
    now: number,
  ) {
    const row = await this.db
      .prepare(
        `DELETE FROM oauth_states WHERE state_hash=? AND site=? AND user_id=? AND cookie_hash=? AND expires>? AND epoch=(SELECT epoch FROM owners WHERE site=? AND user_id=?) RETURNING *`,
      )
      .bind(stateHash, p.site, p.user, cookieHash, now, p.site, p.user)
      .first<OAuthState>();
    assert(row, "invalid_or_expired_state");
    return row;
  }
  async save(
    p: Principal,
    row: Omit<Grant, "site" | "user_id" | "version" | "lease" | "lease_until">,
    epoch: string,
  ) {
    const result = await this.db
      .prepare(
        `INSERT INTO connections(site,user_id,grant_id,tenant_key,open_id,display_name,credentials,scopes,expires,refresh_expires,status,version,lease_until)
    SELECT ?,?,?,?,?,?,?,?,?,?,'active',1,0 WHERE EXISTS(SELECT 1 FROM owners WHERE site=? AND user_id=? AND epoch=?)
    ON CONFLICT(site,user_id) DO UPDATE SET grant_id=excluded.grant_id,tenant_key=excluded.tenant_key,open_id=excluded.open_id,display_name=excluded.display_name,credentials=excluded.credentials,scopes=excluded.scopes,expires=excluded.expires,refresh_expires=excluded.refresh_expires,status='active',version=connections.version+1,lease=NULL,lease_until=0 RETURNING *`,
      )
      .bind(
        p.site,
        p.user,
        row.grant_id,
        row.tenant_key,
        row.open_id,
        row.display_name,
        row.credentials,
        row.scopes,
        row.expires,
        row.refresh_expires,
        p.site,
        p.user,
        epoch,
      )
      .first<Grant>();
    assert(result, "authorization_cancelled", 409);
    return result;
  }
  async current(p: Principal, grantId?: string) {
    const row = await this.get(p);
    assert(
      row &&
        row.status === "active" &&
        row.credentials &&
        (!grantId || row.grant_id === grantId),
      "connection_required",
      401,
    );
    return row;
  }
  async disconnect(p: Principal, grantId: string | null, epoch: string) {
    const next = random();
    const match =
      grantId === null
        ? "NOT EXISTS(SELECT 1 FROM connections WHERE site=? AND user_id=?)"
        : "EXISTS(SELECT 1 FROM connections WHERE site=? AND user_id=? AND grant_id=?)";
    const args =
      grantId === null ? [p.site, p.user] : [p.site, p.user, grantId];
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE owners SET epoch=? WHERE site=? AND user_id=? AND epoch=? AND ${match} RETURNING epoch`,
        )
        .bind(next, p.site, p.user, epoch, ...args),
      this.db
        .prepare(
          "DELETE FROM oauth_states WHERE site=? AND user_id=? AND EXISTS(SELECT 1 FROM owners WHERE site=? AND user_id=? AND epoch=?)",
        )
        .bind(p.site, p.user, p.site, p.user, next),
      this.db
        .prepare(
          "DELETE FROM connections WHERE site=? AND user_id=? AND EXISTS(SELECT 1 FROM owners WHERE site=? AND user_id=? AND epoch=?)",
        )
        .bind(p.site, p.user, p.site, p.user, next),
    ]);
    assert(result[0]?.results.length === 1, "connection_changed", 409);
  }
  async lease(p: Principal, row: Grant, now: number) {
    const value = await this.db
      .prepare(
        `UPDATE connections SET lease=?,lease_until=? WHERE site=? AND user_id=? AND grant_id=? AND version=? AND status='active' AND lease IS NULL RETURNING *`,
      )
      .bind(random(), now + 30000, p.site, p.user, row.grant_id, row.version)
      .first<Grant>();
    if (!value) {
      const current = await this.get(p);
      if (
        current?.grant_id === row.grant_id &&
        current.lease &&
        current.lease_until <= now
      )
        await this.invalidate(p, current);
      throw new AppError("refresh_in_progress_or_reconnect", 503);
    }
    return value;
  }
  async rotate(
    p: Principal,
    row: Grant,
    credentials: string,
    scopes: string,
    expires: number,
    refreshExpires: number,
  ) {
    const result = await this.db
      .prepare(
        `UPDATE connections SET credentials=?,scopes=?,expires=?,refresh_expires=?,version=version+1,lease=NULL,lease_until=0 WHERE site=? AND user_id=? AND grant_id=? AND version=? AND lease=? AND status='active' RETURNING *`,
      )
      .bind(
        credentials,
        scopes,
        expires,
        refreshExpires,
        p.site,
        p.user,
        row.grant_id,
        row.version,
        row.lease,
      )
      .first<Grant>();
    assert(result, "connection_changed", 409);
    return result;
  }
  async invalidate(p: Principal, row: Grant) {
    await this.db
      .prepare(
        `UPDATE connections SET status='reauthorization_required',credentials=NULL,version=version+1,lease=NULL,lease_until=0 WHERE site=? AND user_id=? AND grant_id=? AND version=? AND lease IS ?`,
      )
      .bind(p.site, p.user, row.grant_id, row.version, row.lease)
      .run();
  }
  async rate(key: string, now: number, max: number) {
    const window = Math.floor(now / 60000);
    const row = await this.db
      .prepare(
        `INSERT INTO rate_limits(rate_key,window,count) VALUES(?,?,1) ON CONFLICT(rate_key) DO UPDATE SET window=excluded.window,count=CASE WHEN rate_limits.window=excluded.window THEN rate_limits.count+1 ELSE 1 END WHERE rate_limits.window<>excluded.window OR rate_limits.count<? RETURNING count`,
      )
      .bind(key, window, max)
      .first();
    assert(row, "rate_limited", 429);
  }
}
