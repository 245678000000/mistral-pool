import type { ApiKeyRecord, RoutingStrategy } from '../types';

/** 判断两个时间戳是否落在同一个 UTC 自然月 */
function isSameUtcMonth(aMs: number, bMs: number): boolean {
  const da = new Date(aMs);
  const db = new Date(bMs);
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth();
}

/** 判断单个 Key 在当前时刻是否具备候选资格 */
export function isKeyEligible(key: ApiKeyRecord, now: number, excludedIds?: Set<number>): boolean {
  if (key.enabled !== 1) return false;
  if (excludedIds?.has(key.id)) return false;
  if (key.status === 'invalid') return false;

  // 仍在冷却时间内则暂不调度；冷却到期后自动恢复可用
  if (key.status === 'cooldown' && key.cooldown_until !== null && key.cooldown_until > now) {
    return false;
  }

  // 本月额度已耗尽则暂不调度；进入新的 UTC 自然月后自动解封重新探测
  if (key.status === 'exhausted') {
    const refTime = key.last_checked_at ?? key.updated_at;
    if (isSameUtcMonth(refTime, now)) {
      return false;
    }
  }

  return true;
}

/**
 * 根据指定调度策略筛选并排序候选 Key 列表
 * - remaining_first: 未采集过月度额度的 Key 优先触发首次采集，其余按月度剩余降序，同值按最久未使用升序
 * - round_robin: 按最近使用时间从早到晚依次轮询
 * - sequential: 按 priority 升序优先消耗前面账号
 */
export function selectCandidateKeys(
  keys: ApiKeyRecord[],
  strategy: RoutingStrategy,
  now = Date.now(),
  excludedIds?: Set<number>,
): ApiKeyRecord[] {
  const candidates = keys.filter((key) => isKeyEligible(key, now, excludedIds));

  return candidates.sort((a, b) => {
    if (strategy === 'round_robin') {
      const usedA = a.last_used_at ?? 0;
      const usedB = b.last_used_at ?? 0;
      if (usedA !== usedB) return usedA - usedB;
      return a.id - b.id;
    }

    if (strategy === 'sequential') {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id - b.id;
    }

    // remaining_first 默认策略
    const aUnprobed = a.month_remaining_tokens === null;
    const bUnprobed = b.month_remaining_tokens === null;
    if (aUnprobed !== bUnprobed) {
      return aUnprobed ? -1 : 1;
    }

    if (!aUnprobed && !bUnprobed) {
      const remA = a.month_remaining_tokens as number;
      const remB = b.month_remaining_tokens as number;
      if (remA !== remB) return remB - remA;
    }

    const usedA = a.last_used_at ?? 0;
    const usedB = b.last_used_at ?? 0;
    if (usedA !== usedB) return usedA - usedB;
    return a.id - b.id;
  });
}
