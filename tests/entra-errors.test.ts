import { describe, expect, it } from 'vitest';
import { ClientAuthError } from '@azure/msal-node';
import { errorDetail, explainEntraError, sanitizeMessage } from '../server/entra/errors';

/** Error explanations for administrators and safe log details (no tokens, codes, secrets, claims). */

describe('explainEntraError', () => {
  it('explains the MSAL nonce mismatch instead of "unknown"', () => {
    const e = explainEntraError(new ClientAuthError('nonce_mismatch', 'corr-123'));
    expect(e.code).toBe('msal-nonce_mismatch');
    expect(e.error).toMatch(/does not belong to this sign-in request \(nonce\)/);
    expect(e.detail).toMatchObject({ name: 'ClientAuthError', errorCode: 'nonce_mismatch', correlationId: 'corr-123' });
  });

  it('names PostgreSQL errors by their SQLSTATE', () => {
    const missingColumn = Object.assign(new Error('column "role_detail" of relation "app_user" does not exist'), { code: '42703', severity: 'ERROR' });
    expect(explainEntraError(missingColumn)).toMatchObject({ code: 'db-42703', error: expect.stringMatching(/not up to date/), detail: { pgCode: '42703' } });
    const duplicate = Object.assign(new Error('duplicate key value violates unique constraint "app_user_oid_key"'), { code: '23505', severity: 'ERROR' });
    expect(explainEntraError(duplicate)).toMatchObject({ code: 'db-23505', error: expect.stringMatching(/already linked/) });
    expect(explainEntraError(Object.assign(new Error('x'), { code: '22P02', severity: 'ERROR' })).code).toBe('db-22P02');
  });

  it('never falls back to a silent "unknown"', () => {
    const e = explainEntraError(new TypeError("Cannot read properties of undefined (reading 'toLowerCase')"));
    expect(e.code).toBe('TypeError');
    expect(e.error).toContain('(TypeError)');
    expect(e.hint).toMatch(/^Reason: Cannot read properties of undefined/);
    expect(explainEntraError(Object.assign(new Error('boom'), { name: 'ServerError', errorCode: 'some_new_code' })).code).toBe('ServerError:some_new_code');
    expect(explainEntraError('plain string').code).toBe('Error');
  });

  it('keeps the known AADSTS and network explanations', () => {
    expect(explainEntraError(Object.assign(new Error('invalid_grant: AADSTS7000222: The provided client secret keys are expired.'), { name: 'ServerError', errorCode: 'invalid_grant' })).code).toBe('AADSTS7000222');
    const net = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com'), { code: 'ENOTFOUND' }) });
    expect(explainEntraError(net).code).toBe('network');
  });
});

describe('safe log details', () => {
  const jwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJvaWQiOiJhYmMiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJjbGQifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

  it('removes tokens, authorization codes, secrets and e-mail addresses', () => {
    const msg = sanitizeMessage(
      `invalid_grant: token ${jwt} rejected; body code=0.AXwAabc123_-x&client_secret=Abc~123.xyz&code_verifier=verif; user cld.test@contoso4.onmicrosoft.com; ` +
        `refresh 0.ARoA6Bz1kN7Q2v3xQh9LmPqRsTuVwXyZaBcDeFgHiJkLmNoP`,
    );
    expect(msg).not.toContain('eyJ');
    expect(msg).not.toContain('AXwAabc123');
    expect(msg).not.toContain('Abc~123');
    expect(msg).not.toContain('verif;');
    expect(msg).not.toContain('cld.test');
    expect(msg).not.toContain('ARoA6Bz1kN7Q2v3xQh9');
    expect(msg).toContain('code=[redacted]');
    expect(msg).toContain('[e-mail]');
  });

  it('shortens long messages', () => {
    expect(sanitizeMessage('word '.repeat(200)).length).toBeLessThanOrEqual(200);
  });

  it('keeps only codes and the sanitized message', () => {
    const d = errorDetail(Object.assign(new Error(`AADSTS50011: redirect for ${jwt}`), { name: 'ServerError', errorCode: 'invalid_request', subError: '', claims: '{"x":1}' }));
    expect(d).toEqual({ name: 'ServerError', errorCode: 'invalid_request', subError: undefined, correlationId: undefined, pgCode: undefined, message: 'AADSTS50011: redirect for [token]' });
  });
});
