import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  extractProxyToken,
  formatClientKeyPrefix,
  generateClientApiKey,
  hashClientKey,
  maskApiKey,
  verifyAdminPassword,
  verifyBearerToken,
  verifySessionToken,
} from '../src/lib/auth';

describe('auth 与脱敏工具', () => {
  it('按规则脱敏不同长度的 API Key 且不泄露中间明文', () => {
    expect(maskApiKey('mistral_live_1234567890abcd')).toBe('mist••••abcd');
    expect(maskApiKey('1234567890')).toBe('1234••••7890');
    expect(maskApiKey('abcdef')).toBe('ab••••ef');
    expect(maskApiKey('abc')).toBe('••••');
  });

  it('生成高熵客户端网关密钥、生成脱敏前缀并计算稳定 SHA-256 哈希', async () => {
    const key1 = generateClientApiKey();
    const key2 = generateClientApiKey();
    expect(key1).toMatch(/^mp-sk-[A-Za-z0-9_-]{32}$/);
    expect(key1).not.toBe(key2);

    const prefix = formatClientKeyPrefix(key1);
    expect(prefix).toContain('mp-sk-');
    expect(prefix).toContain('••••');
    expect(prefix.endsWith(key1.slice(-4))).toBe(true);

    const hashA = await hashClientKey(key1);
    const hashB = await hashClientKey(` ${key1} `);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(await hashClientKey(key2));
  });

  it('从 Authorization Bearer 与 x-api-key 请求头中正确提取代理令牌', () => {
    expect(extractProxyToken('Bearer mp-sk-abc', undefined)).toBe('mp-sk-abc');
    expect(extractProxyToken('bearer  mp-sk-xyz ', undefined)).toBe('mp-sk-xyz');
    expect(extractProxyToken(undefined, 'mp-sk-header')).toBe('mp-sk-header');
    expect(extractProxyToken(undefined, undefined)).toBeNull();
  });

  it('支持逗号分隔的多网关密钥校验及 x-api-key 兼容', async () => {
    const configured = 'mp-key-one, mp-key-two';
    expect(await verifyBearerToken('Bearer mp-key-one', undefined, configured)).toBe(true);
    expect(await verifyBearerToken('Bearer mp-key-two', undefined, configured)).toBe(true);
    expect(await verifyBearerToken(undefined, 'mp-key-two', configured)).toBe(true);
    expect(await verifyBearerToken('Bearer wrong-key', undefined, configured)).toBe(false);
    expect(await verifyBearerToken(undefined, undefined, configured)).toBe(false);
    expect(await verifyBearerToken('Bearer any', undefined, undefined)).toBe(false);
  });

  it('恒定时间校验管理员密码', async () => {
    expect(await verifyAdminPassword('secret-pass', 'secret-pass')).toBe(true);
    expect(await verifyAdminPassword('secret-pasx', 'secret-pass')).toBe(false);
    expect(await verifyAdminPassword('', 'secret-pass')).toBe(false);
  });

  it('签发并校验 HMAC-SHA256 会话凭证，拒绝篡改与过期凭证', async () => {
    const secret = 'test-session-secret-0123456789abcdef';
    const now = 1_795_500_000_000;
    const token = await createSessionToken(secret, 3600, now);

    expect(await verifySessionToken(token, secret, now + 1000)).toBe(true);
    expect(await verifySessionToken(token, secret, now + 3_700_000)).toBe(false);
    expect(await verifySessionToken(token + 'tamper', secret, now + 1000)).toBe(false);
    expect(await verifySessionToken(token, 'another-secret', now + 1000)).toBe(false);
    expect(await verifySessionToken(undefined, secret, now + 1000)).toBe(false);
  });
});
