// 前端与 /admin/api/* 交互的类型定义

export type KeyStatus = 'unknown' | 'healthy' | 'cooldown' | 'exhausted' | 'invalid';
export type RoutingStrategy = 'remaining_first' | 'round_robin' | 'sequential';

export interface MaskedApiKey {
  id: number;
  name: string;
  masked_key: string;
  enabled: boolean;
  priority: number;
  status: KeyStatus;
  cooldown_until: number | null;
  latency_ms: number | null;
  month_limit_tokens: number | null;
  month_remaining_tokens: number | null;
  minute_limit_tokens: number | null;
  minute_remaining_tokens: number | null;
  minute_limit_req: number | null;
  minute_remaining_req: number | null;
  raw_rate_headers: Record<string, string> | null;
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  custom_note: string;
  last_checked_at: number | null;
  last_used_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ClientKeyView {
  id: number;
  name: string;
  key_prefix: string;
  enabled: boolean;
  total_requests: number;
  total_tokens: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PoolSettings {
  routing_strategy: RoutingStrategy;
  probe_model: string;
}

export interface DashboardSummary {
  totalKeys: number;
  enabledKeys: number;
  availableKeys: number;
  totalClientKeys: number;
  enabledClientKeys: number;
  keysWithMonthQuota: number;
  totalMonthLimit: number;
  totalMonthRemaining: number;
  totalAllTimeRequests: number;
  totalAllTimeTokens: number;
  today: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface DashboardPayload {
  serverTime: number;
  proxyBaseUrl: string;
  hasEnvProxyKey: boolean;
  summary: DashboardSummary;
  settings: PoolSettings;
  keys: MaskedApiKey[];
  clientKeys: ClientKeyView[];
}

export interface RequestLogRecord {
  id: number;
  key_id: number | null;
  key_name: string | null;
  client_key_name: string | null;
  endpoint: string;
  model: string | null;
  is_stream: number;
  status_code: number;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  attempts: number;
  error_summary: string | null;
  created_at: number;
}

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

export interface PlaygroundResult {
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  matchedKeyName: string | null;
  attempts: number;
  reply?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  error?: string;
}
