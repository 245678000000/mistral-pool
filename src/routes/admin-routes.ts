import { Hono } from 'hono';
import { D1PoolRepository } from '../db/repository';
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  formatClientKeyPrefix,
  generateClientApiKey,
  hashClientKey,
  maskApiKey,
  readCookie,
  resolveSessionSecret,
  verifyAdminPassword,
  verifySessionToken,
} from '../lib/auth';
import { probeAllEnabledKeys, probeSingleKey } from '../lib/probe';
import { handleProxyRequest } from '../lib/proxy';
import { isKeyEligible } from '../lib/scheduler';
import type { ApiKeyRecord, ClientKeyRecord, ClientKeyView, Env, MaskedApiKey, RoutingStrategy } from '../types';

const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai';

/** 将数据库中的完整上游 Key 记录转为前端安全的脱敏对象 */
function toMaskedKey(record: ApiKeyRecord): MaskedApiKey {
  let rawHeaders: Record<string, string> | null = null;
  if (record.raw_rate_headers) {
    try {
      rawHeaders = JSON.parse(record.raw_rate_headers) as Record<string, string>;
    } catch {
      rawHeaders = null;
    }
  }

  const { api_key, enabled, raw_rate_headers: _raw, ...rest } = record;
  return {
    ...rest,
    masked_key: maskApiKey(api_key),
    enabled: enabled === 1,
    raw_rate_headers: rawHeaders,
  };
}

/** 将数据库中的客户端网关密钥记录转为前端安全视图（剔除 key_hash） */
function toClientKeyView(record: ClientKeyRecord): ClientKeyView {
  const { key_hash: _hash, enabled, ...rest } = record;
  return {
    ...rest,
    enabled: enabled === 1,
  };
}

/** 解析多行批量导入文本，支持 `名称,Key`、`名称: Key`、`名称 Key` 或纯 `Key` 格式 */
function parseBatchText(text: string, existingCount: number): Array<{ name: string; api_key: string }> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const parsed: Array<{ name: string; api_key: string }> = [];
  let seq = existingCount + 1;

  for (const line of lines) {
    const sepMatch = line.match(/^([^,，=:\t]+)[,，=:\t]+\s*(\S+)$/);
    if (sepMatch) {
      parsed.push({ name: sepMatch[1].trim(), api_key: sepMatch[2].trim() });
      seq += 1;
      continue;
    }

    const spaceParts = line.split(/\s+/);
    if (spaceParts.length >= 2) {
      const apiKey = spaceParts[spaceParts.length - 1].trim();
      const name = spaceParts.slice(0, -1).join(' ').trim();
      parsed.push({ name: name || `mistral ${seq}`, api_key: apiKey });
      seq += 1;
      continue;
    }

    parsed.push({ name: `mistral ${seq}`, api_key: line });
    seq += 1;
  }

  return parsed;
}

/** 构造 Set-Cookie 头字符串 */
function buildSessionCookie(token: string, requestUrl: string, maxAgeSeconds: number): string {
  const isHttps = requestUrl.startsWith('https://');
  const secureFlag = isHttps ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

export function createAdminRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // 1. 登录态查询（公开）
  app.get('/session', async (c) => {
    if (!c.env.ADMIN_PASSWORD) {
      return c.json({ authenticated: false, configured: false });
    }
    const secret = resolveSessionSecret(c.env.SESSION_SECRET, c.env.ADMIN_PASSWORD);
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME);
    const authenticated = await verifySessionToken(token, secret);
    return c.json({ authenticated, configured: true });
  });

  // 2. 管理员密码登录（公开）
  app.post('/login', async (c) => {
    if (!c.env.ADMIN_PASSWORD) {
      return c.json({ error: '服务端尚未配置 ADMIN_PASSWORD 环境变量' }, 500);
    }

    const body = (await c.req.json().catch(() => ({}))) as { password?: string };
    const password = typeof body.password === 'string' ? body.password : '';

    const ok = await verifyAdminPassword(password, c.env.ADMIN_PASSWORD);
    if (!ok) {
      return c.json({ error: '管理员密码不正确，请重试' }, 401);
    }

    const secret = resolveSessionSecret(c.env.SESSION_SECRET, c.env.ADMIN_PASSWORD);
    const ttlSeconds = 7 * 24 * 60 * 60;
    const token = await createSessionToken(secret, ttlSeconds);

    c.header('set-cookie', buildSessionCookie(token, c.req.url, ttlSeconds));
    return c.json({ ok: true });
  });

  // 3. 退出登录（公开）
  app.post('/logout', (c) => {
    c.header('set-cookie', buildSessionCookie('', c.req.url, 0));
    return c.json({ ok: true });
  });

  // 4. 以下所有管理接口强制校验登录会话 Cookie
  app.use('/*', async (c, next) => {
    if (!c.env.ADMIN_PASSWORD) {
      return c.json({ error: '服务端未配置 ADMIN_PASSWORD' }, 500);
    }
    const secret = resolveSessionSecret(c.env.SESSION_SECRET, c.env.ADMIN_PASSWORD);
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME);
    const authenticated = await verifySessionToken(token, secret);
    if (!authenticated) {
      return c.json({ error: '未登录或会话已过期，请重新登录' }, 401);
    }
    return next();
  });

  // 5. 看板聚合总览
  app.get('/dashboard', async (c) => {
    const repo = new D1PoolRepository(c.env.DB);
    const now = Date.now();
    const [keys, clientKeys, settings, todayStats] = await Promise.all([
      repo.listKeys(),
      repo.listClientKeys(),
      repo.getSettings(),
      repo.getTodayStats(now),
    ]);

    const availableKeys = keys.filter((k) => isKeyEligible(k, now)).length;
    const enabledKeys = keys.filter((k) => k.enabled === 1).length;
    const enabledClientKeys = clientKeys.filter((k) => k.enabled === 1).length;

    let totalMonthLimit = 0;
    let totalMonthRemaining = 0;
    let keysWithMonthQuota = 0;
    let totalAllTimeRequests = 0;
    let totalAllTimeTokens = 0;

    for (const k of keys) {
      totalAllTimeRequests += k.total_requests;
      totalAllTimeTokens += k.total_prompt_tokens + k.total_completion_tokens;
      if (k.enabled === 1 && k.month_remaining_tokens !== null) {
        keysWithMonthQuota += 1;
        totalMonthRemaining += k.month_remaining_tokens;
        if (k.month_limit_tokens !== null) {
          totalMonthLimit += k.month_limit_tokens;
        }
      }
    }

    const reqUrlObj = new URL(c.req.url);
    const isLocalHost = reqUrlObj.hostname === '127.0.0.1' || reqUrlObj.hostname === 'localhost';
    const proto = isLocalHost ? reqUrlObj.protocol : 'https:';
    const proxyBaseUrl = `${proto}//${reqUrlObj.host}/v1`;

    return c.json({
      serverTime: now,
      proxyBaseUrl,
      hasEnvProxyKey: Boolean(c.env.PROXY_API_KEY?.trim()),
      summary: {
        totalKeys: keys.length,
        enabledKeys,
        availableKeys,
        totalClientKeys: clientKeys.length,
        enabledClientKeys,
        keysWithMonthQuota,
        totalMonthLimit,
        totalMonthRemaining,
        totalAllTimeRequests,
        totalAllTimeTokens,
        today: todayStats,
      },
      settings,
      keys: keys.map(toMaskedKey),
      clientKeys: clientKeys.map(toClientKeyView),
    });
  });

  // 6. 添加单个上游 Mistral Key
  app.post('/keys', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      api_key?: string;
      priority?: number;
      custom_note?: string;
    };

    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (!apiKey) {
      return c.json({ error: 'API Key 不能为空' }, 400);
    }

    const repo = new D1PoolRepository(c.env.DB);
    const existing = await repo.listKeys();
    const finalName = name || `mistral ${existing.length + 1}`;

    try {
      const created = await repo.createKey({
        name: finalName,
        api_key: apiKey,
        priority: typeof body.priority === 'number' ? body.priority : existing.length + 1,
        custom_note: typeof body.custom_note === 'string' ? body.custom_note : '',
      });
      return c.json({ key: toMaskedKey(created) }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('unique')) {
        return c.json({ error: '该 API Key 已存在于号池中，请勿重复添加' }, 409);
      }
      return c.json({ error: `添加失败：${msg || '未知错误'}` }, 500);
    }
  });

  // 7. 批量导入多行上游 Key
  app.post('/keys/batch', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      raw_text?: string;
      auto_probe?: boolean;
    };
    const rawText = typeof body.raw_text === 'string' ? body.raw_text : '';
    if (!rawText.trim()) {
      return c.json({ error: '请至少粘贴一个 API Key' }, 400);
    }

    const repo = new D1PoolRepository(c.env.DB);
    const existing = await repo.listKeys();
    const items = parseBatchText(rawText, existing.length).map((item, idx) => ({
      ...item,
      priority: existing.length + idx + 1,
    }));

    if (items.length === 0) {
      return c.json({ error: '未能识别到有效的 API Key 行' }, 400);
    }

    const result = await repo.createKeysBatch(items);

    let probeResults = null;
    if (body.auto_probe && result.created > 0) {
      const settings = await repo.getSettings();
      const upstreamBaseUrl = c.env.MISTRAL_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL;
      probeResults = await probeAllEnabledKeys(repo, settings.probe_model, upstreamBaseUrl);
    }

    const keys = await repo.listKeys();
    return c.json({
      created: result.created,
      skipped: result.skipped,
      probeResults,
      keys: keys.map(toMaskedKey),
    });
  });

  // 8. 更新单个上游 Key
  app.patch('/keys/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isSafeInteger(id)) {
      return c.json({ error: '无效的 Key ID' }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      enabled?: boolean;
      priority?: number;
      custom_note?: string;
      reset_status?: boolean;
    };

    const repo = new D1PoolRepository(c.env.DB);
    const updated = await repo.updateKey(id, {
      name: typeof body.name === 'string' && body.name.trim() ? body.name : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      priority: typeof body.priority === 'number' ? body.priority : undefined,
      custom_note: typeof body.custom_note === 'string' ? body.custom_note : undefined,
      reset_status: body.reset_status === true,
    });

    if (!updated) {
      return c.json({ error: '未找到对应的 API Key' }, 404);
    }
    return c.json({ key: toMaskedKey(updated) });
  });

  // 9. 删除上游 Key
  app.delete('/keys/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isSafeInteger(id)) {
      return c.json({ error: '无效的 Key ID' }, 400);
    }
    const repo = new D1PoolRepository(c.env.DB);
    const deleted = await repo.deleteKey(id);
    if (!deleted) {
      return c.json({ error: '未找到对应的 API Key' }, 404);
    }
    return c.json({ ok: true });
  });

  // 10. 单个上游 Key 测活刷新剩余额度
  app.post('/keys/:id/probe', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isSafeInteger(id)) {
      return c.json({ error: '无效的 Key ID' }, 400);
    }
    const repo = new D1PoolRepository(c.env.DB);
    const key = await repo.getKeyById(id);
    if (!key) {
      return c.json({ error: '未找到对应的 API Key' }, 404);
    }
    const settings = await repo.getSettings();
    const upstreamBaseUrl = c.env.MISTRAL_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL;
    const result = await probeSingleKey(repo, key, settings.probe_model, upstreamBaseUrl);
    const refreshed = await repo.getKeyById(id);
    return c.json({ result, key: refreshed ? toMaskedKey(refreshed) : null });
  });

  // 11. 并发测活全部启用 Key
  app.post('/keys/probe-all', async (c) => {
    const repo = new D1PoolRepository(c.env.DB);
    const settings = await repo.getSettings();
    const upstreamBaseUrl = c.env.MISTRAL_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL;
    const results = await probeAllEnabledKeys(repo, settings.probe_model, upstreamBaseUrl);
    const keys = await repo.listKeys();
    return c.json({ results, keys: keys.map(toMaskedKey) });
  });

  // 12. 列出全部网关访问密钥（供外部客户端连接 /v1/* 使用）
  app.get('/client-keys', async (c) => {
    const repo = new D1PoolRepository(c.env.DB);
    const list = await repo.listClientKeys();
    return c.json({ clientKeys: list.map(toClientKeyView) });
  });

  // 13. 创建新的网关访问密钥（仅创建瞬间返回一次明文，库内只存 SHA-256 哈希）
  app.post('/client-keys', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';

    const repo = new D1PoolRepository(c.env.DB);
    const existing = await repo.listClientKeys();
    const name = rawName || `客户端密钥 ${existing.length + 1}`;

    const plaintextKey = generateClientApiKey();
    const keyHash = await hashClientKey(plaintextKey);
    const keyPrefix = formatClientKeyPrefix(plaintextKey);

    const created = await repo.createClientKey({
      name,
      key_prefix: keyPrefix,
      key_hash: keyHash,
    });

    return c.json(
      {
        clientKey: toClientKeyView(created),
        plaintextKey,
      },
      201,
    );
  });

  // 14. 修改网关访问密钥名称或启用状态
  app.patch('/client-keys/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isSafeInteger(id)) {
      return c.json({ error: '无效的密钥 ID' }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as { name?: string; enabled?: boolean };
    const repo = new D1PoolRepository(c.env.DB);
    const updated = await repo.updateClientKey(id, {
      name: typeof body.name === 'string' && body.name.trim() ? body.name : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });

    if (!updated) {
      return c.json({ error: '未找到对应的网关访问密钥' }, 404);
    }
    return c.json({ clientKey: toClientKeyView(updated) });
  });

  // 15. 删除/吊销网关访问密钥
  app.delete('/client-keys/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isSafeInteger(id)) {
      return c.json({ error: '无效的密钥 ID' }, 400);
    }
    const repo = new D1PoolRepository(c.env.DB);
    const deleted = await repo.deleteClientKey(id);
    if (!deleted) {
      return c.json({ error: '未找到对应的网关访问密钥' }, 404);
    }
    return c.json({ ok: true });
  });

  // 16. 修改全局调度策略与探针模型
  app.patch('/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      routing_strategy?: RoutingStrategy;
      probe_model?: string;
    };

    const validStrategies: RoutingStrategy[] = ['remaining_first', 'round_robin', 'sequential'];
    if (body.routing_strategy && !validStrategies.includes(body.routing_strategy)) {
      return c.json({ error: '不支持的调度策略' }, 400);
    }

    const repo = new D1PoolRepository(c.env.DB);
    const settings = await repo.updateSettings({
      routing_strategy: body.routing_strategy,
      probe_model: typeof body.probe_model === 'string' ? body.probe_model.trim() : undefined,
    });
    return c.json({ settings });
  });

  // 17. 查询近期调用流水
  app.get('/logs', async (c) => {
    const rawLimit = c.req.query('limit');
    const limit = rawLimit && /^\d+$/.test(rawLimit) ? Number.parseInt(rawLimit, 10) : 100;
    const repo = new D1PoolRepository(c.env.DB);
    const logs = await repo.listLogs(limit);
    return c.json({ logs });
  });

  // 18. 在线快速测试对话
  app.post('/playground', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      model?: string;
      key_id?: number | null;
    };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'mistral-small-latest';

    if (!message) {
      return c.json({ error: '请输入测试消息内容' }, 400);
    }

    const repo = new D1PoolRepository(c.env.DB);
    const upstreamBaseUrl = c.env.MISTRAL_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL;
    const startedAt = Date.now();
    const pending: Promise<unknown>[] = [];

    const syntheticRequest = new Request(`${new URL(c.req.url).origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: message }],
        max_tokens: 256,
      }),
    });

    const resp = await handleProxyRequest({
      request: syntheticRequest,
      upstreamBaseUrl,
      repo,
      waitUntil: (p) => pending.push(p),
      pinnedKeyId: typeof body.key_id === 'number' ? body.key_id : undefined,
      clientKey: { id: null, name: '看板测试' },
    });

    const latencyMs = Math.max(1, Date.now() - startedAt);
    const rawKeyHeader = resp.headers.get('x-mistral-pool-key');
    const matchedKeyName = rawKeyHeader ? decodeURIComponent(rawKeyHeader) : null;
    const attempts = Number.parseInt(resp.headers.get('x-mistral-pool-attempts') ?? '1', 10) || 1;
    const payload = (await resp.json().catch(() => null)) as Record<string, unknown> | null;

    await Promise.allSettled(pending);

    if (!resp.ok) {
      const errObj = payload?.error as { message?: string } | undefined;
      const errMsg = errObj?.message || (payload?.message as string | undefined) || `上游返回 HTTP ${resp.status}`;
      return c.json(
        {
          ok: false,
          statusCode: resp.status,
          latencyMs,
          matchedKeyName,
          attempts,
          error: errMsg,
        },
        200,
      );
    }

    const choices = payload?.choices as Array<{ message?: { content?: string } }> | undefined;
    const reply = choices?.[0]?.message?.content ?? '';
    const usage = payload?.usage ?? null;

    return c.json({
      ok: true,
      statusCode: resp.status,
      latencyMs,
      matchedKeyName,
      attempts,
      reply,
      usage,
    });
  });

  return app;
}
