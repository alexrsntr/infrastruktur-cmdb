import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config';

// TRUST_PROXY decides whose X-Forwarded-For header the app believes (client address = key of the sign-in rate limit).
describe('TRUST_PROXY', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function trustProxy(env: Record<string, string>) {
    process.env = { ...saved, NODE_ENV: 'test', AUTH_MODE: 'dev', SESSION_SECRET: 'test-secret-test-secret-test-secret-123' };
    delete process.env.TRUST_PROXY;
    delete process.env.WEBSITE_SITE_NAME;
    Object.assign(process.env, env);
    return loadConfig().trustProxy;
  }

  it('trusts no proxy by default, so a directly connected client cannot choose its address', () => {
    expect(trustProxy({})).toBe(false);
    expect(trustProxy({ TRUST_PROXY: '' })).toBe(false);
  });

  it('trusts the front end of Azure App Service without configuration', () => {
    expect(trustProxy({ WEBSITE_SITE_NAME: 'cmdb-prod' })).toBe(1);
    expect(trustProxy({ WEBSITE_SITE_NAME: 'cmdb-prod', TRUST_PROXY: '2' })).toBe(2);
    expect(trustProxy({ WEBSITE_SITE_NAME: 'cmdb-prod', TRUST_PROXY: 'false' })).toBe(false);
  });

  it('accepts a number of proxies, a list of addresses or false', () => {
    expect(trustProxy({ TRUST_PROXY: '1' })).toBe(1);
    expect(trustProxy({ TRUST_PROXY: '0' })).toBe(false);
    expect(trustProxy({ TRUST_PROXY: 'off' })).toBe(false);
    expect(trustProxy({ TRUST_PROXY: 'loopback, 10.0.0.0/8' })).toBe('loopback, 10.0.0.0/8');
  });

  it('rejects "true", which would trust every client', () => {
    expect(() => trustProxy({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });
});
