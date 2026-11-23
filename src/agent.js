'use strict';

/**
 * Agent：模型流式推理 + tool_calls 增量归并 + 工具回填循环。
 *
 * 两个要点（也是最容易写错的地方）：
 *   1. 流式返回时 tool_calls 是分片到达的，必须按 index 累加 arguments 字符串，
 *      等整个流结束才是完整的 JSON。
 *   2. 用户关掉页面后要能中断上游请求，否则服务端会白跑完整个循环、
 *      还会往已经关闭的响应里写数据。
 */

/* Agent 只依赖工具注册表，不关心工具背后是高德还是和风。 */

class AgentAbortError extends Error {
  constructor(message = '请求已取消', { timedOut = false } = {}) {
    super(message);
    this.name = 'AgentAbortError';
    this.timedOut = timedOut;
  }
}

/** 把「客户端断开」和「上游超时」合成一个 signal，并负责清理定时器与监听器。 */
function createRoundSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
    },
  };
}

class Agent {
  constructor({ config, registry, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('当前 Node 没有全局 fetch，请升级到 Node 18+');
    }
    this.config = config;
    this.registry = registry;
    this.fetchImpl = fetchImpl;
  }

  /**
   * 调用一次模型，流式读取，逐段回调 onDelta。
   * 返回 { content, toolCalls }，其中 toolCalls 已按 index 拼装成完整结构。
   */
  async streamChatCompletion(messages, { signal, onDelta, round } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.config.aiApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.aiApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.aiModel,
          messages,
          tools: this.registry.tools,
          tool_choice: 'auto',
          temperature: this.config.aiTemperature,
          stream: true,
        }),
        signal,
      });
    } catch (error) {
      throw this.normalizeStreamError(error, round, '模型接口连接失败');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`模型接口 ${response.status}：${String(detail).slice(0, 300)}`);
    }
    if (!response.body) throw new Error('模型接口没有返回流式响应体');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    const partialCalls = [];

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue; // 心跳、注释行之类，直接跳过
          }

          const choice = event.choices && event.choices[0];
          const delta = choice && choice.delta;
          if (!delta) continue;

          if (delta.content) {
            content += delta.content;
            if (onDelta) onDelta(delta.content);
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              const index = typeof call.index === 'number' ? call.index : 0;
              if (!partialCalls[index]) {
                partialCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              }
              const slot = partialCalls[index];
              if (call.id) slot.id = call.id;
              if (call.function && call.function.name) {
                // 有的服务会把 name 也拆成多片，累加更安全（否则会得到 "wea""ther"）
                slot.function.name = slot.function.name
                  ? slot.function.name + call.function.name
                  : call.function.name;
              }
              if (call.function && call.function.arguments) {
                slot.function.arguments += call.function.arguments; // 字符串拼接，不是覆盖
              }
            }
          }
        }
      }
    } catch (error) {
      throw this.normalizeStreamError(error, round, '读取模型响应流失败');
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* 流已经结束，忽略 */
      }
    }

    const toolCalls = partialCalls.filter(Boolean).map((call, i) => ({
      id: call.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments || '{}' },
    }));

    return { content, toolCalls };
  }

  normalizeStreamError(error, round, prefix) {
    if (error instanceof AgentAbortError) return error;
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      return new AgentAbortError(
        round && round.timedOut ? `模型响应超时（${this.config.aiTimeoutMs}ms）` : '请求已取消',
        { timedOut: Boolean(round && round.timedOut) }
      );
    }
    return new Error(`${prefix}：${error && error.message ? error.message : String(error)}`);
  }

  /**
   * Agent 主循环：模型决定调工具 -> 执行 -> 把结果回填 -> 再来一轮，直到产出最终回答。
   * 返回完整回答文本。
   */
  async run(messages, { signal, onDelta, onToolResult } = {}) {
    const config = this.config;

    for (let step = 0; step < config.maxToolSteps; step += 1) {
      if (signal && signal.aborted) throw new AgentAbortError();

      const round = createRoundSignal(signal, config.aiTimeoutMs);
      let result;
      try {
        result = await this.streamChatCompletion(messages, {
          signal: round.signal,
          onDelta,
          round,
        });
      } finally {
        round.dispose();
      }

      const { content, toolCalls } = result;

      if (!toolCalls.length) {
        // 最后一段正文已经通过 onDelta 推给前端，这里返回完整文本用于落库
        return content;
      }

      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

      const toolMessages = await Promise.all(
        toolCalls.map(async (call) => {
          let args = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            args = {};
          }

          let toolResult;
          try {
            toolResult = await this.registry.run(call.function.name, args, { signal });
          } catch (error) {
            if (error instanceof AgentAbortError) throw error;
            if (signal && signal.aborted) throw new AgentAbortError();
            toolResult = { error: error.message };
          }

          // 工具结果通常是结构化数据，交给上层决定要不要渲染成卡片。
          // 这里只上报，不参与对话内容，出错也不影响主流程。
          if (onToolResult && toolResult && !toolResult.error) {
            try {
              onToolResult(call.function.name, toolResult);
            } catch {
              /* 卡片渲染失败不能影响对话 */
            }
          }

          return {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          };
        })
      );

      messages.push(...toolMessages);
    }

    return '这个问题需要调用的工具太多了，我先停在这里。你可以把问题拆成几步问我，比如先问路线，再问天气。';
  }
}

module.exports = { Agent, AgentAbortError, createRoundSignal };
