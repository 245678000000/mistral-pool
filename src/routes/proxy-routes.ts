import { Hono } from 'hono';
import { D1PoolRepository } from '../db/repository';
import { extractProxyToken, hashClientKey, verifyBearerToken } from '../lib/auth';
import { handleProxyRequest, type ClientKeyContext } from '../lib/proxy';
import type { Env } from '../types';

const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai';

/** 为代理响应统一附加 CORS 头，兼容各类桌面、手机及网页端 AI 客户端 */
function withCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set(
    'access-control-allow-headers',
    'Authorization, Content-Type, X-API-Key, X-Mistral-Key-Id, Accept',
  );
  headers.set(
    'access-control-expose-headers',
    'x-mistral-pool-key, x-mistral-pool-attempts, x-ratelimit-remaining-tokens-month, x-ratelimit-limit-tokens-month',
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createProxyRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // 处理浏览器客户端 CORS 预检请求
  app.options('/*', () =>
    withCorsHeaders(
      new Response(null, {
        status: 204,
      }),
    ),
  );

  // 透传所有 /v1/* 请求（chat/completions, models, embeddings 等）
  app.all('/*', async (c) => {
    const authHeader = c.req.header('authorization');
    const apiKeyHeader = c.req.header('x-api-key');
    const rawToken = extractProxyToken(authHeader, apiKeyHeader);

    if (!rawToken) {
      return withCorsHeaders(
        c.json(
          {
            error: {
              message: '缺少网关访问密钥，请先在看板「网关 API Keys」中创建并填入客户端',
              type: 'authentication_error',
            },
          },
          401,
        ),
      );
    }

    const repo = new D1PoolRepository(c.env.DB);
    let clientKeyCtx: ClientKeyContext | undefined;

    // 优先校验数据库中通过看板创建的客户端访问密钥（按 SHA-256 哈希查询）
    const tokenHash = await hashClientKey(rawToken);
    const dbClientKey = await repo.findClientKeyByHash(tokenHash);
    if (dbClientKey) {
      if (dbClientKey.enabled !== 1) {
        return withCorsHeaders(
          c.json(
            {
              error: {
                message: '该网关访问密钥已被停用，请在看板中重新启用或更换密钥',
                type: 'authentication_error',
              },
            },
            401,
          ),
        );
      }
      clientKeyCtx = { id: dbClientKey.id, name: dbClientKey.name };
    } else {
      // 向下兼容环境变量 PROXY_API_KEY
      const envOk = await verifyBearerToken(authHeader, apiKeyHeader, c.env.PROXY_API_KEY);
      if (!envOk) {
        return withCorsHeaders(
          c.json(
            {
              error: {
                message: '网关访问密钥无效，请检查客户端配置的 API Key 或在看板重新创建',
                type: 'authentication_error',
              },
            },
            401,
          ),
        );
      }
      clientKeyCtx = { id: null, name: '环境变量密钥' };
    }

    const rawPinnedId = c.req.header('x-mistral-key-id');
    const pinnedKeyId =
      rawPinnedId && /^\d+$/.test(rawPinnedId.trim()) ? Number.parseInt(rawPinnedId.trim(), 10) : undefined;

    const upstreamBaseUrl = c.env.MISTRAL_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL;

    const response = await handleProxyRequest({
      request: c.req.raw,
      upstreamBaseUrl,
      repo,
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      pinnedKeyId,
      clientKey: clientKeyCtx,
    });

    return withCorsHeaders(response);
  });

  return app;
}
