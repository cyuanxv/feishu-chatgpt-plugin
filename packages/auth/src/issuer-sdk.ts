import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { PostgresAgendaIssuer } from './durable-issuer.js';
import { PostgresResourceAccess } from './resource-access.js';

/** Reuse SDK parsing, client checks and endpoint rate limiting. The backing issuer validates PKCE
 * within its exchange boundary; skipLocalPkceValidation asks the SDK to pass the verifier through.
 * authorize is deliberately supplied by the reviewed human-login/consent integration, never a demo account. */
export function agendaOAuthProvider(issuer: PostgresAgendaIssuer, access: PostgresResourceAccess, authorize: OAuthServerProvider['authorize']): OAuthServerProvider {
  return {
    clientsStore: issuer.clientsStore,
    authorize,
    skipLocalPkceValidation: true,
    async challengeForAuthorizationCode() { throw new InvalidGrantError('PKCE is validated by the durable issuer.'); },
    exchangeAuthorizationCode(client, code, verifier, redirectUri, resource) {
      return issuer.exchange({ clientId: client.client_id, code, verifier, redirectUri, resource: resource?.href });
    },
    exchangeRefreshToken(client, refreshToken, scopes, resource) { return issuer.refresh({ clientId: client.client_id, refreshToken, scopes, resource: resource?.href }); },
    async verifyAccessToken(token) {
      const grant = await access.authenticate(token, issuer.config.resource);
      // The resource server uses the durable grant and account binding directly.
      return { token, clientId: await issuer.clientForGrant(grant.grantId), scopes: grant.identity.scopes, expiresAt: Math.floor(grant.expiresAt / 1000), resource: new URL(grant.resource), extra: { grantId: grant.grantId } };
    },
    revokeToken(client, request) { return issuer.revoke(request.token, client.client_id); }
  };
}
