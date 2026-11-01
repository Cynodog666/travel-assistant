'use strict';

/**
 * 端到端冒烟测试：不依赖真实模型、真实高德 key 和外网。
 *
 * 做法是起一个假的 OpenAI 兼容服务，模拟「先返回 tool_calls 分片，再返回正文」的两轮对话，
 * 然后检查：
 *   1. SSE 事件序列是否正确（session → delta… → done）
 *   2. 前端拼装出来的文本是否完整
 *   3. tool_calls 的 arguments 分片是否被按 index 正确归并
 *   4. 工具结果是否带正确的 tool_call_id 回填
 *
 * 运行：npm test
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const MOCK_PORT = 3299;
const APP_PORT = 3199;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let secondRoundBody = null;

// ---------------------------------------------------------------------------
// 假模型服务
// ---------------------------------------------------------------------------

const mockServer = http.createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    const body = JSON.parse(raw);
    const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

    if (!hasToolResult) {
      // 第一轮：故意把 arguments 拆成多个分片，模拟真实模型的增量返回
      const fragments = [
        { index: 0, id: 'call_abc', type: 'function', function: { name: 'weather', arguments: '' } },
        { index: 0, function: { arguments: '{"city"' } },
        { index: 0, function: { arguments: ':"长' } },
        { index: 0, function: { arguments: '沙"}' } },
      ];
      for (const fragment of fragments) {
        send({ tool_calls: [fragment] });
        await sleep(15);
      }
      send({}, 'tool_calls');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 第二轮：模型拿到工具结果后输出正文
    secondRoundBody = body;
    const answer = '长沙今天多云，气温 22℃。';
    for (const char of answer) {
      send({ content: char });
      await sleep(10);
    }
    send({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ---------------------------------------------------------------------------
// 被测服务
// ---------------------------------------------------------------------------

function startApp() {
  return spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      AI_API_URL: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`,
      AI_API_KEY: 'sk-mock',
      AI_MODEL: 'mock-model',
      AMAP_KEY: 'mock-amap-key',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function postStream() {
  const response = await fetch(`http://127.0.0.1:${APP_PORT}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '长沙天气怎么样', sessionId: 'smoke' }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop();

    for (const chunk of chunks) {
      const eventLine = chunk.match(/^event:\s*(.+)$/m);
      const dataLine = chunk.match(/^data:\s*(.+)$/m);
      if (!eventLine || !dataLine) continue;
      const payload = JSON.parse(dataLine[1]);
      events.push(eventLine[1].trim());
      if (eventLine[1].trim() === 'delta') text += payload.content || '';
    }
  }

  return { events, text };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

(async () => {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
  };

  await new Promise((resolve) => mockServer.listen(MOCK_PORT, '127.0.0.1', resolve));
  console.log(`假模型服务 :${MOCK_PORT}`);

  const app = startApp();
  console.log(`被测服务   :${APP_PORT}\n`);

  try {
    let healthy = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${APP_PORT}/health`);
        if (res.ok) { healthy = true; break; }
      } catch { /* 还在启动 */ }
      await sleep(250);
    }
    check('服务启动并通过 /health', healthy);
    if (!healthy) throw new Error('服务没有启动成功');

    const { events, text } = await postStream();
    const deltaCount = events.filter((e) => e === 'delta').length;

    console.log(`\n  SSE 序列: ${events.join(' → ')}`);
    console.log(`  拼装结果: 「${text}」\n`);

    check('收到 session 事件', events.includes('session'));
    check('收到多个 delta 分片', deltaCount >= 10, `实际 ${deltaCount} 个`);
    check('收到 done 事件', events.includes('done'));
    check('没有 error 事件', !events.includes('error'));
    check('最终文本完整', text === '长沙今天多云，气温 22℃。', `实际「${text}」`);

    check('模型发起了一轮工具调用', Boolean(secondRoundBody));

    if (secondRoundBody) {
      const messages = secondRoundBody.messages || [];
      const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls);
      const toolMessage = messages.find((m) => m.role === 'tool');
      const args = assistant && assistant.tool_calls && assistant.tool_calls[0]
        && assistant.tool_calls[0].function.arguments;

      check('tool_calls.arguments 按 index 正确归并', args === '{"city":"长沙"}', `实际 ${args}`);
      check('工具结果带正确 tool_call_id 回填',
        Boolean(toolMessage && toolMessage.tool_call_id === 'call_abc'),
        toolMessage ? `tool_call_id=${toolMessage.tool_call_id}` : '缺少 tool 消息');
    }
  } catch (error) {
    check('测试执行', false, error.message);
  } finally {
    app.kill();
    mockServer.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`结果：${results.length - failed} 通过 / ${failed} 失败`);
  console.log('='.repeat(56));
  process.exit(failed ? 1 : 0);
})();
