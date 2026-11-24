import { useState, type FormEvent } from 'react';
import { X, Upload, Plus } from 'lucide-react';
import { adminApi, ApiError } from '../api';
import type { MaskedApiKey } from '../types';

interface AddKeyModalProps {
  onClose: () => void;
  onCompleted: (message: string) => void;
}

export function AddKeyModal({ onClose, onCompleted }: AddKeyModalProps) {
  const [tab, setTab] = useState<'batch' | 'single'>('batch');
  const [rawText, setRawText] = useState('');
  const [autoProbe, setAutoProbe] = useState(true);

  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [note, setNote] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectedLines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')).length;

  const handleBatchSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rawText.trim()) {
      setError('请粘贴至少一行 API Key');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminApi.createKeysBatch(rawText, autoProbe);
      const probeHint =
        res.probeResults && res.probeResults.length > 0
          ? `，测活成功 ${res.probeResults.filter((r) => r.ok).length}/${res.probeResults.length} 个`
          : '';
      onCompleted(`成功导入 ${res.created} 个 Key${res.skipped > 0 ? `（跳过重复 ${res.skipped} 个）` : ''}${probeHint}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '导入失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSingleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError('请输入 Mistral API Key');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminApi.createKey({ name: name.trim(), api_key: apiKey.trim(), custom_note: note.trim() });
      onCompleted('已添加新 Key，点击“测活”即可刷新实时剩余额度');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '添加失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white border border-[#E6E4DD] rounded-2xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#EFECE6] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#1C1B18]">导入 Mistral API Key</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[#78746B] hover:bg-[#F5F4F0] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab 切换 */}
        <div className="px-5 pt-4">
          <div className="inline-flex p-1 rounded-xl bg-[#F3F2EE] text-xs font-medium">
            <button
              type="button"
              onClick={() => {
                setTab('batch');
                setError(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                tab === 'batch' ? 'bg-white text-[#1C1B18] shadow-xs' : 'text-[#6B6860]'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              批量导入（适合一次导 5 个）
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('single');
                setError(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                tab === 'single' ? 'bg-white text-[#1C1B18] shadow-xs' : 'text-[#6B6860]'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              单个添加
            </button>
          </div>
        </div>

        {tab === 'batch' ? (
          <form onSubmit={handleBatchSubmit} className="p-5 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-[#57534E]">
                  每行一个 Key（可选写 <code className="bg-[#F5F4F0] px-1 rounded">名称, Key</code>）
                </label>
                <span className="text-[11px] text-[#E05A2B] font-medium tabular-nums">
                  已识别 {detectedLines} 行
                </span>
              </div>
              <textarea
                rows={6}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={'mistral 1, 你的第一个Key\nmistral 2, 你的第二个Key\n或者直接每行粘贴一个纯 Key...'}
                className="w-full p-3 text-xs font-mono bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white resize-y"
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-[#57534E] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoProbe}
                onChange={(e) => setAutoProbe(e.target.checked)}
                className="rounded accent-[#E05A2B]"
              />
              <span>导入完成后立即一键测活，自动拉取所有账号的实时剩余 Token</span>
            </label>

            {error && (
              <div className="text-xs text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[#57534E] hover:bg-[#F5F4F0] cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-xl text-xs font-medium bg-[#E05A2B] hover:bg-[#C94B1F] disabled:opacity-60 text-white cursor-pointer"
              >
                {submitting ? (autoProbe ? '导入并测活中...' : '导入中...') : '确认批量导入'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSingleSubmit} className="p-5 space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">显示名称（选填）</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：mistral 1（留空自动编号）"
                className="w-full px-3 py-2 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Mistral API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="粘贴你的 Mistral API Key"
                className="w-full px-3 py-2 text-sm font-mono bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">备注（选填）</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="如：免费号 / 邮箱尾号 / 充值预算说明"
                className="w-full px-3 py-2 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white"
              />
            </div>

            {error && (
              <div className="text-xs text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[#57534E] hover:bg-[#F5F4F0] cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-xl text-xs font-medium bg-[#E05A2B] hover:bg-[#C94B1F] disabled:opacity-60 text-white cursor-pointer"
              >
                {submitting ? '添加中...' : '确认添加'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

interface EditKeyModalProps {
  item: MaskedApiKey;
  onClose: () => void;
  onSaved: () => void;
}

export function EditKeyModal({ item, onClose, onSaved }: EditKeyModalProps) {
  const [name, setName] = useState(item.name);
  const [priority, setPriority] = useState(String(item.priority));
  const [note, setNote] = useState(item.custom_note);
  const [resetStatus, setResetStatus] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('名称不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await adminApi.updateKey(item.id, {
        name: name.trim(),
        priority: Number.parseInt(priority, 10) || 0,
        custom_note: note.trim(),
        reset_status: resetStatus,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-[#E6E4DD] rounded-2xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#EFECE6] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#1C1B18]">编辑账号 · {item.masked_key}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[#78746B] hover:bg-[#F5F4F0] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-3.5">
          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">显示名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">
              顺序权重（数字越小，“顺序用完再切”策略越优先）
            </label>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-full px-3 py-2 text-sm tabular-nums bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">备注</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：主号 / 免费层 / 5 美元预算"
              className="w-full px-3 py-2 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white"
            />
          </div>

          {item.status !== 'healthy' && item.status !== 'unknown' && (
            <label className="flex items-center gap-2 text-xs text-[#57534E] cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={resetStatus}
                onChange={(e) => setResetStatus(e.target.checked)}
                className="rounded accent-[#E05A2B]"
              />
              <span>清除当前冷却 / 异常标记，重新加入调度池</span>
            </label>
          )}

          {error && (
            <div className="text-xs text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-[#57534E] hover:bg-[#F5F4F0] cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-xl text-xs font-medium bg-[#E05A2B] hover:bg-[#C94B1F] disabled:opacity-60 text-white cursor-pointer"
            >
              {saving ? '保存中...' : '保存修改'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
