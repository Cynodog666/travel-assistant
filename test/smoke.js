'use strict';

/**
 * 端到端冒烟测试：不依赖真实模型、真实高德 key 和外网。
 *
 * 会起两个假服务：
 *   - 假模型服务：模拟「先返回 tool_calls 分片，拿到工具结果后再输出正文」的两轮对话；
 *   - 假高德服务：返回固定的 geocode / weather 响应（通过 AMAP_BASE_URL 指过去）。
 *
 * 覆盖的内容：
 *   1. 模块级单元测试：LRU 淘汰、会话裁剪、限流、令牌比较、配置校验
 *   2. 安全边界：静态目录里拿不到源码和 .env；无令牌 / 错令牌被拒
 *   3. 流式链路：SSE 事件序列、文本拼装、tool_calls 按 index 归并、tool_call_id 回填
 *   4. 多会话：清空只影响自己那一个会话
 *
 * 运行：npm test
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const APP_PORT = 3199;
const MOCK_MODEL_PORT = 3299;
const MOCK_AMAP_PORT = 3399;
const ACCESS_TOKEN = 'test-token-please-change';

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 假模型服务
// ---------------------------------------------------------------------------

let secondRoundBody = null;

const mockModel = http.createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

    if (!hasToolResult) {
      // 第一轮：故意把 name 和 arguments 都拆成多个分片，模拟真实模型的增量返回
      const fragments = [
        { index: 0, id: 'call_abc', type: 'function', function: { name: 'wea', arguments: '' } },
        { index: 0, function: { name: 'ther', arguments: '{"city"' } },
        { index: 0, function: { arguments: ':"长' } },
        { index: 0, function: { arguments: '沙"}' } },
      ];
      for (const fragment of fragments) {
        send({ tool_calls: [fragment] });
        await sleep(10);
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
      await sleep(8);
    }
    send({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ---------------------------------------------------------------------------
// 假高德服务
// ---------------------------------------------------------------------------

const mockAmap = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const reply = (payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === '/v3/geocode/geo') {
    reply({
      status: '1',
      info: 'OK',
      geocodes: [
        {
          formatted_address: '湖南省长沙市',
          location: '112.938814,28.228209',
          province: '湖南省',
          city: '长沙市',
          district: '岳麓区',
          adcode: '430100',
        },
      ],
    });
    return;
  }

  if (url.pathname === '/v3/weather/weatherInfo') {
    reply({
      status: '1',
      info: 'OK',
      lives: [
        {
          city: '长沙市',
          weather: '多云',
          temperature: '22',
          winddirection: '东北',
          windpower: '3',
          humidity: '55',
          reporttime: '2026-11-23 12:00:00',
        },
      ],
    });
    return;
  }

  reply({ status: '0', info: '假高德服务没有实现这个接口' });
});

// ---------------------------------------------------------------------------
// 被测服务
// ---------------------------------------------------------------------------

function startApp() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      AI_API_URL: `http://127.0.0.1:${MOCK_MODEL_PORT}/v1/chat/completions`,
      AI_API_KEY: 'sk-mock',
      AI_MODEL: 'mock-model',
      AMAP_KEY: 'mock-amap-key',
      AMAP_BASE_URL: `http://127.0.0.1:${MOCK_AMAP_PORT}`,
      ACCESS_TOKEN,
      RATE_LIMIT_MAX: '200',
      SESSION_TTL_MS: '600000',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

const baseUrl = `http://127.0.0.1:${APP_PORT}`;

async function waitHealthy() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      /* 还在启动 */
    }
    await sleep(250);
  }
  return false;
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${ACCESS_TOKEN}`, ...extra };
}

async function postJson(pathname, body, headers = authHeaders()) {
  return fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** 读 SSE 流，返回事件序列和拼装后的文本。 */
async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let text = '';
  let doneContent = '';

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
      const event = eventLine[1].trim();
      events.push(event);
      if (event === 'delta') text += payload.content || '';
      if (event === 'done') doneContent = payload.content || '';
    }
  }

  return { events, text, doneContent };
}

// ---------------------------------------------------------------------------
// 1. 纯模块单元测试（不起服务）
// ---------------------------------------------------------------------------

function runUnitTests() {
  console.log('\n【单元测试】');

  const { LRUCache } = require('../src/lru-cache');
  const cache = new LRUCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // a 变成最近使用
  cache.set('c', 3); // b 应该被淘汰
  check('LRU 按最近使用淘汰', cache.get('b') === undefined && cache.get('a') === 1 && cache.size === 2);

  const { SessionStore } = require('../src/session');
  const store = new SessionStore({ maxSessions: 2, maxHistoryTurns: 2 });
  store.touch('s1');
  store.appendTurn('s1', 'u1', 'a1');
  store.appendTurn('s1', 'u2', 'a2');
  store.appendTurn('s1', 'u3', 'a3');
  const messages = store.touch('s1').messages;
  const roles = messages.map((m) => m.role);
  check(
    '会话裁剪保留 system 且不超过上限',
    roles[0] === 'system' && roles.length === 5 && roles[1] === 'user' && roles[4] === 'assistant',
    `roles=${roles.join(',')}`
  );

  store.touch('s2');
  store.touch('s3'); // 超过 maxSessions=2，s1 应被淘汰
  check('会话数量超过上限时淘汰最久没动的', store.size === 2 && !store.sessions.has('s1'));

  const { RateLimiter, safeEqual } = require('../src/security');
  const limiter = new RateLimiter({ max: 2, windowMs: 60_000 });
  limiter.take('1.1.1.1');
  limiter.take('1.1.1.1');
  const third = limiter.take('1.1.1.1');
  const other = limiter.take('2.2.2.2');
  check('限流：同一 key 超过上限被拒，别的 key 不受影响', !third.allowed && other.allowed);
  check('令牌比较：相同为真、不同为假', safeEqual('abc', 'abc') && !safeEqual('abc', 'abd'));

  const { loadConfig, ConfigError } = require('../src/config');
  let threw = false;
  try {
    loadConfig({});
  } catch (error) {
    threw = error instanceof ConfigError;
  }
  check('缺少密钥时 loadConfig 抛 ConfigError', threw);
}

// ---------------------------------------------------------------------------
// 2. 端到端测试
// ---------------------------------------------------------------------------

async function runE2ETests() {
  console.log('\n【端到端】');

  // --- 健康检查 ---
  const health = await (await fetch(`${baseUrl}/health`)).json();
  check('健康检查可用且声明需要令牌', health.ok === true && health.authRequired === true);

  // --- 静态目录不能泄露源码 / 密钥 / 备份 ---
  const staticChecks = [
    ['/index.html', 200],
    ['/app.js', 200],
    ['/server.js', 404],
    ['/src/config.js', 404],
    ['/.env', 404],
    ['/.env.example', 404],
    ['/package.json', 404],
    ['/_backup_v1/server.js', 404],
    ['/test/smoke.js', 404],
  ];
  const leaked = [];
  for (const [pathname, expected] of staticChecks) {
    const res = await fetch(baseUrl + pathname);
    if (res.status !== expected) leaked.push(`${pathname}=${res.status}`);
    res.body?.cancel?.();
  }
  check('静态目录只暴露 public（源码/密钥/备份均 404）', leaked.length === 0, leaked.join(' ') || '全部符合预期');

  // --- 鉴权 ---
  const noToken = await postJson('/api/chat/stream', { message: '长沙天气怎么样' }, {});
  await noToken.body?.cancel?.();
  check('无令牌访问接口被拒（401）', noToken.status === 401, `实际 ${noToken.status}`);

  const badToken = await postJson(
    '/api/chat/stream',
    { message: '长沙天气怎么样' },
    { Authorization: 'Bearer wrong-token' }
  );
  await badToken.body?.cancel?.();
  check('错误令牌被拒（403）', badToken.status === 403, `实际 ${badToken.status}`);

  const badSession = await postJson('/api/chat/stream', { message: '你好', sessionId: 'x' });
  await badSession.body?.cancel?.();
  check('非法 sessionId 被拒（400）', badSession.status === 400, `实际 ${badSession.status}`);

  // --- 流式对话 ---
  const response = await postJson('/api/chat/stream', {
    message: '长沙天气怎么样',
    sessionId: 'smoke-session-01',
  });
  check('带令牌的流式请求返回 200', response.status === 200, `实际 ${response.status}`);

  const { events, text, doneContent } = await readSse(response);
  const deltaCount = events.filter((e) => e === 'delta').length;

  console.log(`\n  SSE 序列: ${events[0]} → …(${deltaCount} 个 delta) → ${events[events.length - 1]}`);
  console.log(`  拼装结果: 「${text}」\n`);

  check('收到 session 事件', events.includes('session'));
  check('收到多个 delta 分片', deltaCount >= 10, `实际 ${deltaCount} 个`);
  check('收到 done 事件', events.includes('done'));
  check('没有 error 事件', !events.includes('error'));
  check('最终文本完整', text === '长沙今天多云，气温 22℃。', `实际「${text}」`);
  check('done 事件里的完整文本一致', doneContent === text, `实际「${doneContent}」`);

  // --- tool_calls 归并与回填 ---
  check('模型发起了一轮工具调用', Boolean(secondRoundBody));
  if (secondRoundBody) {
    const messages = secondRoundBody.messages || [];
    const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls);
    const toolMessage = messages.find((m) => m.role === 'tool');
    const call = assistant && assistant.tool_calls && assistant.tool_calls[0];

    check('tool_calls.function.name 分片拼接正确', Boolean(call && call.function.name === 'weather'), call ? call.function.name : '缺失');
    check('tool_calls.arguments 按 index 正确归并', Boolean(call && call.function.arguments === '{"city":"长沙"}'), call ? call.function.arguments : '缺失');
    check(
      '工具结果带正确 tool_call_id 回填',
      Boolean(toolMessage && toolMessage.tool_call_id === 'call_abc'),
      toolMessage ? `tool_call_id=${toolMessage.tool_call_id}` : '缺少 tool 消息'
    );

    let toolPayload = null;
    try {
      toolPayload = JSON.parse(toolMessage.content);
    } catch {
      toolPayload = null;
    }
    check(
      '工具真的走了高德链路并带回天气数据',
      Boolean(toolPayload && toolPayload.weather === '多云' && toolPayload.city === '长沙市'),
      toolPayload ? JSON.stringify(toolPayload).slice(0, 80) : '解析失败'
    );
  }

  // --- 会话隔离：清空只能清自己 ---
  const other = await postJson('/api/chat', { message: '长沙天气怎么样', sessionId: 'other-session-01' });
  const otherBody = await other.json();
  check('非流式接口可用', other.status === 200 && Boolean(otherBody.reply), `reply 长度 ${(otherBody.reply || '').length}`);

  const beforeClear = await (await fetch(`${baseUrl}/health`)).json();
  const clearOne = await postJson('/api/clear-history', { sessionId: 'smoke-session-01' });
  const clearOneBody = await clearOne.json();
  const afterClear = await (await fetch(`${baseUrl}/health`)).json();

  check('按 sessionId 清空返回成功', clearOne.status === 200 && clearOneBody.success === true);
  check(
    '清空只删自己那一个会话',
    beforeClear.sessions === 2 && afterClear.sessions === 1,
    `${beforeClear.sessions} → ${afterClear.sessions}`
  );

  const clearAll = await postJson('/api/clear-history', {});
  const clearAllBody = await clearAll.json();
  check('不带 sessionId 的清空请求被拒绝（400）', clearAll.status === 400 && Boolean(clearAllBody.error));

  const leftover = await (await fetch(`${baseUrl}/health`)).json();
  check('被拒绝的请求没有误删任何会话', leftover.sessions === 1, `实际 ${leftover.sessions}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

(async () => {
  let app = null;
  let failedStart = false;

  try {
    runUnitTests();

    await new Promise((resolve) => mockModel.listen(MOCK_MODEL_PORT, '127.0.0.1', resolve));
    await new Promise((resolve) => mockAmap.listen(MOCK_AMAP_PORT, '127.0.0.1', resolve));
    console.log(`\n假模型服务 :${MOCK_MODEL_PORT}    假高德服务 :${MOCK_AMAP_PORT}`);

    app = startApp();
    console.log(`被测服务   :${APP_PORT}`);

    const healthy = await waitHealthy();
    check('服务启动并通过 /health', healthy);
    if (!healthy) throw new Error('服务没有启动成功');

    await runE2ETests();
  } catch (error) {
    failedStart = true;
    check('测试执行', false, error.message);
  } finally {
    if (app) app.kill();
    mockModel.close();
    mockAmap.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`结果：${results.length - failed} 通过 / ${failed} 失败${failedStart ? '（有异常中断）' : ''}`);
  console.log('='.repeat(56));
  process.exit(failed ? 1 : 0);
})();
