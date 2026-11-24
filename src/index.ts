import { Hono } from 'hono';
import { createAdminRoutes } from './routes/admin-routes';
import { createProxyRoutes } from './routes/proxy-routes';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// 健康检查端点（不暴露任何内部配置）
app.get('/health', (c) => c.json({ status: 'ok', service: 'mistral-pool' }));

// 聚合代理网关路由（/v1/*）
app.route('/v1', createProxyRoutes());

// 管理看板后端接口（/admin/api/*）
app.route('/admin/api', createAdminRoutes());

// 其余路径交由 Cloudflare Workers Static Assets 提供静态前端与 SPA 回退
app.all('*', (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('Not Found', 404);
});

export default app;
