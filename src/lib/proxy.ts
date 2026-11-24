import type { PoolRepository } from '../db/repository';
import { parseRateLimitHeaders } from './rate-limit-parser';
import { selectCandidateKeys } from './scheduler';
import { createSseUsageTap, extractUsageFromObject } from './sse-usage';
import type { ApiKeyRecord, UsageInfo } from '../types';

const DEFAULT_429_COOLDOWN_MS = 60_000;
const DEFAULT_5XX_COOLDOWN_MS = 30_000;
const MAX_FAILOVER_ATTEMPTS = 10;

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'authorization',
  'x-api-key',
  'x-mistral-key-id',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
]);

export interface ClientKeyContext {
  id: number | null;
  name: string;
}

export interface ProxyRequestParams {
  request: Request;
  upstreamBaseUrl: string;
  repo: PoolRepository;
  waitUntil: (promise: Promise<unknown>) => void;
  pinnedKeyId?: number;
  clientKey?: ClientKeyContext;
  fetchImpl?: typeof fetch;
}

/** 构造 OpenAI 兼容错误响应 */
function openAiError(status: number, message: string, type = 'mistral_pool_error'): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        code: status,
      },
    }),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    },
  );
}

/** 过滤逐跳头并注入当前所选 Mistral API Key */
function buildUpstreamHeaders(incoming: Headers, mistralApiKey: string): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  headers.set('authorization', `Bearer ${mistralApiKey}`);
  return headers;
}

/** 构造转发给客户端的响应头（剥离冲突的传输头并附带命中的 Key 调试头） */
function buildClientResponseHeaders(upstreamHeaders: Headers, keyName: string, attempts: number): Headers {
  const headers = new Headers();
  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== 'content-length' && lower !== 'content-encoding' && lower !== 'transfer-encoding') {
      headers.set(key, value);
    }
  });
  // 纯 ASCII 名称保留原样便于调试阅读，含中文等非 ASCII 字符时做 URL 编码防止 Headers.set 抛异常
  const safeHeaderKeyName = /^[\x20-\x7E]+$/.test(keyName) ? keyName : encodeURIComponent(keyName);
  headers.set('x-mistral-pool-key', safeHeaderKeyName);
  headers.set('x-mistral-pool-attempts', String(attempts));
  return headers;
}

/** 从请求体提取 model 与 stream 标志（仅解析 JSON，不修改原载荷） */
function parseRequestMeta(bodyBuffer: ArrayBuffer | null, contentType: string | null): {
  model: string | null;
  isStream: boolean;
} {
  if (!bodyBuffer || !contentType?.toLowerCase().includes('application/json')) {
    return { model: null, isStream: false };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBuffer)) as {
      model?: unknown;
      stream?: unknown;
    };
    return {
      model: typeof parsed.model === 'string' ? parsed.model : null,
      isStream: parsed.stream === true,
    };
  } catch {
    return { model: null, isStream: false };
  }
}

/** 从错误响应中提取简短可读报错摘要 */
async function readShortError(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.slice(0, 300) || `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}

/**
 * 核心代理转发与故障转移引擎：
 * 自动选号 -> 透传上游 -> 解析限额头 -> 遇 429/401/5xx 自动无缝换号重试 -> 异步落库记账
 */
export async function handleProxyRequest(params: ProxyRequestParams): Promise<Response> {
  const { request, repo, waitUntil, pinnedKeyId, clientKey } = params;
  const fetchFn = params.fetchImpl ?? fetch;
  const baseUrl = params.upstreamBaseUrl.replace(/\/+$/, '');
  const reqUrl = new URL(request.url);
  const endpoint = reqUrl.pathname;
  const upstreamUrl = `${baseUrl}${reqUrl.pathname}${reqUrl.search}`;
  const method = request.method.toUpperCase();
  const clientKeyName = clientKey?.name ?? null;

  // 对非 GET/HEAD 请求一次性读取 Body，保证切号重试时可重复发送
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const bodyBuffer = hasBody ? await request.arrayBuffer() : null;
  const { model, isStream: reqStreamFlag } = parseRequestMeta(bodyBuffer, request.headers.get('content-type'));

  // 决定候选 Key 队列
  let candidates: ApiKeyRecord[] = [];
  if (pinnedKeyId !== undefined) {
    const found = await repo.getKeyById(pinnedKeyId);
    if (!found) {
      return openAiError(404, `指定的 Key (#${pinnedKeyId}) 不存在`);
    }
    candidates = [found];
  } else {
    const [allKeys, settings] = await Promise.all([repo.listKeys(), repo.getSettings()]);
    if (allKeys.length === 0) {
      return openAiError(503, '号池中尚未添加任何 Mistral API Key，请先登录管理看板导入');
    }
    candidates = selectCandidateKeys(allKeys, settings.routing_strategy, Date.now());
    if (candidates.length === 0) {
      const nextCooldown = allKeys
        .filter((k) => k.enabled === 1 && k.status === 'cooldown' && k.cooldown_until)
        .map((k) => k.cooldown_until as number)
        .sort((a, b) => a - b)[0];
      const hint = nextCooldown
        ? `，预计 ${Math.max(1, Math.ceil((nextCooldown - Date.now()) / 1000))} 秒后有账号解除冷却`
        : '';
      return openAiError(429, `当前池内全部 Mistral Key 均处于冷却、耗尽、停用或失效状态${hint}`);
    }
  }

  const maxAttempts = Math.min(candidates.length, MAX_FAILOVER_ATTEMPTS);
  const failureNotes: string[] = [];
  let sawRateLimit = false;

  for (let i = 0; i < maxAttempts; i += 1) {
    const key = candidates[i];
    const attemptNumber = i + 1;
    const startedAt = Date.now();

    let upstreamResp: Response;
    try {
      upstreamResp = await fetchFn(upstreamUrl, {
        method,
        headers: buildUpstreamHeaders(request.headers, key.api_key),
        body: bodyBuffer ? bodyBuffer.slice(0) : undefined,
      });
    } catch (err) {
      const now = Date.now();
      const msg = err instanceof Error ? err.message : '网络请求上游失败';
      failureNotes.push(`${key.name}: 网络异常(${msg})`);
      await repo.recordFailure(key.id, 'cooldown', now + DEFAULT_5XX_COOLDOWN_MS, msg, null, now);
      continue;
    }

    const latencyMs = Math.max(1, Date.now() - startedAt);
    const now = Date.now();
    const rateLimit = parseRateLimitHeaders(upstreamResp.headers, now);

    // 1. 请求成功（2xx）
    if (upstreamResp.ok) {
      const respHeaders = buildClientResponseHeaders(upstreamResp.headers, key.name, attemptNumber);
      const isEventStream =
        reqStreamFlag || (upstreamResp.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false);

      const persistSuccess = (usage: UsageInfo) => {
        const tasks: Promise<unknown>[] = [
          repo.recordSuccess(key.id, rateLimit, usage, latencyMs, now, { countAsRequest: true }),
          repo.insertLogAndPrune({
            key_id: key.id,
            key_name: key.name,
            client_key_name: clientKeyName,
            endpoint,
            model,
            is_stream: isEventStream ? 1 : 0,
            status_code: upstreamResp.status,
            latency_ms: latencyMs,
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            attempts: attemptNumber,
            error_summary: null,
            created_at: now,
          }),
        ];
        if (clientKey?.id !== null && clientKey?.id !== undefined) {
          tasks.push(repo.recordClientKeyUsage(clientKey.id, usage.totalTokens, now));
        }
        waitUntil(Promise.all(tasks));
      };

      if (isEventStream && upstreamResp.body) {
        const tap = createSseUsageTap((usage: UsageInfo) => persistSuccess(usage));
        return new Response(upstreamResp.body.pipeThrough(tap), {
          status: upstreamResp.status,
          headers: respHeaders,
        });
      }

      // 非流式响应：读取响应体提取 usage 后原样返回
      const respText = await upstreamResp.text();
      let usage: UsageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      if (upstreamResp.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        try {
          const parsed: unknown = JSON.parse(respText);
          usage = extractUsageFromObject(parsed) ?? usage;
        } catch {
          // 忽略非预期 JSON
        }
      }

      persistSuccess(usage);
      return new Response(respText, {
        status: upstreamResp.status,
        headers: respHeaders,
      });
    }

    // 2. 限流或月度额度耗尽（429）：标记冷却/耗尽并自动切下一个 Key
    if (upstreamResp.status === 429) {
      sawRateLimit = true;
      const errMsg = await readShortError(upstreamResp);
      const isExhausted = rateLimit.monthRemainingTokens === 0;
      const status = isExhausted ? 'exhausted' : 'cooldown';
      const cooldownUntil = isExhausted ? null : now + (rateLimit.retryAfterMs ?? DEFAULT_429_COOLDOWN_MS);
      failureNotes.push(`${key.name}: 429 ${isExhausted ? '本月额度耗尽' : '触发限流'}`);
      await repo.recordFailure(key.id, status, cooldownUntil, errMsg, rateLimit, now);
      continue;
    }

    // 3. Key 失效或无权限（401/403）：标记失效并切下一个 Key
    if (upstreamResp.status === 401 || upstreamResp.status === 403) {
      const errMsg = await readShortError(upstreamResp);
      failureNotes.push(`${key.name}: ${upstreamResp.status} 密钥失效`);
      await repo.recordFailure(key.id, 'invalid', null, errMsg, rateLimit, now);
      continue;
    }

    // 4. 上游服务异常（5xx）：短暂冷却并切下一个 Key
    if (upstreamResp.status >= 500) {
      const errMsg = await readShortError(upstreamResp);
      failureNotes.push(`${key.name}: ${upstreamResp.status} 上游异常`);
      await repo.recordFailure(key.id, 'cooldown', now + DEFAULT_5XX_COOLDOWN_MS, errMsg, rateLimit, now);
      continue;
    }

    // 5. 其他 4xx（如 400 参数错误、404 模型不存在）：不惩罚 Key，原样透传给调用方
    const respText = await upstreamResp.text();
    const respHeaders = buildClientResponseHeaders(upstreamResp.headers, key.name, attemptNumber);
    waitUntil(
      repo.insertLogAndPrune({
        key_id: key.id,
        key_name: key.name,
        client_key_name: clientKeyName,
        endpoint,
        model,
        is_stream: reqStreamFlag ? 1 : 0,
        status_code: upstreamResp.status,
        latency_ms: latencyMs,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        attempts: attemptNumber,
        error_summary: respText.slice(0, 300),
        created_at: now,
      }),
    );

    return new Response(respText, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  // 所有候选 Key 均尝试失败
  const summary = `已尝试 ${maxAttempts} 个账号均失败：${failureNotes.join('；')}`;
  waitUntil(
    repo.insertLogAndPrune({
      key_id: null,
      key_name: null,
      client_key_name: clientKeyName,
      endpoint,
      model,
      is_stream: reqStreamFlag ? 1 : 0,
      status_code: sawRateLimit ? 429 : 503,
      latency_ms: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      attempts: maxAttempts,
      error_summary: summary,
      created_at: Date.now(),
    }),
  );

  return openAiError(sawRateLimit ? 429 : 503, summary);
}
