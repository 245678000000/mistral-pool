import { describe, expect, it } from 'vitest';
import type {
  CreateClientKeyInput,
  PoolRepository,
  UpdateClientKeyInput,
} from '../src/db/repository';
import { handleProxyRequest } from '../src/lib/proxy';
import { probeSingleKey } from '../src/lib/probe';
import type {
  ApiKeyRecord,
  ClientKeyRecord,
  PoolSettings,
  RateLimitInfo,
  RequestLogRecord,
  TodayStats,
  UsageInfo,
} from '../src/types';

/** 内存版仓储实现，用于隔离 D1 测试代理故障转移、客户端密钥记账与状态机 */
class MemoryPoolRepository implements PoolRepository {
  keys: ApiKeyRecord[] = [];
  clientKeys: ClientKeyRecord[] = [];
  logs: RequestLogRecord[] = [];
  settings: PoolSettings = {
    routing_strategy: 'remaining_first',
    probe_model: 'mistral-small-latest',
  };
  private nextKeyId = 1;
  private nextClientKeyId = 1;
  private nextLogId = 1;

  seedKey(partial: Partial<ApiKeyRecord> & { name: string; api_key: string }): ApiKeyRecord {
    const now = Date.now();
    const record: ApiKeyRecord = {
      id: this.nextKeyId++,
      name: partial.name,
      api_key: partial.api_key,
      enabled: partial.enabled ?? 1,
      priority: partial.priority ?? this.nextKeyId,
      status: partial.status ?? 'healthy',
      cooldown_until: partial.cooldown_until ?? null,
      latency_ms: partial.latency_ms ?? null,
      month_limit_tokens: partial.month_limit_tokens ?? 1_000_000_000,
      month_remaining_tokens: partial.month_remaining_tokens ?? 500_000_000,
      minute_limit_tokens: partial.minute_limit_tokens ?? null,
      minute_remaining_tokens: partial.minute_remaining_tokens ?? null,
      minute_limit_req: partial.minute_limit_req ?? null,
      minute_remaining_req: partial.minute_remaining_req ?? null,
      raw_rate_headers: partial.raw_rate_headers ?? null,
      total_requests: partial.total_requests ?? 0,
      total_prompt_tokens: partial.total_prompt_tokens ?? 0,
      total_completion_tokens: partial.total_completion_tokens ?? 0,
      custom_note: partial.custom_note ?? '',
      last_checked_at: partial.last_checked_at ?? now,
      last_used_at: partial.last_used_at ?? null,
      last_error: partial.last_error ?? null,
      created_at: now,
      updated_at: now,
    };
    this.keys.push(record);
    return record;
  }

  async listKeys(): Promise<ApiKeyRecord[]> {
    return this.keys.map((k) => ({ ...k }));
  }

  async getKeyById(id: number): Promise<ApiKeyRecord | null> {
    const found = this.keys.find((k) => k.id === id);
    return found ? { ...found } : null;
  }

  async createKey(input: { name: string; api_key: string; priority?: number; custom_note?: string }): Promise<ApiKeyRecord> {
    return this.seedKey(input);
  }

  async createKeysBatch(items: Array<{ name: string; api_key: string; custom_note?: string }>): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;
    for (const item of items) {
      if (this.keys.some((k) => k.api_key === item.api_key)) {
        skipped += 1;
      } else {
        this.seedKey(item);
        created += 1;
      }
    }
    return { created, skipped };
  }

  async updateKey(): Promise<ApiKeyRecord | null> {
    return null;
  }

  async deleteKey(id: number): Promise<boolean> {
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.id !== id);
    return this.keys.length < before;
  }

  async recordSuccess(
    keyId: number,
    rateLimit: RateLimitInfo,
    usage: UsageInfo,
    latencyMs: number,
    now: number,
    options?: { countAsRequest?: boolean },
  ): Promise<void> {
    const key = this.keys.find((k) => k.id === keyId);
    if (!key) return;
    const countReq = options?.countAsRequest ?? true;
    key.status = rateLimit.monthRemainingTokens === 0 ? 'exhausted' : 'healthy';
    key.cooldown_until = null;
    key.latency_ms = latencyMs;
    if (rateLimit.monthLimitTokens !== null) key.month_limit_tokens = rateLimit.monthLimitTokens;
    if (rateLimit.monthRemainingTokens !== null) key.month_remaining_tokens = rateLimit.monthRemainingTokens;
    if (rateLimit.minuteLimitTokens !== null) key.minute_limit_tokens = rateLimit.minuteLimitTokens;
    if (rateLimit.minuteRemainingTokens !== null) key.minute_remaining_tokens = rateLimit.minuteRemainingTokens;
    if (rateLimit.minuteLimitReq !== null) key.minute_limit_req = rateLimit.minuteLimitReq;
    if (rateLimit.minuteRemainingReq !== null) key.minute_remaining_req = rateLimit.minuteRemainingReq;
    if (Object.keys(rateLimit.rawHeaders).length > 0) {
      key.raw_rate_headers = JSON.stringify(rateLimit.rawHeaders);
    }
    if (countReq) {
      key.total_requests += 1;
      key.last_used_at = now;
    }
    key.total_prompt_tokens += usage.promptTokens;
    key.total_completion_tokens += usage.completionTokens;
    key.last_checked_at = now;
    key.last_error = null;
    key.updated_at = now;
  }

  async recordFailure(
    keyId: number,
    status: 'cooldown' | 'exhausted' | 'invalid',
    cooldownUntil: number | null,
    errorMessage: string,
    rateLimit: RateLimitInfo | null,
    now: number,
  ): Promise<void> {
    const key = this.keys.find((k) => k.id === keyId);
    if (!key) return;
    key.status = status;
    key.cooldown_until = cooldownUntil;
    key.last_error = errorMessage;
    key.last_checked_at = now;
    key.updated_at = now;
    if (rateLimit) {
      if (rateLimit.monthLimitTokens !== null) key.month_limit_tokens = rateLimit.monthLimitTokens;
      if (rateLimit.monthRemainingTokens !== null) key.month_remaining_tokens = rateLimit.monthRemainingTokens;
    }
  }

  async listClientKeys(): Promise<ClientKeyRecord[]> {
    return this.clientKeys.map((k) => ({ ...k }));
  }

  async getClientKeyById(id: number): Promise<ClientKeyRecord | null> {
    const found = this.clientKeys.find((k) => k.id === id);
    return found ? { ...found } : null;
  }

  async findClientKeyByHash(keyHash: string): Promise<ClientKeyRecord | null> {
    const found = this.clientKeys.find((k) => k.key_hash === keyHash);
    return found ? { ...found } : null;
  }

  async createClientKey(input: CreateClientKeyInput): Promise<ClientKeyRecord> {
    const now = Date.now();
    const record: ClientKeyRecord = {
      id: this.nextClientKeyId++,
      name: input.name,
      key_prefix: input.key_prefix,
      key_hash: input.key_hash,
      enabled: 1,
      total_requests: 0,
      total_tokens: 0,
      last_used_at: null,
      created_at: now,
      updated_at: now,
    };
    this.clientKeys.push(record);
    return { ...record };
  }

  async updateClientKey(id: number, input: UpdateClientKeyInput): Promise<ClientKeyRecord | null> {
    const found = this.clientKeys.find((k) => k.id === id);
    if (!found) return null;
    if (input.name !== undefined) found.name = input.name;
    if (input.enabled !== undefined) found.enabled = input.enabled ? 1 : 0;
    found.updated_at = Date.now();
    return { ...found };
  }

  async deleteClientKey(id: number): Promise<boolean> {
    const before = this.clientKeys.length;
    this.clientKeys = this.clientKeys.filter((k) => k.id !== id);
    return this.clientKeys.length < before;
  }

  async recordClientKeyUsage(id: number, tokens: number, now: number): Promise<void> {
    const found = this.clientKeys.find((k) => k.id === id);
    if (!found) return;
    found.total_requests += 1;
    found.total_tokens += tokens;
    found.last_used_at = now;
    found.updated_at = now;
  }

  async insertLogAndPrune(entry: Omit<RequestLogRecord, 'id'>): Promise<void> {
    this.logs.unshift({ id: this.nextLogId++, ...entry });
  }

  async listLogs(limit = 100): Promise<RequestLogRecord[]> {
    return this.logs.slice(0, limit);
  }

  async getTodayStats(): Promise<TodayStats> {
    return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  async getSettings(): Promise<PoolSettings> {
    return { ...this.settings };
  }

  async updateSettings(partial: Partial<PoolSettings>): Promise<PoolSettings> {
    this.settings = { ...this.settings, ...partial };
    return { ...this.settings };
  }
}

describe('handleProxyRequest 代理转发与故障转移', () => {
  it('遇到 429 限流时自动冷却当前 Key 并无缝切换到下一个可用 Key，同时记录客户端密钥用量', async () => {
    const repo = new MemoryPoolRepository();
    const k1 = repo.seedKey({ name: 'mistral 1', api_key: 'sk-1', month_remaining_tokens: 900_000 });
    const k2 = repo.seedKey({ name: 'mistral 2', api_key: 'sk-2', month_remaining_tokens: 800_000 });
    const ck = await repo.createClientKey({
      name: 'iPhone 客户端',
      key_prefix: 'mp-sk-test••••1234',
      key_hash: 'hash-iphone',
    });

    const calls: string[] = [];
    const pendingTasks: Promise<unknown>[] = [];

    const mockFetch: typeof fetch = async (_url, init) => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      calls.push(auth);
      if (auth === 'Bearer sk-1') {
        return new Response(JSON.stringify({ message: 'Rate limited' }), {
          status: 429,
          headers: { 'retry-after': '30', 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit-tokens-month': '1000000',
            'x-ratelimit-remaining-tokens-month': '799985',
          },
        },
      );
    };

    const req = new Request('https://example.workers.dev/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const resp = await handleProxyRequest({
      request: req,
      upstreamBaseUrl: 'https://api.mistral.ai',
      repo,
      waitUntil: (p) => pendingTasks.push(p),
      clientKey: { id: ck.id, name: ck.name },
      fetchImpl: mockFetch,
    });

    await Promise.all(pendingTasks);

    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-mistral-pool-key')).toBe('mistral 2');
    expect(resp.headers.get('x-mistral-pool-attempts')).toBe('2');
    expect(calls).toEqual(['Bearer sk-1', 'Bearer sk-2']);

    const updatedK1 = await repo.getKeyById(k1.id);
    const updatedK2 = await repo.getKeyById(k2.id);
    const updatedCk = await repo.getClientKeyById(ck.id);
    expect(updatedK1?.status).toBe('cooldown');
    expect(updatedK1?.cooldown_until).not.toBeNull();
    expect(updatedK2?.month_remaining_tokens).toBe(799_985);
    expect(updatedK2?.total_prompt_tokens).toBe(10);
    expect(updatedCk?.total_requests).toBe(1);
    expect(updatedCk?.total_tokens).toBe(15);
    expect(updatedCk?.last_used_at).not.toBeNull();
    expect(repo.logs[0]?.attempts).toBe(2);
    expect(repo.logs[0]?.client_key_name).toBe('iPhone 客户端');
  });

  it('遇到 401 标记当前 Key 为失效并切下一个；遇到 400 直接透传不切号', async () => {
    const repo = new MemoryPoolRepository();
    const k1 = repo.seedKey({ name: 'mistral 1', api_key: 'sk-bad', month_remaining_tokens: 900_000 });
    const k2 = repo.seedKey({ name: 'mistral 2', api_key: 'sk-good', month_remaining_tokens: 800_000 });

    const pending: Promise<unknown>[] = [];
    const mockFetch: typeof fetch = async (_url, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer sk-bad') {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
      }
      return new Response(JSON.stringify({ message: 'Invalid model' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    };

    const req = new Request('https://example.workers.dev/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'non-existent', messages: [] }),
    });

    const resp = await handleProxyRequest({
      request: req,
      upstreamBaseUrl: 'https://api.mistral.ai',
      repo,
      waitUntil: (p) => pending.push(p),
      fetchImpl: mockFetch,
    });

    await Promise.all(pending);

    expect(resp.status).toBe(400);
    expect((await repo.getKeyById(k1.id))?.status).toBe('invalid');
    expect((await repo.getKeyById(k2.id))?.status).toBe('healthy');
  });

  it('SSE 流式透传并异步记录末尾 chunk 的 usage 与限额响应头', async () => {
    const repo = new MemoryPoolRepository();
    const k1 = repo.seedKey({ name: 'mistral 1', api_key: 'sk-stream', month_remaining_tokens: 500_000 });
    const pending: Promise<unknown>[] = [];

    const encoder = new TextEncoder();
    const mockFetch: typeof fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":30,"total_tokens":50}}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-ratelimit-remaining-tokens-month': '499950',
        },
      });
    };

    const req = new Request('https://example.workers.dev/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-small-latest', stream: true, messages: [] }),
    });

    const resp = await handleProxyRequest({
      request: req,
      upstreamBaseUrl: 'https://api.mistral.ai',
      repo,
      waitUntil: (p) => pending.push(p),
      fetchImpl: mockFetch,
    });

    const text = await resp.text();
    await Promise.all(pending);

    expect(resp.status).toBe(200);
    expect(text).toContain('data: [DONE]');
    const updated = await repo.getKeyById(k1.id);
    expect(updated?.month_remaining_tokens).toBe(499_950);
    expect(updated?.total_completion_tokens).toBe(30);
    expect(repo.logs[0]?.total_tokens).toBe(50);
  });

  it('probeSingleKey 能刷新真实月度剩余额度与延迟且不污染业务日志', async () => {
    const repo = new MemoryPoolRepository();
    const k1 = repo.seedKey({
      name: 'mistral 1',
      api_key: 'sk-probe',
      status: 'unknown',
      month_remaining_tokens: null,
    });

    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'H' } }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit-tokens-month': '1000000000',
            'x-ratelimit-remaining-tokens-month': '999999995',
            'x-ratelimit-limit-tokens-minute': '500000',
            'x-ratelimit-remaining-tokens-minute': '499995',
          },
        },
      );

    const res = await probeSingleKey(repo, k1, 'mistral-small-latest', 'https://api.mistral.ai', mockFetch);
    expect(res.ok).toBe(true);
    const updated = await repo.getKeyById(k1.id);
    expect(updated?.status).toBe('healthy');
    expect(updated?.month_limit_tokens).toBe(1_000_000_000);
    expect(updated?.month_remaining_tokens).toBe(999_999_995);
    expect(updated?.latency_ms).not.toBeNull();
    expect(repo.logs.length).toBe(0);
  });
});
