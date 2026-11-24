import type { PoolRepository } from '../db/repository';
import { parseRateLimitHeaders } from './rate-limit-parser';
import { extractUsageFromObject } from './sse-usage';
import type { ApiKeyRecord, UsageInfo } from '../types';

const DEFAULT_429_COOLDOWN_MS = 60_000;
const DEFAULT_5XX_COOLDOWN_MS = 30_000;

export interface ProbeResult {
  keyId: number;
  name: string;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  monthRemainingTokens: number | null;
  monthLimitTokens: number | null;
  error: string | null;
}

/**
 * 对单个 Mistral Key 发起极低消耗测活探针（仅输出 1 个 token）：
 * 拉取官方实时响应头中的月度/分钟剩余额度与真实网络延迟，更新数据库状态
 */
export async function probeSingleKey(
  repo: PoolRepository,
  key: ApiKeyRecord,
  probeModel: string,
  upstreamBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const url = `${upstreamBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const startedAt = Date.now();

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: probeModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        temperature: 0,
      }),
    });
  } catch (err) {
    const now = Date.now();
    const latencyMs = Math.max(1, now - startedAt);
    const msg = err instanceof Error ? err.message : '探针连接失败';
    await repo.recordFailure(key.id, 'cooldown', now + DEFAULT_5XX_COOLDOWN_MS, msg, null, now);
    return {
      keyId: key.id,
      name: key.name,
      ok: false,
      statusCode: 0,
      latencyMs,
      monthRemainingTokens: key.month_remaining_tokens,
      monthLimitTokens: key.month_limit_tokens,
      error: msg,
    };
  }

  const now = Date.now();
  const latencyMs = Math.max(1, now - startedAt);
  const rateLimit = parseRateLimitHeaders(resp.headers, now);

  if (resp.ok) {
    let usage: UsageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    try {
      const json: unknown = await resp.json();
      usage = extractUsageFromObject(json) ?? usage;
    } catch {
      // 忽略解析异常
    }

    // 测活请求刷新额度、状态与延迟，不计入用户业务对话次数，不写入业务流水表
    await repo.recordSuccess(key.id, rateLimit, usage, latencyMs, now, { countAsRequest: false });
    return {
      keyId: key.id,
      name: key.name,
      ok: true,
      statusCode: resp.status,
      latencyMs,
      monthRemainingTokens: rateLimit.monthRemainingTokens ?? key.month_remaining_tokens,
      monthLimitTokens: rateLimit.monthLimitTokens ?? key.month_limit_tokens,
      error: null,
    };
  }

  const errBody = (await resp.text().catch(() => '')).slice(0, 300) || `HTTP ${resp.status}`;

  if (resp.status === 429) {
    const exhausted = rateLimit.monthRemainingTokens === 0;
    await repo.recordFailure(
      key.id,
      exhausted ? 'exhausted' : 'cooldown',
      exhausted ? null : now + (rateLimit.retryAfterMs ?? DEFAULT_429_COOLDOWN_MS),
      errBody,
      rateLimit,
      now,
    );
  } else if (resp.status === 401 || resp.status === 403) {
    await repo.recordFailure(key.id, 'invalid', null, errBody, rateLimit, now);
  } else if (resp.status >= 500) {
    await repo.recordFailure(key.id, 'cooldown', now + DEFAULT_5XX_COOLDOWN_MS, errBody, rateLimit, now);
  }

  return {
    keyId: key.id,
    name: key.name,
    ok: false,
    statusCode: resp.status,
    latencyMs,
    monthRemainingTokens: rateLimit.monthRemainingTokens ?? key.month_remaining_tokens,
    monthLimitTokens: rateLimit.monthLimitTokens ?? key.month_limit_tokens,
    error: errBody,
  };
}

/** 并发测活池内全部已启用的 Key */
export async function probeAllEnabledKeys(
  repo: PoolRepository,
  probeModel: string,
  upstreamBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult[]> {
  const keys = (await repo.listKeys()).filter((k) => k.enabled === 1);
  const settled = await Promise.allSettled(
    keys.map((key) => probeSingleKey(repo, key, probeModel, upstreamBaseUrl, fetchImpl)),
  );

  return settled.map((item, idx) => {
    if (item.status === 'fulfilled') return item.value;
    const key = keys[idx];
    return {
      keyId: key.id,
      name: key.name,
      ok: false,
      statusCode: 0,
      latencyMs: 0,
      monthRemainingTokens: key.month_remaining_tokens,
      monthLimitTokens: key.month_limit_tokens,
      error: item.reason instanceof Error ? item.reason.message : '测活执行异常',
    };
  });
}
