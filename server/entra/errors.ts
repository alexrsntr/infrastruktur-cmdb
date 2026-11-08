import { GraphError } from './graph';

/**
 * Turns MSAL / managed identity / Graph / network errors into a message an administrator can act on.
 * Never includes secrets or tokens (MSAL and Graph error messages do not contain them; we only keep codes).
 */
export interface ExplainedError {
  error: string;
  hint?: string;
  /** HTTP status for API responses */
  status: number;
  /** Short code for logs and the audit log */
  code: string;
}

const FIREWALL_HINT =
  'Allow outbound HTTPS (port 443) from the app to login.microsoftonline.com and graph.microsoft.com. ' +
  'With "route all traffic through the virtual network" the firewall must permit both host names.';

const AADSTS: Record<string, { error: string; hint?: string }> = {
  '90002': { error: 'Tenant not found.', hint: 'Check the tenant ID (Directory ID in the overview of Microsoft Entra ID).' },
  '900023': { error: 'The tenant ID is not valid.', hint: 'Use the tenant ID (a GUID) from the overview of Microsoft Entra ID.' },
  '700016': { error: 'The application (client ID) was not found in this tenant.', hint: 'Check the Application (client) ID of the app registration and that it belongs to this tenant.' },
  '7000215': { error: 'The client secret is not valid.', hint: 'Enter the secret *Value* (not the Secret ID) of the app registration, or create a new secret.' },
  '7000222': { error: 'The client secret has expired.', hint: 'Create a new client secret in the app registration (Certificates & secrets) and save it here.' },
  '700213': { error: 'The federated credential does not match the managed identity.', hint: 'Check issuer, subject (object ID of the managed identity) and audience api://AzureADTokenExchange of the federated credential.' },
  '700211': { error: 'The federated credential issuer is not accepted.', hint: 'Issuer must be https://login.microsoftonline.com/<tenant-id>/v2.0.' },
  '700212': { error: 'No federated credential matches the managed identity.', hint: 'Add a federated credential for the managed identity to the app registration.' },
  '70021': { error: 'No matching federated credential found.', hint: 'Add a federated credential for the managed identity to the app registration.' },
  '65001': { error: 'Consent is missing.', hint: 'Grant admin consent for the API permissions of the app registration.' },
  '650057': { error: 'A permission is not configured on the app registration.', hint: 'Add the Microsoft Graph permissions listed below and grant admin consent.' },
  '50020': { error: 'This account is from another tenant.', hint: 'Sign in with an account of the configured tenant.' },
  '50011': { error: 'The redirect URI is not registered.', hint: 'Add the redirect URIs shown on this page to the app registration (Authentication → Web).' },
  '500113': { error: 'No redirect URI is registered for the application.', hint: 'Add the redirect URIs shown on this page to the app registration (Authentication → Web).' },
};

const NETWORK_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'];

function textOf(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err ?? '');
  const e = err as { message?: string; errorMessage?: string; errorCode?: string; code?: string; cause?: unknown };
  return [e.errorCode, e.code, e.errorMessage, e.message, e.cause ? textOf(e.cause) : ''].filter(Boolean).join(' ');
}

export function isNetworkError(err: unknown): boolean {
  const text = textOf(err);
  return (
    NETWORK_CODES.some((c) => text.includes(c)) ||
    /fetch failed|network_error|endpoints_resolution_error|socket hang up|getaddrinfo|The operation was aborted|TimeoutError/i.test(text)
  );
}

export function explainEntraError(err: unknown, permission?: string): ExplainedError {
  if (err instanceof GraphError) {
    if (err.status === 403 || err.code === 'Authorization_RequestDenied') {
      return {
        status: 502,
        code: 'graph-forbidden',
        error: `Microsoft Graph denied access${permission ? ` (permission ${permission} missing)` : ''}.`,
        hint: `Add the Microsoft Graph application permission${permission ? ` ${permission}` : 's'} to the app registration and grant admin consent.`,
      };
    }
    if (err.status === 401) return { status: 502, code: 'graph-unauthorized', error: 'Microsoft Graph rejected the token.', hint: 'Check tenant, application and admin consent.' };
    if (err.status === 404) return { status: 404, code: 'graph-not-found', error: 'Not found in Microsoft Entra ID.' };
    if (err.status === 429) return { status: 503, code: 'graph-throttled', error: 'Microsoft Graph is busy (throttling). Please try again in a minute.' };
    if (err.status === 400) return { status: 400, code: 'graph-bad-request', error: 'Microsoft Graph could not process the request.' };
    return { status: 502, code: `graph-${err.status}`, error: `Microsoft Graph returned an error (HTTP ${err.status}).` };
  }

  const text = textOf(err);
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'CredentialUnavailableError') {
    return {
      status: 502,
      code: 'managed-identity-unavailable',
      error: 'The managed identity is not available.',
      hint: 'Enable the managed identity of the App Service (Identity) or enter the client ID of the user-assigned identity.',
    };
  }
  if (isNetworkError(err)) {
    return { status: 504, code: 'network', error: 'Microsoft Entra ID / Microsoft Graph could not be reached.', hint: FIREWALL_HINT };
  }
  const aadsts = text.match(/AADSTS(\d+)/)?.[1];
  if (aadsts) {
    const known = AADSTS[aadsts];
    return { status: 502, code: `AADSTS${aadsts}`, error: known ? `${known.error} (AADSTS${aadsts})` : `Microsoft Entra ID rejected the request (AADSTS${aadsts}).`, hint: known?.hint };
  }
  return { status: 502, code: 'unknown', error: 'The request to Microsoft Entra ID failed.', hint: 'Check the configuration and the server log.' };
}
