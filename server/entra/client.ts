import { ConfidentialClientApplication, type Configuration, type INetworkModule } from '@azure/msal-node';
import { ManagedIdentityCredential } from '@azure/identity';
import type { EntraCredential } from '../../shared/entra';

/** What the app needs from MSAL – an interface so that tests can replace it (no network in tests). */
export interface EntraClientConfig {
  tenantId: string;
  clientId: string;
  credential: EntraCredential;
  clientSecret: string;
  managedIdentityClientId: string;
}

export interface AuthCodeUrlRequest {
  redirectUri: string;
  scopes: string[];
  state: string;
  nonce: string;
  codeChallenge: string;
  prompt?: 'select_account';
}

export interface EntraClient {
  getAuthCodeUrl(req: AuthCodeUrlRequest): Promise<string>;
  /**
   * Redeems the authorization code. `nonce` is the value sent with the authorization request: MSAL (since 7.x) rejects
   * an ID token that carries a nonce when none is passed here (ClientAuthError nonce_mismatch).
   */
  acquireTokenByCode(req: { code: string; codeVerifier: string; redirectUri: string; scopes: string[]; nonce: string }): Promise<{ idTokenClaims: Record<string, unknown> }>;
  /** App-only access token (client credentials flow), e.g. for https://graph.microsoft.com/.default */
  acquireAppToken(scope: string): Promise<string>;
}

export type EntraClientFactory = (config: EntraClientConfig) => EntraClient;

/**
 * MSAL confidential client. Credential: client secret, or – secretless – the App Service's managed identity
 * as federated credential of the app registration (token for api://AzureADTokenExchange as client assertion).
 */
export const msalClientFactory: EntraClientFactory = (cfg) => createMsalClient(cfg);

/** The real MSAL client; `networkClient` replaces MSAL's HTTP layer (tests run MSAL itself, without network). */
export function createMsalClient(cfg: EntraClientConfig, opts: { networkClient?: INetworkModule } = {}): EntraClient {
  const msalConfig: Configuration = {
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
    },
    ...(opts.networkClient ? { system: { networkClient: opts.networkClient } } : {}),
  };
  if (cfg.credential === 'managedIdentity') {
    const credential = new ManagedIdentityCredential(cfg.managedIdentityClientId ? { clientId: cfg.managedIdentityClientId } : undefined);
    msalConfig.auth.clientAssertion = async () => {
      const token = await credential.getToken('api://AzureADTokenExchange/.default');
      if (!token) throw new Error('Managed identity did not return a token for api://AzureADTokenExchange');
      return token.token;
    };
  } else {
    msalConfig.auth.clientSecret = cfg.clientSecret;
  }
  const app = new ConfidentialClientApplication(msalConfig);

  return {
    getAuthCodeUrl: (r) =>
      app.getAuthCodeUrl({
        scopes: r.scopes,
        redirectUri: r.redirectUri,
        codeChallenge: r.codeChallenge,
        codeChallengeMethod: 'S256',
        state: r.state,
        nonce: r.nonce,
        responseMode: 'query',
        prompt: r.prompt,
      }),
    acquireTokenByCode: async (r) => {
      const result = await app.acquireTokenByCode({ code: r.code, scopes: r.scopes, redirectUri: r.redirectUri, codeVerifier: r.codeVerifier, nonce: r.nonce });
      return { idTokenClaims: (result.idTokenClaims ?? {}) as Record<string, unknown> };
    },
    acquireAppToken: async (scope) => {
      const result = await app.acquireTokenByClientCredential({ scopes: [scope] });
      if (!result?.accessToken) throw new Error('Microsoft Entra ID returned no access token');
      return result.accessToken;
    },
  };
}

/** Permissions (app roles) contained in an app-only access token – for display only, the token is not validated here. */
export function tokenAppRoles(accessToken: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { roles?: unknown };
    return Array.isArray(payload.roles) ? payload.roles.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}
