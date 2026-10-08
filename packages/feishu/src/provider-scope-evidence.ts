import { DomainError } from '../../policy/src/core.js';

/** Verified minimum provider permissions. These are documentation/configuration evidence, not user grants. */
export const providerScopeEvidence = {
  listCalendars: { minimum: ['calendar:calendar:read'], identity: 'user-required-by-this-project', source: 'https://github.com/larksuite/cli/blob/main/internal/registry/catalog/services/calendar.json' },
  agendaInstances: { minimum: ['calendar:calendar.event:read'], identity: 'user-required-by-this-project', source: 'https://github.com/larksuite/cli/blob/main/internal/registry/catalog/services/calendar.json' },
  searchBases: { minimum: ['search:docs:read'], identity: 'user-required-by-this-project; full-provider-identity-matrix-unverified', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/base/base_resolve.go' },
  resolveBaseWiki: { minimum: ['wiki:node:retrieve'], identity: 'user-required-by-this-project; full-provider-identity-matrix-unverified', source: 'https://github.com/larksuite/cli/blob/main/shortcuts/base/base_resolve.go' },
  searchTasks: { minimum: ['task:task:read'], identity: 'user', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/task/task_search.go' },
  listTasklists: { minimum: ['task:tasklist:read'], identity: 'user-or-tenant', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/task.json' },
  listTasklistTasks: { minimum: ['task:tasklist:read'], identity: 'user-or-tenant', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/task.json' },
  batchMetadata: { minimum: ['drive:drive.metadata:readonly'], identity: 'user-or-tenant', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/drive.json' },
  listCommentReplies: { minimum: ['docs:document.comment:read'], identity: 'user-or-tenant', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/drive.json' },
  searchPeople: { minimum: ['contact:user:search'], identity: 'user', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/contact/contact_search_user.go' },
  searchDocs: { minimum: ['search:docs:read'], identity: 'user-or-tenant', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/drive/drive_search.go' },
  roomBusy: { minimum: ['calendar:calendar.free_busy:read'], identity: 'user-or-tenant', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/calendar.json' },
  listTasks: { minimum: ['task:task:read'], identity: 'user-or-tenant', source: 'https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/registry/catalog/services/task.json' },
} as const;
export type VerifiedScopeOperation = keyof typeof providerScopeEvidence;
/** Call with actual consent results during production linking, never with the documentation list itself. */
export function assertProviderGrant(operation: VerifiedScopeOperation, actualGrantedProviderScopes: readonly string[]): void {
  if (!Object.hasOwn(providerScopeEvidence, operation)) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Provider permission mapping has not been verified for this operation.');
  const missing = providerScopeEvidence[operation].minimum.filter(scope => !actualGrantedProviderScopes.includes(scope));
  if (missing.length) throw new DomainError('INSUFFICIENT_SCOPE', 'The actual Feishu authorization does not include the required provider permission.');
}
