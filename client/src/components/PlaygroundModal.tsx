import { useState, type FormEvent } from 'react';
import { Send, Sparkles, X } from 'lucide-react';
import { adminApi, ApiError } from '../api';
import type { MaskedApiKey, PlaygroundResult } from '../types';

interface PlaygroundModalProps {
  keys: MaskedApiKey[];
  defaultModel: string;
  onClose: () => void;
  onAfterRun: () => void;
}

const PRESET_MODELS = [
  'mistral-small-latest',
  'mistral-medium-latest',
  'mistral-large-latest',
  'codestral-latest',
  'open-mistral-nemo',
];

export function PlaygroundModal({ keys, defaultModel, onClose, onAfterRun }: PlaygroundModalProps) {
  const [model, setModel] = useState(defaultModel || 'mistral-small-latest');
  const [keyId, setKeyId] = useState<string>('auto');
  const [message, setMessage] = useState('用一句话打个招呼，并告诉我你是哪个模型。');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await adminApi.runPlayground({
        model: model.trim(),
        message: message.trim(),
        key_id: keyId === 'auto' ? null : Number.parseInt(keyId, 10),
      });
      setResult(res);
      onAfterRun();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '测试请求失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-white border border-[#E6E4DD] rounded-2xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#EFECE6] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#E05A2B]" />
            <h2 className="text-base font-semibold text-[#1C1B18]">在线测试网关</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[#78746B] hover:bg-[#F5F4F0] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">测试路由方式</label>
              <select
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B]"
              >
                <option value="auto">自动调度（测试完整故障转移）</option>
                {keys.map((k) => (
                  <option key={k.id} value={String(k.id)}>
                    指定账号：{k.name} ({k.masked_key})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">模型名称</label>
              <input
                list="mistral-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B]"
              />
              <datalist id="mistral-models">
                {PRESET_MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">测试消息</label>
            <textarea
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full p-3 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white resize-none"
            />
          </div>

          {error && (
            <div className="text-xs text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {result && (
            <div
              className={`rounded-xl border p-3.5 text-sm space-y-2 ${
                result.ok
                  ? 'bg-[#FAF9F6] border-[#E6E4DD]'
                  : 'bg-[#FEF2F2] border-[#FECACA]'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
                <span
                  className={`font-medium px-2 py-0.5 rounded-full ${
                    result.ok ? 'bg-[#ECFDF3] text-[#15803D]' : 'bg-[#FEE2E2] text-[#B91C1C]'
                  }`}
                >
                  HTTP {result.statusCode}
                </span>
                {result.matchedKeyName && (
                  <span className="text-[#57534E]">
                    命中账号：<strong className="text-[#1C1B18]">{result.matchedKeyName}</strong>
                  </span>
                )}
                <span className="text-[#78746B]">耗时 {result.latencyMs} ms</span>
                {result.attempts > 1 && (
                  <span className="text-[#B45309] font-medium">自动切换重试 {result.attempts} 次</span>
                )}
                {result.usage?.total_tokens !== undefined && (
                  <span className="text-[#78746B]">消耗 {result.usage.total_tokens} tokens</span>
                )}
              </div>

              {result.ok ? (
                <p className="text-xs leading-relaxed text-[#1C1B18] whitespace-pre-wrap">
                  {result.reply || '（空回复）'}
                </p>
              ) : (
                <p className="text-xs text-[#991B1B] break-all">{result.error}</p>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-[#57534E] hover:bg-[#F5F4F0] cursor-pointer"
            >
              关闭
            </button>
            <button
              type="submit"
              disabled={running}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium bg-[#E05A2B] hover:bg-[#C94B1F] disabled:opacity-60 text-white cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{running ? '发送中...' : '发送测试'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
