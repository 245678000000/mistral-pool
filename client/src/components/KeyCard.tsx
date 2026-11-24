import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Pencil,
  Power,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { formatRelativeTime, formatTokens } from '../api';
import type { MaskedApiKey } from '../types';

interface KeyCardProps {
  item: MaskedApiKey;
  now: number;
  probing: boolean;
  onProbe: (id: number) => void;
  onToggleEnabled: (item: MaskedApiKey) => void;
  onResetStatus: (item: MaskedApiKey) => void;
  onEdit: (item: MaskedApiKey) => void;
  onDelete: (item: MaskedApiKey) => void;
}

export function KeyCard({
  item,
  now,
  probing,
  onProbe,
  onToggleEnabled,
  onResetStatus,
  onEdit,
  onDelete,
}: KeyCardProps) {
  const cooldownRemainingSec =
    item.status === 'cooldown' && item.cooldown_until && item.cooldown_until > now
      ? Math.ceil((item.cooldown_until - now) / 1000)
      : 0;

  // 实时计算状态展示（冷却倒计时归零时在界面立即反映为待恢复）
  const effectiveStatus =
    !item.enabled
      ? 'disabled'
      : item.status === 'cooldown' && cooldownRemainingSec === 0
        ? 'healthy'
        : item.status;

  const badge = (() => {
    switch (effectiveStatus) {
      case 'disabled':
        return { text: '已停用', cls: 'bg-[#F3F2EE] text-[#6B6860] border-[#E2DFD7]' };
      case 'healthy':
        return { text: '正常', cls: 'bg-[#ECFDF3] text-[#15803D] border-[#BBF7D0]' };
      case 'cooldown':
        return {
          text: `冷却 ${cooldownRemainingSec}s`,
          cls: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]',
        };
      case 'exhausted':
        return { text: '本月已耗尽', cls: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]' };
      case 'invalid':
        return { text: '密钥失效', cls: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]' };
      default:
        return { text: '待探测', cls: 'bg-[#F5F5F4] text-[#57534E] border-[#E7E5E4]' };
    }
  })();

  const hasMonthQuota = item.month_remaining_tokens !== null;
  const monthPct =
    hasMonthQuota && item.month_limit_tokens && item.month_limit_tokens > 0
      ? Math.min(100, Math.max(0, ((item.month_remaining_tokens ?? 0) / item.month_limit_tokens) * 100))
      : null;

  const progressBarColor =
    monthPct === null
      ? 'bg-[#D6D3CB]'
      : monthPct <= 15
        ? 'bg-[#DC2626]'
        : monthPct <= 35
          ? 'bg-[#D97706]'
          : 'bg-[#E05A2B]';

  const totalUsedTokens = item.total_prompt_tokens + item.total_completion_tokens;

  return (
    <article
      className={`bg-white border rounded-2xl p-4 sm:p-5 flex flex-col justify-between transition-all ${
        item.enabled
          ? 'border-[#E6E4DD] hover:border-[#D5D1C7] shadow-[0_1px_2px_rgba(28,27,24,0.03)]'
          : 'border-[#ECEAE3] opacity-70'
      }`}
    >
      <div>
        {/* 头部：名称 + 状态徽章 + 实测延迟 */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-[#1C1B18] truncate">{item.name}</h3>
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border tabular-nums shrink-0 ${badge.cls}`}
              >
                {effectiveStatus === 'healthy' && <CheckCircle2 className="w-3 h-3" />}
                {effectiveStatus === 'cooldown' && <Clock className="w-3 h-3" />}
                {(effectiveStatus === 'invalid' || effectiveStatus === 'exhausted') && (
                  <AlertCircle className="w-3 h-3" />
                )}
                {badge.text}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-[#78746B]">
              <code className="font-mono text-[11px] bg-[#F5F4F0] px-1.5 py-0.5 rounded text-[#57534E]">
                {item.masked_key}
              </code>
              {item.custom_note && <span className="truncate">{item.custom_note}</span>}
            </div>
          </div>

          <div className="text-right shrink-0 tabular-nums">
            <div className="text-xs font-medium text-[#57534E]">
              {item.latency_ms !== null ? `${item.latency_ms} ms` : '—'}
            </div>
            <div className="text-[10px] text-[#9C978D]">#{item.priority}</div>
          </div>
        </div>

        {/* 核心区块：本月剩余额度 */}
        <div className="mt-4 p-3.5 rounded-xl bg-[#FAF9F6] border border-[#EFECE6]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-[#6B6860]">本月剩余 Token</span>
            {monthPct !== null && (
              <span className="text-xs font-semibold tabular-nums text-[#1C1B18]">
                {monthPct.toFixed(1)}%
              </span>
            )}
          </div>

          {hasMonthQuota ? (
            <>
              <div className="mt-1 flex items-baseline justify-between gap-2 tabular-nums">
                <span className="text-xl font-semibold tracking-tight text-[#1C1B18]">
                  {formatTokens(item.month_remaining_tokens)}
                </span>
                {item.month_limit_tokens !== null && (
                  <span className="text-xs text-[#78746B]">
                    / {formatTokens(item.month_limit_tokens)}
                  </span>
                )}
              </div>
              <div className="mt-2 h-2 w-full bg-[#E9E6DE] rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${progressBarColor}`}
                  style={{ width: `${monthPct ?? 100}%` }}
                />
              </div>
            </>
          ) : (
            <p className="mt-1.5 text-xs text-[#78746B]">
              尚未采集官方额度，点下方“测活刷新”或发起一次对话自动更新
            </p>
          )}
        </div>

        {/* 次级指标网格：分钟剩余与累计消耗 */}
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-[#FAF9F6] px-2 py-1.5">
            <div className="text-[10px] text-[#78746B]">分钟剩余 Token</div>
            <div className="text-xs font-medium text-[#1C1B18] tabular-nums mt-0.5">
              {item.minute_remaining_tokens !== null ? formatTokens(item.minute_remaining_tokens) : '—'}
            </div>
          </div>
          <div className="rounded-lg bg-[#FAF9F6] px-2 py-1.5">
            <div className="text-[10px] text-[#78746B]">累计调用</div>
            <div className="text-xs font-medium text-[#1C1B18] tabular-nums mt-0.5">
              {item.total_requests} 次
            </div>
          </div>
          <div className="rounded-lg bg-[#FAF9F6] px-2 py-1.5">
            <div className="text-[10px] text-[#78746B]">经网关消耗</div>
            <div className="text-xs font-medium text-[#1C1B18] tabular-nums mt-0.5">
              {formatTokens(totalUsedTokens)}
            </div>
          </div>
        </div>

        {/* 报错提示条（如有） */}
        {item.last_error && (
          <div className="mt-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-2.5 py-2 flex items-start justify-between gap-2">
            <p className="text-[11px] text-[#991B1B] break-all line-clamp-2">{item.last_error}</p>
            {(item.status === 'invalid' || item.status === 'cooldown' || item.status === 'exhausted') && (
              <button
                type="button"
                onClick={() => onResetStatus(item)}
                title="清除异常/冷却状态"
                className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-[#B91C1C] hover:underline cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                重置
              </button>
            )}
          </div>
        )}
      </div>

      {/* 底部元信息与操作按钮 */}
      <div className="mt-4 pt-3 border-t border-[#F0EDE7] flex items-center justify-between gap-2">
        <span className="text-[11px] text-[#8A857C]">
          更新于 {formatRelativeTime(item.last_checked_at, now)}
        </span>

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={probing}
            onClick={() => onProbe(item.id)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-[#1C1B18] bg-[#F5F4F0] hover:bg-[#EAE7DF] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${probing ? 'animate-spin text-[#E05A2B]' : ''}`} />
            <span>{probing ? '测活中' : '测活'}</span>
          </button>

          <button
            type="button"
            onClick={() => onToggleEnabled(item)}
            title={item.enabled ? '停用此账号' : '启用此账号'}
            className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
              item.enabled
                ? 'text-[#15803D] hover:bg-[#ECFDF3]'
                : 'text-[#9C978D] hover:bg-[#F5F4F0]'
            }`}
          >
            <Power className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onEdit(item)}
            title="编辑名称与备注"
            className="p-1.5 rounded-lg text-[#6B6860] hover:text-[#1C1B18] hover:bg-[#F5F4F0] transition-colors cursor-pointer"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onDelete(item)}
            title="删除此账号"
            className="p-1.5 rounded-lg text-[#9C978D] hover:text-[#B91C1C] hover:bg-[#FEF2F2] transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </article>
  );
}
