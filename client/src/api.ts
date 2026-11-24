import type {
  ClientKeyView,
  DashboardPayload,
  MaskedApiKey,
  PlaygroundResult,
  PoolSettings,
  ProbeResult,
  RequestLogRecord,
  RoutingStrategy,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const data = (await resp.json().catch(() => ({}))) as { error?: string } & T;
  if (!resp.ok) {
    throw new ApiError(resp.status, data.error || `请求失败（HTTP ${resp.status}）`);
  }
  return data;
}

export const adminApi = {
  getSession: () => requestJson<{ authenticated: boolean; configured: boolean }>('/admin/api/session'),
  login: (password: string) =>
    requestJson<{ ok: boolean }>('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => requestJson<{ ok: boolean }>('/admin/api/logout', { method: 'POST' }),
  getDashboard: () => requestJson<DashboardPayload>('/admin/api/dashboard'),
  createKey: (payload: { name: string; api_key: string; custom_note?: string; priority?: number }) =>
    requestJson<{ key: MaskedApiKey }>('/admin/api/keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createKeysBatch: (raw_text: string, auto_probe: boolean) =>
    requestJson<{ created: number; skipped: number; probeResults: ProbeResult[] | null; keys: MaskedApiKey[] }>(
      '/admin/api/keys/batch',
      {
        method: 'POST',
        body: JSON.stringify({ raw_text, auto_probe }),
      },
    ),
  updateKey: (
    id: number,
    payload: {
      name?: string;
      enabled?: boolean;
      priority?: number;
      custom_note?: string;
      reset_status?: boolean;
    },
  ) =>
    requestJson<{ key: MaskedApiKey }>(`/admin/api/keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteKey: (id: number) =>
    requestJson<{ ok: boolean }>(`/admin/api/keys/${id}`, {
      method: 'DELETE',
    }),
  probeKey: (id: number) =>
    requestJson<{ result: ProbeResult; key: MaskedApiKey | null }>(`/admin/api/keys/${id}/probe`, {
      method: 'POST',
    }),
  probeAll: () =>
    requestJson<{ results: ProbeResult[]; keys: MaskedApiKey[] }>('/admin/api/keys/probe-all', {
      method: 'POST',
    }),
  createClientKey: (name: string) =>
    requestJson<{ clientKey: ClientKeyView; plaintextKey: string }>('/admin/api/client-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateClientKey: (id: number, payload: { name?: string; enabled?: boolean }) =>
    requestJson<{ clientKey: ClientKeyView }>(`/admin/api/client-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteClientKey: (id: number) =>
    requestJson<{ ok: boolean }>(`/admin/api/client-keys/${id}`, {
      method: 'DELETE',
    }),
  updateSettings: (payload: { routing_strategy?: RoutingStrategy; probe_model?: string }) =>
    requestJson<{ settings: PoolSettings }>('/admin/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getLogs: (limit = 80) => requestJson<{ logs: RequestLogRecord[] }>(`/admin/api/logs?limit=${limit}`),
  runPlayground: (payload: { message: string; model: string; key_id: number | null }) =>
    requestJson<PlaygroundResult>('/admin/api/playground', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

/** 简洁格式化大额 Token 数值（如 1.00B / 982.4M / 45.2K） */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** 格式化相对时间（如 刚刚 / 3 分钟前 / 2 小时前） */
export function formatRelativeTime(ts: number | null, now: number): string {
  if (!ts) return '从未';
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 15) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

/** 格式化完整本地时分秒（用于调用流水表） */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export const STRATEGY_LABELS: Record<RoutingStrategy, { label: string; desc: string }> = {
  remaining_first: { label: '剩余额度优先', desc: '优先用本月剩余 Token 最多的账号' },
  round_robin: { label: '均匀轮询', desc: '按最久未使用顺序轮流分摊流量' },
  sequential: { label: '顺序用完再切', desc: '按优先级依次消耗，限流或耗尽自动切下一个' },
};
