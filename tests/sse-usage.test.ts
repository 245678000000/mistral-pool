import { describe, expect, it } from 'vitest';
import { createSseUsageTap } from '../src/lib/sse-usage';
import type { UsageInfo } from '../src/types';

describe('createSseUsageTap', () => {
  it('无损透传跨分片拆包的 SSE 流并提取末尾 chunk 中的 usage', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"好"}}],"usa',
      'ge":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\ndata: [DONE]\n\n',
    ];

    let capturedUsage: UsageInfo | null = null;
    const tap = createSseUsageTap((usage) => {
      capturedUsage = usage;
    });

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of chunks) {
          controller.enqueue(encoder.encode(text));
        }
        controller.close();
      },
    });

    const outputStream = source.pipeThrough(tap);
    const reader = outputStream.getReader();
    let received = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    received += decoder.decode();

    expect(received).toBe(chunks.join(''));
    expect(capturedUsage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    });
  });

  it('当流中不含 usage 字段时安全回调全 0 用量', async () => {
    const encoder = new TextEncoder();
    let capturedUsage: UsageInfo | null = null;

    const tap = createSseUsageTap((usage) => {
      capturedUsage = usage;
    });

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });

    const reader = source.pipeThrough(tap).getReader();
    while (!(await reader.read()).done) {
      // 读空流
    }

    expect(capturedUsage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});
