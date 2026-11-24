import type { RateLimitInfo } from '../types';

/** 将数字字符串安全解析为非负整数 */
function parseNonNegativeInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 解析 Retry-After 响应头（支持秒数与 HTTP-date 两种标准格式） */
function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds > 0 ? seconds * 1000 : null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isNaN(timestamp)) {
    const delta = timestamp - now;
    return delta > 0 ? delta : null;
  }
  return null;
}

/** 按候选键名列表顺序查找首个有效数值 */
function findFirstInt(map: Record<string, string>, exactKeys: string[], prefixFallback?: string): number | null {
  for (const key of exactKeys) {
    const val = parseNonNegativeInt(map[key]);
    if (val !== null) return val;
  }
  if (prefixFallback) {
    for (const [key, raw] of Object.entries(map)) {
      if (key.startsWith(prefixFallback) && !key.includes('month')) {
        const val = parseNonNegativeInt(raw);
        if (val !== null) return val;
      }
    }
  }
  return null;
}

/**
 * 解析 Mistral API 返回的所有限额与剩余额度响应头
 * 兼容标准字段及 5-minute 等窗口变体，同时完整保留原始 x-ratelimit-* 字典
 */
export function parseRateLimitHeaders(headers: Headers, now = Date.now()): RateLimitInfo {
  const rawHeaders: Record<string, string> = {};

  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-ratelimit')) {
      rawHeaders[lower] = value;
    }
  });

  const monthLimitTokens = findFirstInt(rawHeaders, ['x-ratelimit-limit-tokens-month']);
  const monthRemainingTokens = findFirstInt(rawHeaders, ['x-ratelimit-remaining-tokens-month']);

  const minuteLimitTokens = findFirstInt(
    rawHeaders,
    ['x-ratelimit-limit-tokens-minute', 'x-ratelimit-limit-tokens-5-minute'],
    'x-ratelimit-limit-tokens-',
  );
  const minuteRemainingTokens = findFirstInt(
    rawHeaders,
    ['x-ratelimit-remaining-tokens-minute', 'x-ratelimit-remaining-tokens-5-minute'],
    'x-ratelimit-remaining-tokens-',
  );

  const minuteLimitReq = findFirstInt(
    rawHeaders,
    ['x-ratelimit-limit-req-minute', 'x-ratelimit-limit-requests-minute'],
    'x-ratelimit-limit-req',
  );
  const minuteRemainingReq = findFirstInt(
    rawHeaders,
    ['x-ratelimit-remaining-req-minute', 'x-ratelimit-remaining-requests-minute'],
    'x-ratelimit-remaining-req',
  );

  const queryCostTokens = findFirstInt(rawHeaders, ['x-ratelimit-tokens-query-cost']);
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'), now);

  return {
    monthLimitTokens,
    monthRemainingTokens,
    minuteLimitTokens,
    minuteRemainingTokens,
    minuteLimitReq,
    minuteRemainingReq,
    queryCostTokens,
    retryAfterMs,
    rawHeaders,
  };
}
