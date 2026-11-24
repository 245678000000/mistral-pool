import { Check, Copy, KeyRound, RefreshCw, Terminal } from 'lucide-react';
import { useState } from 'react';
import { formatClock, formatTokens } from '../api';
import type { RequestLogRecord } from '../types';

interface ClientGuideProps {
  proxyBaseUrl: string;
  onOpenClientKeysTab?: () => void;
}

export function ClientGuide({ proxyBaseUrl, onOpenClientKeysTab }: ClientGuideProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(proxyBaseUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // 忽略剪贴板权限异常
    }
  };

  return (
    <section className="bg-white border border-[#E6E4DD] rounded-2xl p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-3">
        <Terminal className="w-4 h-4 text-[#E05A2B]" />
        <h2 className="text-sm font-semibold text-[#1C1B18]">客户端一键接入指南</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div className="rounded-xl bg-[#FAF9F6] border border-[#EFECE6] p-3">
          <div className="text-[#78746B] mb-1">1. 接口地址（Base URL）</div>
          <div className="flex items-center justify-between gap-2">
            <code className="font-mono text-[#1C1B18] truncate">{proxyBaseUrl}</code>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white border border-[#DFDDD5] text-[11px] text-[#1C1B18] hover:border-[#E05A2B] cursor-pointer"
            >
              {copied ? <Check className="w-3 h-3 text-[#15803D]" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
        </div>
        <div className="rounded-xl bg-[#FAF9F6] border border-[#EFECE6] p-3">
          <div className="text-[#78746B] mb-1">2. 创建并填入网关 API Key</div>
          <p className="text-[#1C1B18] leading-relaxed">
            前往{' '}
            {onOpenClientKeysTab ? (
              <button
                type="button"
                onClick={onOpenClientKeysTab}
                className="inline-flex items-center gap-0.5 font-medium text-[#E05A2B] hover:underline cursor-pointer"
              >
                <KeyRound className="w-3 h-3" />
                <span>网关 API Keys</span>
              </button>
            ) : (
              <strong>网关 API Keys</strong>
            )}{' '}
            一键生成密钥填入客户端即可，协议选 OpenAI 兼容。
          </p>
        </div>
        <div className="rounded-xl bg-[#FAF9F6] border border-[#EFECE6] p-3">
          <div className="text-[#78746B] mb-1">3. 合并多个号的效果</div>
          <p className="text-[#1C1B18] leading-relaxed">
            客户端只需保留这 <strong>1 个接口</strong>，后台按策略自动分配所有 Mistral 号并实时更新剩余额度。
          </p>
        </div>
      </div>
    </section>
  );
}

interface LogsPanelProps {
  logs: RequestLogRecord[];
  loading: boolean;
  onRefresh: () => void;
}

export function LogsPanel({ logs, loading, onRefresh }: LogsPanelProps) {
  return (
    <section className="bg-white border border-[#E6E4DD] rounded-2xl overflow-hidden">
      <div className="px-4 sm:px-5 py-3.5 border-b border-[#EFECE6] flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[#1C1B18]">近期调用流水</h2>
          <p className="text-[11px] text-[#78746B]">仅记录代理转发业务请求（最多保留最近 500 条）</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-[#57534E] hover:bg-[#F5F4F0] cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {logs.length === 0 ? (
        <div className="py-10 text-center text-xs text-[#8A857C]">
          还没有代理调用记录，使用客户端或点上方“在线测试”发一条消息试试
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-[#FAF9F6] text-[11px] text-[#6B6860] border-b border-[#EFECE6]">
              <tr>
                <th className="py-2.5 px-4 font-medium">时间</th>
                <th className="py-2.5 px-3 font-medium">来源密钥</th>
                <th className="py-2.5 px-3 font-medium">命中账号</th>
                <th className="py-2.5 px-3 font-medium">模型 / 路径</th>
                <th className="py-2.5 px-3 font-medium">状态</th>
                <th className="py-2.5 px-3 font-medium text-right">延迟</th>
                <th className="py-2.5 px-4 font-medium text-right">消耗 Token</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F2EFE9] tabular-nums">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-[#FCFBF9]">
                  <td className="py-2.5 px-4 text-[#78746B]">{formatClock(log.created_at)}</td>
                  <td className="py-2.5 px-3 text-[#57534E]">{log.client_key_name || '—'}</td>
                  <td className="py-2.5 px-3">
                    <span className="font-medium text-[#1C1B18]">{log.key_name || '—'}</span>
                    {log.attempts > 1 && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-[#FFFBEB] text-[#B45309] border border-[#FDE68A]">
                        切号×{log.attempts}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-[11px] text-[#57534E]">
                    {log.model || log.endpoint}
                    {log.is_stream === 1 && (
                      <span className="ml-1.5 font-sans text-[10px] text-[#8A857C]">流式</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        log.status_code >= 200 && log.status_code < 300
                          ? 'bg-[#ECFDF3] text-[#15803D]'
                          : 'bg-[#FEF2F2] text-[#B91C1C]'
                      }`}
                    >
                      {log.status_code}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right text-[#57534E]">
                    {log.latency_ms > 0 ? `${log.latency_ms} ms` : '—'}
                  </td>
                  <td className="py-2.5 px-4 text-right text-[#1C1B18]">
                    {log.total_tokens > 0 ? formatTokens(log.total_tokens) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
