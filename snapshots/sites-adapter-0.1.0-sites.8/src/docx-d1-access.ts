// Candidate bridge only. No production import or OAuth scope/registration change.
import { z } from "zod";
import { AppError, assert } from "./security.ts";
import type { Store } from "./store.ts";
import type { Linking } from "./linking.ts";
import { DOCX_CANDIDATE_SCOPES, type DocxAccess } from "./docx-candidate.ts";
const scopeList = z.array(z.string().min(1).max(256)).max(100);
function scopes(value: string): string[] {
  try {
    const parsed = scopeList.safeParse(JSON.parse(value));
    assert(parsed.success, "provider_scope_changed", 401);
    return [...new Set(parsed.data)].sort();
  } catch {
    throw new AppError("provider_scope_changed", 401);
  }
}
export function createDocxD1Access(
  store: Pick<Store, "current">,
  link: Pick<Linking, "access">,
): DocxAccess {
  return async (principal, expectedGrant, requiredScope) => {
    assert(
      requiredScope === DOCX_CANDIDATE_SCOPES.search ||
        requiredScope === DOCX_CANDIDATE_SCOPES.fetch,
    );
    const before = await store.current(principal, expectedGrant);
    const beforeScopes = scopes(before.scopes);
    // Check before Linking.access: missing DOCX scope must not trigger even an
    // upstream token refresh. This function never obtains new consent.
    assert(beforeScopes.includes(requiredScope), "insufficient_scope", 403);
    const linked = await link.access(principal, before.grant_id);
    const current = await store.current(principal, before.grant_id);
    const currentScopes = scopes(current.scopes);
    assert(
      linked.row.grant_id === current.grant_id &&
        JSON.stringify(scopes(linked.row.scopes)) ===
          JSON.stringify(currentScopes) &&
        JSON.stringify(beforeScopes) === JSON.stringify(currentScopes),
      "connection_changed",
      401,
    );
    assert(
      linked.row.version === current.version,
      "docx_state_changed_restart",
      409,
    );
    assert(
      Number.isSafeInteger(current.version) && current.version >= 1,
      "connection_changed",
      401,
    );
    return {
      grant: current.grant_id,
      token: linked.token,
      scopes: currentScopes,
      revision: current.version,
    };
  };
}
