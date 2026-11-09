import { createHash, randomUUID } from 'node:crypto';
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from '@azure/msal-node';
import { expect } from 'vitest';
import { CLIENT, SECRET, TENANT, fakeJwt } from './fakeEntra';

/**
 * Fake Microsoft identity platform for the real MSAL library: replaces MSAL's HTTP layer (INetworkModule), so the
 * whole MSAL code path runs – authority discovery, PKCE, token request, ID token parsing and nonce validation –
 * without network. Signatures are not checked by MSAL in the code flow, so unsigned tokens are fine.
 */

const AUTHORITY = 'https://login.microsoftonline.com';
const TOKEN_ENDPOINT = `${AUTHORITY}/${TENANT}/oauth2/v2.0/token`;

interface IssuedCode {
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  claims: Record<string, unknown>;
}

export function createFakeIdentityPlatform() {
  const requests: { method: string; url: string }[] = [];
  const codes = new Map<string, IssuedCode>();
  /** permissions in app-only tokens (client credentials) */
  const state = { appTokenRoles: [] as string[] };

  const ok = <T>(body: unknown): NetworkResponse<T> => ({ status: 200, headers: { 'content-type': 'application/json' }, body: body as T });
  const error = <T>(status: number, err: string, description: string): NetworkResponse<T> => ({
    status,
    headers: { 'content-type': 'application/json' },
    body: { error: err, error_description: description, error_codes: [Number(description.match(/AADSTS(\d+)/)?.[1] ?? 0)], correlation_id: randomUUID() } as T,
  });

  const network: INetworkModule = {
    async sendGetRequestAsync<T>(url: string): Promise<NetworkResponse<T>> {
      requests.push({ method: 'GET', url });
      const u = new URL(url);
      if (u.pathname === '/common/discovery/instance') {
        return ok<T>({
          tenant_discovery_endpoint: `${AUTHORITY}/${TENANT}/v2.0/.well-known/openid-configuration`,
          'api-version': '1.1',
          metadata: [
            {
              preferred_network: 'login.microsoftonline.com',
              preferred_cache: 'login.windows.net',
              aliases: ['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com', 'sts.windows.net'],
            },
          ],
        });
      }
      if (u.pathname === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
        return ok<T>({
          issuer: `${AUTHORITY}/${TENANT}/v2.0`,
          authorization_endpoint: `${AUTHORITY}/${TENANT}/oauth2/v2.0/authorize`,
          token_endpoint: TOKEN_ENDPOINT,
          end_session_endpoint: `${AUTHORITY}/${TENANT}/oauth2/v2.0/logout`,
          jwks_uri: `${AUTHORITY}/${TENANT}/discovery/v2.0/keys`,
          response_modes_supported: ['query', 'fragment', 'form_post'],
        });
      }
      throw new Error(`fake identity platform: unexpected GET ${url}`);
    },

    async sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
      requests.push({ method: 'POST', url });
      if (url.split('?')[0] !== TOKEN_ENDPOINT) throw new Error(`fake identity platform: unexpected POST ${url}`);
      const p = new URLSearchParams(options?.body ?? '');
      if (p.get('client_id') !== CLIENT) return error<T>(400, 'unauthorized_client', 'AADSTS700016: Application not found in the directory.');
      if (p.get('client_secret') !== SECRET) return error<T>(401, 'invalid_client', 'AADSTS7000215: Invalid client secret provided.');

      if (p.get('grant_type') === 'client_credentials') {
        return ok<T>({ token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: fakeJwt({ aud: 'https://graph.microsoft.com', tid: TENANT, roles: state.appTokenRoles }) });
      }
      if (p.get('grant_type') !== 'authorization_code') return error<T>(400, 'unsupported_grant_type', 'AADSTS70003: The app requested an unsupported grant type.');

      const issued = codes.get(p.get('code') ?? '');
      codes.delete(p.get('code') ?? '');
      if (!issued) return error<T>(400, 'invalid_grant', 'AADSTS70008: The provided authorization code has expired or was already used.');
      if (createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== issued.codeChallenge) {
        return error<T>(400, 'invalid_grant', 'AADSTS501481: The Code_Verifier does not match the code_challenge supplied in the authorization request.');
      }
      if (p.get('redirect_uri') !== issued.redirectUri) return error<T>(400, 'invalid_grant', 'AADSTS50148: The redirect_uri does not match the authorization request.');

      const now = Math.floor(Date.now() / 1000);
      const oid = String(issued.claims.oid);
      return ok<T>({
        token_type: 'Bearer',
        scope: 'openid profile email',
        expires_in: 3599,
        ext_expires_in: 3599,
        access_token: fakeJwt({ aud: '00000003-0000-0000-c000-000000000000', tid: TENANT, oid }),
        id_token: fakeJwt({
          ver: '2.0',
          aud: CLIENT,
          iss: `${AUTHORITY}/${TENANT}/v2.0`,
          iat: now,
          nbf: now,
          exp: now + 3600,
          tid: TENANT,
          sub: `sub-${oid}`,
          nonce: issued.nonce,
          ...issued.claims,
        }),
        client_info: Buffer.from(JSON.stringify({ uid: oid, utid: TENANT })).toString('base64url'),
      });
    },
  };

  /**
   * The Microsoft sign-in page: the user signs in with the given claims and Microsoft Entra ID redirects back with an
   * authorization code. `nonce` overrides the nonce of the request (an ID token that belongs to another request).
   */
  function signIn(authorizeUrl: string, claims: Record<string, unknown>, opts: { nonce?: string } = {}): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${AUTHORITY}/${TENANT}/oauth2/v2.0/authorize`);
    expect(u.searchParams.get('client_id')).toBe(CLIENT);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    const nonce = u.searchParams.get('nonce');
    expect(nonce).toBeTruthy();
    const code = `0.fake-code-${randomUUID()}`;
    codes.set(code, {
      nonce: opts.nonce ?? nonce!,
      codeChallenge: u.searchParams.get('code_challenge')!,
      redirectUri: u.searchParams.get('redirect_uri')!,
      claims,
    });
    return { code, state: u.searchParams.get('state')! };
  }

  return { network, signIn, requests, state };
}
