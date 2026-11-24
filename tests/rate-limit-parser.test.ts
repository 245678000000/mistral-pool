import { describe, expect, it } from 'vitest';
import { parseRateLimitHeaders } from '../src/lib/rate-limit-parser';

describe('parseRateLimitHeaders', () => {
  it('能正确解析标准的 Mistral 月度与分钟级限额响应头', () => {
    const headers = new Headers({
      'X-RateLimit-Limit-Tokens-Month': '1000000000',
      'X-RateLimit-Remaining-Tokens-Month': '987654321',
      'x-ratelimit-limit-tokens-minute': '500000',
      'x-ratelimit-remaining-tokens-minute': '499120',
      'x-ratelimit-limit-req-minute': '60',
      'x-ratelimit-remaining-req-minute': '59',
      'x-ratelimit-tokens-query-cost': '880',
      'content-type': 'application/json',
    });

    const result = parseRateLimitHeaders(headers);

    expect(result.monthLimitTokens).toBe(1_000_000_000);
    expect(result.monthRemainingTokens).toBe(987_654_321);
    expect(result.minuteLimitTokens).toBe(500_000);
    expect(result.minuteRemainingTokens).toBe(499_120);
    expect(result.minuteLimitReq).toBe(60);
    expect(result.minuteRemainingReq).toBe(59);
    expect(result.queryCostTokens).toBe(880);
    expect(result.retryAfterMs).toBeNull();
    expect(result.rawHeaders['x-ratelimit-remaining-tokens-month']).toBe('987654321');
    expect(result.rawHeaders['content-type']).toBeUndefined();
  });

  it('兼容 5-minute 窗口变体与秒数格式的 Retry-After', () => {
    const headers = new Headers({
      'x-ratelimit-limit-tokens-5-minute': '2000000',
      'x-ratelimit-remaining-tokens-5-minute': '1500000',
      'retry-after': '45',
    });

    const result = parseRateLimitHeaders(headers);

    expect(result.minuteLimitTokens).toBe(2_000_000);
    expect(result.minuteRemainingTokens).toBe(1_500_000);
    expect(result.retryAfterMs).toBe(45_000);
  });

  it('兼容 HTTP-date 格式的 Retry-After 并自动处理过期或无响应头情况', () => {
    const now = Date.UTC(2026, 10, 24, 6, 0, 0);
    const futureDate = new Date(now + 12_000).toUTCString();
    const headers = new Headers({
      'retry-after': futureDate,
    });

    const result = parseRateLimitHeaders(headers, now);
    expect(result.retryAfterMs).toBe(12_000);
    expect(result.monthLimitTokens).toBeNull();
    expect(result.rawHeaders).toEqual({});
  });
});
