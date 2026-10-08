import { describe, expect, it, vi } from 'vitest';
import { FeishuSdkReadGateway, bindSdkReads } from '../packages/feishu/src/sdk-reads.js';
import { createSafeSdkClient } from '../packages/feishu/src/sdk-client.js';
import { demoIdentity } from '../packages/feishu/src/fixtures.js';
import { DomainError } from '../packages/policy/src/core.js';

const tokens = (accessToken = 'synthetic_initial') => ({ accessToken, refreshToken: 'synthetic_refresh', expiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 120_000 });
function setup(status = 429) {
  const identity = demoIdentity();
  const request = vi.fn().mockRejectedValueOnce({ response: { status } }).mockResolvedValue({ code: 0, data: { name: 'Fixture', open_id: 'ou_fixture', tenant_key: identity.tenantId } });
  const get = vi.fn().mockImplementation(async () => tokens());
  const sleep = vi.fn().mockResolvedValue(undefined);
  const client = createSafeSdkClient({ appId: 'synthetic', appSecret: 'synthetic', domain: 'feishu', httpInstance: { request } as never });
  const gateway = new FeishuSdkReadGateway({ identity, reads: bindSdkReads(client) }, { get }, sleep);
  return { identity, request, get, sleep, gateway };
}
describe('provider retry authorization revalidation', () => {
  it.each([
    ['grant revoked', 'AUTH_REQUIRED'],
    ['HTTP request closed', 'UPSTREAM_ERROR'],
    ['actual grant lost its required scope', 'INSUFFICIENT_SCOPE'],
  ] as const)('stops before another transport attempt when %s during backoff', async (reason, type) => {
    const s = setup(503);
    const failure = new DomainError(type, reason);
    s.sleep.mockImplementation(async () => { s.get.mockRejectedValue(failure); });
    await expect(s.gateway.call('profile', {}, s.identity)).rejects.toBe(failure);
    expect(s.get).toHaveBeenCalledTimes(2);
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.sleep).toHaveBeenCalledTimes(1);
  });
  it.each(['expired', 'missing', 'nonfinite'] as const)('stops if provider authorization becomes %s during backoff', async state => {
    const s = setup(503);
    s.sleep.mockImplementation(async () => { s.get.mockResolvedValue({ ...tokens(), ...(state === 'expired' ? { expiresAt: Date.now() - 1 } : state === 'nonfinite' ? { expiresAt: Number.NaN } : { accessToken: '' }) }); });
    await expect(s.gateway.call('profile', {}, s.identity)).rejects.toMatchObject({ type: 'AUTH_REQUIRED' });
    expect(s.get).toHaveBeenCalledTimes(2);
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('uses the currently authorized credential for a permitted retry, without reusing the previous token', async () => {
    const s = setup();
    s.sleep.mockImplementation(async () => { s.get.mockResolvedValue(tokens('synthetic_current')); });
    await expect(s.gateway.call('profile', {}, s.identity)).resolves.toMatchObject({ open_id: 'ou_fixture' });
    expect(s.get).toHaveBeenCalledTimes(2);
    expect(s.request.mock.calls.map(call => call[0].headers.Authorization)).toEqual(['Bearer synthetic_initial', 'Bearer synthetic_current']);
  });
  it.each([429, 500, 503])('revalidates all bounded attempts after HTTP %s', async status => {
    const s = setup(status);
    s.request.mockRejectedValue({ response: { status } });
    await expect(s.gateway.call('profile', {}, s.identity)).rejects.toMatchObject({ type: status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR' });
    expect(s.get).toHaveBeenCalledTimes(3);
    expect(s.request).toHaveBeenCalledTimes(3);
    expect(s.sleep).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403])('does not retry upstream authentication/permission failure %s', async status => {
    const s = setup(status);
    await expect(s.gateway.call('profile', {}, s.identity)).rejects.toMatchObject({ type: status === 401 ? 'AUTH_REQUIRED' : 'PERMISSION_DENIED' });
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.sleep).not.toHaveBeenCalled();
  });
});
