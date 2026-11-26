import type {
  ApiKeyRecord,
  ClientKeyRecord,
  PoolSettings,
  RateLimitInfo,
  RequestLogRecord,
  RoutingStrategy,
  TodayStats,
  UsageInfo,
} from '../types';

export interface CreateKeyInput {
  name: string;
  api_key: string;
  priority?: number;
  custom_note?: string;
}

export interface UpdateKeyInput {
  name?: string;
  enabled?: boolean;
  priority?: number;
  custom_note?: string;
  reset_status?: boolean;
}

export interface CreateClientKeyInput {
  name: string;
  key_prefix: string;
  key_hash: string;
}

export interface UpdateClientKeyInput {
  name?: string;
  enabled?: boolean;
}

/** 号池数据仓储抽象接口（方便 D1 生产实现与内存单测实现解耦） */
export interface PoolRepository {
  listKeys(): Promise<ApiKeyRecord[]>;
  getKeyById(id: number): Promise<ApiKeyRecord | null>;
  createKey(input: CreateKeyInput): Promise<ApiKeyRecord>;
  createKeysBatch(items: CreateKeyInput[]): Promise<{ created: number; skipped: number }>;
  updateKey(id: number, input: UpdateKeyInput): Promise<ApiKeyRecord | null>;
  deleteKey(id: number): Promise<boolean>;
  recordSuccess(
    keyId: number,
    rateLimit: RateLimitInfo,
    usage: UsageInfo,
    latencyMs: number,
    now: number,
    options?: { countAsRequest?: boolean },
  ): Promise<void>;
  recordFailure(
    keyId: number,
    status: 'cooldown' | 'exhausted' | 'invalid',
    cooldownUntil: number | null,
    errorMessage: string,
    rateLimit: RateLimitInfo | null,
    now: number,
  ): Promise<void>;
  listClientKeys(): Promise<ClientKeyRecord[]>;
  getClientKeyById(id: number): Promise<ClientKeyRecord | null>;
  findClientKeyByHash(keyHash: string): Promise<ClientKeyRecord | null>;
  createClientKey(input: CreateClientKeyInput): Promise<ClientKeyRecord>;
  updateClientKey(id: number, input: UpdateClientKeyInput): Promise<ClientKeyRecord | null>;
  deleteClientKey(id: number): Promise<boolean>;
  recordClientKeyUsage(id: number, tokens: number, now: number): Promise<void>;
  insertLogAndPrune(entry: Omit<RequestLogRecord, 'id'>): Promise<void>;
  listLogs(limit?: number): Promise<RequestLogRecord[]>;
  getTodayStats(now?: number): Promise<TodayStats>;
  getSettings(): Promise<PoolSettings>;
  updateSettings(partial: Partial<PoolSettings>): Promise<PoolSettings>;
}

const DEFAULT_SETTINGS: PoolSettings = {
  routing_strategy: 'remaining_first',
  probe_model: 'mistral-small-latest',
};

const MAX_RETAINED_LOGS = 500;
// 每 25 次日志写入才按主键范围裁剪一次旧记录，将单次日志清理的行读开销从 ~1000 行降至均摊 ~1 行
const LOG_PRUNE_INTERVAL = 25;
// Worker 进程内 settings 缓存有效期（60 秒），避免每次代理请求都重复读取 settings 表
const SETTINGS_CACHE_TTL_MS = 60_000;

let cachedSettings: { value: PoolSettings; expiresAt: number } | null = null;

/** 供测试或配置变更后清空进程内设置缓存 */
export function clearSettingsCache(): void {
  cachedSettings = null;
}

/** 计算给定时间戳对应的北京时间自然日键（YYYY-MM-DD） */
export function getBeijingDayKey(now = Date.now()): string {
  const tzOffsetMs = 8 * 60 * 60 * 1000;
  const shifted = new Date(now + tzOffsetMs);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 判断 SQLite / D1 错误是否为表尚未创建 */
function isMissingDailyStatsTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes('no such table') && msg.toLowerCase().includes('daily_stats');
}

const CREATE_DAILY_STATS_SQL = `CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`;

/** 基于 Cloudflare D1 的持久化仓储实现 */
export class D1PoolRepository implements PoolRepository {
  constructor(private readonly db: D1Database) {}

  private async ensureDailyStatsTable(): Promise<void> {
    await this.db.prepare(CREATE_DAILY_STATS_SQL).run();
  }

  async listKeys(): Promise<ApiKeyRecord[]> {
    const result = await this.db
      .prepare('SELECT * FROM api_keys ORDER BY priority ASC, id ASC')
      .all<ApiKeyRecord>();
    return result.results ?? [];
  }

  async getKeyById(id: number): Promise<ApiKeyRecord | null> {
    const row = await this.db.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first<ApiKeyRecord>();
    return row ?? null;
  }

  async createKey(input: CreateKeyInput): Promise<ApiKeyRecord> {
    const now = Date.now();
    const priority = input.priority ?? 0;
    const customNote = input.custom_note?.trim() ?? '';

    const result = await this.db
      .prepare(
        `INSERT INTO api_keys (name, api_key, enabled, priority, status, custom_note, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'unknown', ?, ?, ?)`,
      )
      .bind(input.name.trim(), input.api_key.trim(), priority, customNote, now, now)
      .run();

    const insertedId = Number(result.meta.last_row_id);
    const created = await this.getKeyById(insertedId);
    if (!created) {
      throw new Error('创建 API Key 后回查失败');
    }
    return created;
  }

  async createKeysBatch(items: CreateKeyInput[]): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;
    const now = Date.now();

    for (const item of items) {
      const cleanKey = item.api_key.trim();
      if (!cleanKey) {
        skipped += 1;
        continue;
      }
      const cleanName = item.name.trim() || `mistral-${created + 1}`;
      const res = await this.db
        .prepare(
          `INSERT OR IGNORE INTO api_keys (name, api_key, enabled, priority, status, custom_note, created_at, updated_at)
           VALUES (?, ?, 1, ?, 'unknown', ?, ?, ?)`,
        )
        .bind(cleanName, cleanKey, item.priority ?? 0, item.custom_note?.trim() ?? '', now, now)
        .run();

      if ((res.meta.changes ?? 0) > 0) {
        created += 1;
      } else {
        skipped += 1;
      }
    }

    return { created, skipped };
  }

  async updateKey(id: number, input: UpdateKeyInput): Promise<ApiKeyRecord | null> {
    const existing = await this.getKeyById(id);
    if (!existing) return null;

    const now = Date.now();
    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    const nextEnabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
    const nextPriority = input.priority !== undefined ? input.priority : existing.priority;
    const nextNote = input.custom_note !== undefined ? input.custom_note.trim() : existing.custom_note;
    const nextStatus = input.reset_status ? 'unknown' : existing.status;
    const nextCooldown = input.reset_status ? null : existing.cooldown_until;
    const nextError = input.reset_status ? null : existing.last_error;

    await this.db
      .prepare(
        `UPDATE api_keys
         SET name = ?, enabled = ?, priority = ?, custom_note = ?,
             status = ?, cooldown_until = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(nextName, nextEnabled, nextPriority, nextNote, nextStatus, nextCooldown, nextError, now, id)
      .run();

    return this.getKeyById(id);
  }

  async deleteKey(id: number): Promise<boolean> {
    const res = await this.db.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async recordSuccess(
    keyId: number,
    rateLimit: RateLimitInfo,
    usage: UsageInfo,
    latencyMs: number,
    now: number,
    options?: { countAsRequest?: boolean },
  ): Promise<void> {
    const countAsRequest = options?.countAsRequest ?? true;
    const nextStatus = rateLimit.monthRemainingTokens === 0 ? 'exhausted' : 'healthy';
    const rawJson = Object.keys(rateLimit.rawHeaders).length > 0 ? JSON.stringify(rateLimit.rawHeaders) : null;

    // 使用 COALESCE 保留已有的月度/分钟额度，避免 /v1/models 等不含限额头的请求覆盖掉有效剩余额度
    await this.db
      .prepare(
        `UPDATE api_keys
         SET status = ?,
             cooldown_until = NULL,
             latency_ms = ?,
             month_limit_tokens = COALESCE(?, month_limit_tokens),
             month_remaining_tokens = COALESCE(?, month_remaining_tokens),
             minute_limit_tokens = COALESCE(?, minute_limit_tokens),
             minute_remaining_tokens = COALESCE(?, minute_remaining_tokens),
             minute_limit_req = COALESCE(?, minute_limit_req),
             minute_remaining_req = COALESCE(?, minute_remaining_req),
             raw_rate_headers = COALESCE(?, raw_rate_headers),
             total_requests = total_requests + ?,
             total_prompt_tokens = total_prompt_tokens + ?,
             total_completion_tokens = total_completion_tokens + ?,
             last_checked_at = ?,
             last_used_at = CASE WHEN ? = 1 THEN ? ELSE last_used_at END,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        nextStatus,
        latencyMs,
        rateLimit.monthLimitTokens,
        rateLimit.monthRemainingTokens,
        rateLimit.minuteLimitTokens,
        rateLimit.minuteRemainingTokens,
        rateLimit.minuteLimitReq,
        rateLimit.minuteRemainingReq,
        rawJson,
        countAsRequest ? 1 : 0,
        usage.promptTokens,
        usage.completionTokens,
        now,
        countAsRequest ? 1 : 0,
        now,
        now,
        keyId,
      )
      .run();
  }

  async recordFailure(
    keyId: number,
    status: 'cooldown' | 'exhausted' | 'invalid',
    cooldownUntil: number | null,
    errorMessage: string,
    rateLimit: RateLimitInfo | null,
    now: number,
  ): Promise<void> {
    const rawJson =
      rateLimit && Object.keys(rateLimit.rawHeaders).length > 0 ? JSON.stringify(rateLimit.rawHeaders) : null;

    await this.db
      .prepare(
        `UPDATE api_keys
         SET status = ?,
             cooldown_until = ?,
             month_limit_tokens = COALESCE(?, month_limit_tokens),
             month_remaining_tokens = COALESCE(?, month_remaining_tokens),
             minute_limit_tokens = COALESCE(?, minute_limit_tokens),
             minute_remaining_tokens = COALESCE(?, minute_remaining_tokens),
             minute_limit_req = COALESCE(?, minute_limit_req),
             minute_remaining_req = COALESCE(?, minute_remaining_req),
             raw_rate_headers = COALESCE(?, raw_rate_headers),
             last_checked_at = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        status,
        cooldownUntil,
        rateLimit?.monthLimitTokens ?? null,
        rateLimit?.monthRemainingTokens ?? null,
        rateLimit?.minuteLimitTokens ?? null,
        rateLimit?.minuteRemainingTokens ?? null,
        rateLimit?.minuteLimitReq ?? null,
        rateLimit?.minuteRemainingReq ?? null,
        rawJson,
        now,
        errorMessage.slice(0, 500),
        now,
        keyId,
      )
      .run();
  }

  async listClientKeys(): Promise<ClientKeyRecord[]> {
    const result = await this.db
      .prepare('SELECT * FROM client_keys ORDER BY id DESC')
      .all<ClientKeyRecord>();
    return result.results ?? [];
  }

  async getClientKeyById(id: number): Promise<ClientKeyRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM client_keys WHERE id = ?')
      .bind(id)
      .first<ClientKeyRecord>();
    return row ?? null;
  }

  async findClientKeyByHash(keyHash: string): Promise<ClientKeyRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM client_keys WHERE key_hash = ?')
      .bind(keyHash)
      .first<ClientKeyRecord>();
    return row ?? null;
  }

  async createClientKey(input: CreateClientKeyInput): Promise<ClientKeyRecord> {
    const now = Date.now();
    const res = await this.db
      .prepare(
        `INSERT INTO client_keys (name, key_prefix, key_hash, enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .bind(input.name.trim(), input.key_prefix, input.key_hash, now, now)
      .run();

    const id = Number(res.meta.last_row_id);
    const created = await this.getClientKeyById(id);
    if (!created) {
      throw new Error('创建网关访问密钥后回查失败');
    }
    return created;
  }

  async updateClientKey(id: number, input: UpdateClientKeyInput): Promise<ClientKeyRecord | null> {
    const existing = await this.getClientKeyById(id);
    if (!existing) return null;

    const now = Date.now();
    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    const nextEnabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;

    await this.db
      .prepare(
        `UPDATE client_keys
         SET name = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(nextName, nextEnabled, now, id)
      .run();

    return this.getClientKeyById(id);
  }

  async deleteClientKey(id: number): Promise<boolean> {
    const res = await this.db.prepare('DELETE FROM client_keys WHERE id = ?').bind(id).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async recordClientKeyUsage(id: number, tokens: number, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE client_keys
         SET total_requests = total_requests + 1,
             total_tokens = total_tokens + ?,
             last_used_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(tokens, now, now, id)
      .run();
  }

  async insertLogAndPrune(entry: Omit<RequestLogRecord, 'id'>): Promise<void> {
    const insertRes = await this.db
      .prepare(
        `INSERT INTO request_logs
           (key_id, key_name, client_key_name, endpoint, model, is_stream, status_code, latency_ms,
            prompt_tokens, completion_tokens, total_tokens, attempts, error_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.key_id,
        entry.key_name,
        entry.client_key_name,
        entry.endpoint,
        entry.model,
        entry.is_stream,
        entry.status_code,
        entry.latency_ms,
        entry.prompt_tokens,
        entry.completion_tokens,
        entry.total_tokens,
        entry.attempts,
        entry.error_summary ? entry.error_summary.slice(0, 500) : null,
        entry.created_at,
      )
      .run();

    // 同步原子累加当日汇总表，避免看板每次刷新扫描整张 request_logs
    const dayKey = getBeijingDayKey(entry.created_at);
    const upsertDaily = () =>
      this.db
        .prepare(
          `INSERT INTO daily_stats (day, requests, prompt_tokens, completion_tokens, total_tokens, updated_at)
           VALUES (?, 1, ?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET
             requests = requests + 1,
             prompt_tokens = prompt_tokens + excluded.prompt_tokens,
             completion_tokens = completion_tokens + excluded.completion_tokens,
             total_tokens = total_tokens + excluded.total_tokens,
             updated_at = excluded.updated_at`,
        )
        .bind(dayKey, entry.prompt_tokens, entry.completion_tokens, entry.total_tokens, entry.created_at)
        .run();

    try {
      await upsertDaily();
    } catch (err) {
      if (isMissingDailyStatsTableError(err)) {
        await this.ensureDailyStatsTable();
        await upsertDaily();
      } else {
        throw err;
      }
    }

    // 低频主键范围裁剪：仅每 25 次写入清理一次超出最近 500 条的历史日志，彻底消除全表 NOT IN 扫描
    const lastRowId = Number(insertRes.meta?.last_row_id ?? 0);
    if (lastRowId > MAX_RETAINED_LOGS && lastRowId % LOG_PRUNE_INTERVAL === 0) {
      await this.db
        .prepare('DELETE FROM request_logs WHERE id <= ?')
        .bind(lastRowId - MAX_RETAINED_LOGS)
        .run();
    }
  }

  async listLogs(limit = 50): Promise<RequestLogRecord[]> {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_RETAINED_LOGS);
    const result = await this.db
      .prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT ?')
      .bind(safeLimit)
      .all<RequestLogRecord>();
    return result.results ?? [];
  }

  async getTodayStats(now = Date.now()): Promise<TodayStats> {
    const dayKey = getBeijingDayKey(now);
    const queryDaily = () =>
      this.db
        .prepare(
          `SELECT requests,
                  prompt_tokens AS promptTokens,
                  completion_tokens AS completionTokens,
                  total_tokens AS totalTokens
           FROM daily_stats
           WHERE day = ?`,
        )
        .bind(dayKey)
        .first<TodayStats>();

    let row: TodayStats | null = null;
    try {
      row = await queryDaily();
    } catch (err) {
      if (isMissingDailyStatsTableError(err)) {
        await this.ensureDailyStatsTable();
        row = null;
      } else {
        throw err;
      }
    }

    return {
      requests: Number(row?.requests ?? 0),
      promptTokens: Number(row?.promptTokens ?? 0),
      completionTokens: Number(row?.completionTokens ?? 0),
      totalTokens: Number(row?.totalTokens ?? 0),
    };
  }

  async getSettings(): Promise<PoolSettings> {
    const now = Date.now();
    if (cachedSettings && cachedSettings.expiresAt > now) {
      return { ...cachedSettings.value };
    }

    const result = await this.db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
    const map = new Map((result.results ?? []).map((row) => [row.key, row.value]));

    const rawStrategy = map.get('routing_strategy');
    const routing_strategy: RoutingStrategy =
      rawStrategy === 'remaining_first' || rawStrategy === 'round_robin' || rawStrategy === 'sequential'
        ? rawStrategy
        : DEFAULT_SETTINGS.routing_strategy;

    const probe_model = map.get('probe_model')?.trim() || DEFAULT_SETTINGS.probe_model;
    const value: PoolSettings = { routing_strategy, probe_model };

    cachedSettings = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    return { ...value };
  }

  async updateSettings(partial: Partial<PoolSettings>): Promise<PoolSettings> {
    const now = Date.now();
    if (partial.routing_strategy) {
      await this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('routing_strategy', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(partial.routing_strategy, now)
        .run();
    }
    if (partial.probe_model !== undefined && partial.probe_model.trim()) {
      await this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('probe_model', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(partial.probe_model.trim(), now)
        .run();
    }
    clearSettingsCache();
    return this.getSettings();
  }
}
