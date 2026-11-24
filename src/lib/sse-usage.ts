import type { UsageInfo } from '../types';

/** 安全从未知 JSON 对象中提取 Mistral / OpenAI 标准 usage 计数 */
export function extractUsageFromObject(obj: unknown): UsageInfo | null {
  if (!obj || typeof obj !== 'object') return null;
  const usage = (obj as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') return null;

  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number' ? usage.total_tokens : promptTokens + completionTokens;

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }

  return { promptTokens, completionTokens, totalTokens };
}

/**
 * 创建零缓冲 SSE 透传流转换器：
 * 1. 收到每个字节块立即透传给客户端，不增加首字延迟
 * 2. 增量扫描 `data: {...}` 行捕获末尾 chunk 的 usage 统计
 * 3. 流结束时触发唯一一次 onComplete 回调供 waitUntil 异步记账
 */
export function createSseUsageTap(
  onComplete: (usage: UsageInfo) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let latestUsage: UsageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let completed = false;

  const emitOnce = () => {
    if (completed) return;
    completed = true;
    try {
      onComplete(latestUsage);
    } catch {
      // 避免回调异常影响客户端流读取
    }
  };

  const inspectLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const parsed: unknown = JSON.parse(payload);
      const found = extractUsageFromObject(parsed);
      if (found) {
        latestUsage = found;
      }
    } catch {
      // 忽略非 JSON 或畸形行
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // 立即无延迟透传原始字节块
      controller.enqueue(chunk);

      // 异步解析文本行寻找 usage
      lineBuffer += decoder.decode(chunk, { stream: true });
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        inspectLine(line);
      }
    },
    flush() {
      lineBuffer += decoder.decode();
      if (lineBuffer.trim()) {
        inspectLine(lineBuffer);
      }
      emitOnce();
    },
  });
}
