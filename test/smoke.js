'use strict';

/**
 * 端到端冒烟测试：不依赖真实模型、真实地图/天气 key 和外网。
 *
 * 会起两个假服务：
 *   - 假模型服务：模拟「先返回 tool_calls 分片，拿到工具结果后再输出正文」的两轮对话；
 *   - 假和风天气服务：通过 QWEATHER_BASE_URL 指过去，返回固定的实时/预报/预警数据。
 *
 * 覆盖：
 *   1. 单元测试：LRU、会话裁剪、限流、令牌比较、配置校验、工具注册表、
 *      导航链接生成、高德 weather/route 结果、和风天气结果整形与降级
 *   2. 安全边界：静态目录拿不到源码和 .env；无令牌 / 错令牌被拒
 *   3. 流式链路：SSE 事件序列、文本拼装、tool_calls 按 index 归并、tool_call_id 回填
 *   4. 多会话：清空只影响自己那一个会话
 *   5. 天气替换：配了和风之后，模型只看到一个 weather 工具，且返回预报与预警
 *
 * 运行：npm test
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const APP_PORT = 3199;
const MOCK_MODEL_PORT = 3299;
const MOCK_QWEATHER_PORT = 3399;
const MOCK_MCP_PORT = 3499;
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
let trainRoundBody = null;

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

    // 按「已发生过几轮工具调用」决定这一步该干什么：
    // 火车：先 use_skill 加载 → 再查票 → 最后出正文（三轮）
    // 天气：直接查 → 出正文（两轮）
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    const userText = (lastUser && lastUser.content) || '';
    const wantsTrain = userText.includes('火车');
    const toolRounds = (body.messages || []).filter((m) => m.role === 'assistant' && m.tool_calls).length;
    const availableTools = (body.tools || []).map((t) => t.function.name);
    const hasTrainTool = availableTools.includes('tripmatch__train_search');

    let nextCall = null;
    if (wantsTrain) {
      if (toolRounds === 0 && !hasTrainTool) {
        nextCall = { name: 'use_skill', args: '{"skill":"tripmatch"}' };
      } else if (toolRounds === 1) {
        nextCall = {
          name: 'tripmatch__train_search',
          args: '{"from_city":"合肥","to_city":"北京","date":"2026-12-04"}',
        };
      }
    } else if (toolRounds === 0) {
      nextCall = { name: 'weather', args: '{"city":"长沙"}' };
    }

    if (nextCall) {
      // 故意把 name 和 arguments 都拆成多个分片，模拟真实模型的增量返回
      const fragments = [
        { index: 0, id: 'call_abc', type: 'function', function: { name: nextCall.name.slice(0, 5), arguments: '' } },
        { index: 0, function: { name: nextCall.name.slice(5), arguments: nextCall.args.slice(0, 6) } },
        { index: 0, function: { arguments: nextCall.args.slice(6, 13) } },
        { index: 0, function: { arguments: nextCall.args.slice(13) } },
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

    // 最后一轮：拿到工具结果后输出正文
    if (wantsTrain) trainRoundBody = body;
    else secondRoundBody = body;

    const answer = wantsTrain
      ? '合肥到北京的高铁我列在卡片里了，建议选上午的车次。'
      : '长沙今天多云，最高 25℃，暂无需要特别注意的预警。';
    for (const char of answer) {
      send({ content: char });
      await sleep(5);
    }
    send({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ---------------------------------------------------------------------------
// 假和风天气服务（v1 接口形态）
// ---------------------------------------------------------------------------

const mockQWeather = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const reply = (payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === '/geo/v2/city/lookup') {
    reply({
      code: '200',
      location: [
        {
          name: '长沙',
          id: '101250101',
          lat: '28.19',
          lon: '112.97',
          adm2: '长沙',
          adm1: '湖南省',
          country: '中国',
        },
      ],
    });
    return;
  }

  if (url.pathname === '/weather/v1/current/28.19/112.97') {
    reply({
      metadata: { tag: 'mock' },
      validTime: '2026-11-23T12:00+08:00',
      condition: { text: '多云', code: '101' },
      temperature: { value: 22.44, unit: '°C' },
      feelsLike: { value: 23.11, unit: '°C' },
      humidity: 0.69,
      wind: { direction: { degree: 45, compass: 'ne' }, speed: { value: 2.5, unit: 'm/s' }, scale: 3 },
      precipitation: { amount: { value: 0, unit: 'mm' }, type: 'none' },
      uvIndex: 4,
      pressure: { value: 1008, unit: 'hPa' },
      visibility: { value: 12000, unit: 'm' },
    });
    return;
  }

  if (url.pathname === '/weather/v1/daily/28.19/112.97') {
    reply({
      metadata: { tag: 'mock' },
      days: [
        {
          forecastStartTime: '2026-11-23T22:00Z',
          temperatureMax: { value: 25.24, unit: '°C' },
          temperatureMin: { value: 16.81, unit: '°C' },
          uvIndexMax: 5,
          daytime: {
            condition: { text: '多云', code: '101' },
            humidity: 0.6,
            precipitation: { amount: { value: 0, unit: 'mm' }, probability: 0.2, type: 'rain' },
          },
          nighttime: { condition: { text: '晴', code: '100' }, humidity: 0.72 },
          astro: { sunrise: '2026-11-23T22:40Z', sunset: '2026-11-24T09:55Z' },
        },
        {
          forecastStartTime: '2026-11-24T22:00Z',
          temperatureMax: { value: 18.5, unit: '°C' },
          temperatureMin: { value: 12.1, unit: '°C' },
          uvIndexMax: 2,
          daytime: {
            condition: { text: '小雨', code: '305' },
            humidity: 0.82,
            precipitation: { amount: { value: 2.4, unit: 'mm' }, probability: 0.75, type: 'rain' },
          },
          nighttime: { condition: { text: '阴', code: '104' }, humidity: 0.8 },
          astro: { sunrise: '2026-11-24T22:41Z', sunset: '2026-11-25T09:54Z' },
        },
      ],
    });
    return;
  }

  if (url.pathname === '/weatheralert/v1/current/28.19/112.97') {
    reply({
      metadata: { tag: 'mock', zeroResult: false },
      alerts: [
        {
          id: 'mock-alert-1',
          senderName: '长沙市气象台',
          issuedTime: '2026-11-23T09:00+08:00',
          messageType: { code: 'alert', supersedes: [] },
          eventType: { name: '大风', code: '1006' },
          severity: 'minor',
          color: { code: 'blue', red: 30, green: 50, blue: 205, alpha: 1 },
          effectiveTime: '2026-11-23T09:00+08:00',
          expireTime: '2026-11-24T09:00+08:00',
          headline: '长沙市气象台发布大风蓝色预警信号',
          description: '预计未来 24 小时将出现 6 级以上大风',
          instruction: '关好门窗，加固搭建物。',
        },
      ],
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '假和风服务没有实现这个接口' }));
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
      QWEATHER_API_KEY: 'mock-qweather-key',
      QWEATHER_BASE_URL: `http://127.0.0.1:${MOCK_QWEATHER_PORT}`,
      // 也验一下启动时自动接 MCP（假服务），白名单只放行 flight / train
      TRIPMATCH_API_KEY: 'fake-trip-key',
      TRIPMATCH_MCP_URL: `http://127.0.0.1:${MOCK_MCP_PORT}/mcp`,
      TRIPMATCH_TOOL_ALLOW: 'flight,train',
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
  const cards = [];
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
      if (event === 'card') cards.push(payload);
    }
  }

  return { events, text, doneContent, cards };
}

/** 一个最小的 http 替身：记录调用，按 URL 返回假数据。 */
function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, params: options.params });
      return { data: handler(url, options.params) };
    },
  };
}

/**
 * 假 MCP 服务（Streamable HTTP）：
 *   - initialize 回 SSE 并在响应头里给 Mcp-Session-Id
 *   - notifications/initialized 回 202
 *   - tools/list 回普通 JSON（用来覆盖两种响应形态）
 *   - tools/call 回 SSE
 */
function createFakeMcpServer() {
  const seen = [];
  const tools = [
    { name: 'flight_search', description: '查询航班票价', inputSchema: { type: 'object', properties: { from: { type: 'string' } } } },
    { name: 'train_search', description: '查询火车票余票', inputSchema: { type: 'object', properties: { from: { type: 'string' } } } },
    { name: 'weather_at_airport', description: '机场天气', inputSchema: { type: 'object', properties: {} } },
  ];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let message = {};
      try {
        message = JSON.parse(raw || '{}');
      } catch {
        message = {};
      }
      seen.push({ method: message.method, headers: req.headers, body: message });

      const send = (payload, sse) => {
        const headers = { 'Content-Type': sse ? 'text/event-stream' : 'application/json' };
        if (message.method === 'initialize') headers['Mcp-Session-Id'] = 'sess-1';
        res.writeHead(200, headers);
        res.end(sse ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload));
      };

      if (message.method === 'initialize') {
        send(
          { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-tripmatch' } } },
          true
        );
        return;
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools } }, false);
        return;
      }
      if (message.method === 'tools/call') {
        const calledName = message.params && message.params.name;
        // 火车票按真实返回格式给（Python 字面量 + 前缀），用来验证卡片渲染
        const text =
          calledName === 'train_search'
            ? "Train tickets: {'code': 200, 'message': 'Success', 'data': {'code': 0, 'msg': 'ok', 'data': [" +
              "{'trainNumber': 'G52', 'fromStation': '合肥南', 'toStation': '北京南', 'fromTime': '07:18', 'toTime': '10:55', 'useTime': 217, " +
              "'seatLists': [{'seatName': '二等座', 'seatPrice': 473.5, 'ticketLeft': 0}]}, " +
              "{'trainNumber': 'G2554', 'fromStation': '合肥', 'toStation': '北京南', 'fromTime': '09:00', 'toTime': '13:53', 'useTime': 293, " +
              "'seatLists': [{'seatName': '二等座', 'seatPrice': 468.0, 'ticketLeft': 99}]}]}}"
            : JSON.stringify({ ok: true, tool: calledName, args: message.params && message.params.arguments });
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }, true);
        return;
      }
      res.writeHead(400);
      res.end('{}');
    });
  });

  return { server, seen, tools };
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
    '会话裁剪保留 system 且消息成对',
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

  const { loadConfig, ConfigError, weatherProviderOf } = require('../src/config');
  let threw = false;
  try {
    loadConfig({});
  } catch (error) {
    threw = error instanceof ConfigError;
  }
  check('缺少密钥时 loadConfig 抛 ConfigError', threw);

  let qweatherThrew = false;
  try {
    loadConfig({ AI_API_KEY: 'k', AMAP_KEY: 'k', QWEATHER_API_KEY: 'k' });
  } catch (error) {
    qweatherThrew = error instanceof ConfigError && /QWEATHER_BASE_URL/.test(error.message);
  }
  check('只填和风 key 不填 API Host 时报错并给出提示', qweatherThrew);

  const baseEnv = { AI_API_KEY: 'k', AMAP_KEY: 'k' };
  check(
    '天气实现：没有和风配置时退回高德',
    weatherProviderOf(loadConfig(baseEnv)) === 'amap'
  );
  check(
    '天气实现：配齐和风后切到和风',
    weatherProviderOf(loadConfig({ ...baseEnv, QWEATHER_API_KEY: 'k', QWEATHER_BASE_URL: 'https://x.re.qweatherapi.com' })) ===
      'qweather'
  );

  // --- 工具注册表 ---
  const { ToolRegistry } = require('../src/tool-registry');
  const registry = new ToolRegistry();
  registry.register({ schema: { type: 'function', function: { name: 'a' } }, handler: async () => 'A' });
  registry.register({ schema: { type: 'function', function: { name: 'b' } }, handler: async () => 'B' });

  let duplicateThrew = false;
  try {
    registry.register({ schema: { type: 'function', function: { name: 'a' } }, handler: async () => 'A2' });
  } catch {
    duplicateThrew = true;
  }

  return (async () => {
    const unknown = await registry.run('nope', {});
    check('工具注册表：重名注册被拒绝', duplicateThrew);
    check(
      '工具注册表：按名字分发到对应 handler',
      (await registry.run('b', {})) === 'B' && registry.size === 2
    );
    check('工具注册表：未知工具返回结构化错误', Boolean(unknown.error));

    // --- 导航链接 ---
    const { buildNavigationLinks, parseLocation } = require('../src/amap-uri');
    const links = buildNavigationLinks({
      origin: '116.397,39.909',
      destination: '116.397,39.918',
      originName: '天安门',
      destinationName: '故宫',
      mode: 'walking',
    });
    const decodedApp = decodeURIComponent(links.appLink);
    check('导航链接：深链是 amapuri:// 且带经纬度', links.appLink.startsWith('amapuri://route/plan/?') && /slat=39\.909/.test(decodedApp));
    check('导航链接：步行用 t=2', /[?&]t=2(&|$)/.test(links.appLink));
    check('导航链接：H5 链接带中文起点名', decodeURIComponent(links.webLink).includes('from=116.397,39.909,天安门'));
    check('导航链接：坐标非法时返回 null', buildNavigationLinks({ origin: 'x', destination: '1,2' }) === null && parseLocation('1,2,3') === null);

    // --- 高德：weather 与带导航的 route_planning ---
    const { AmapClient } = require('../src/amap');
    const amapHttp = fakeHttp((url, params) => {
      if (url.endsWith('/v3/geocode/geo')) {
        const address = params.address;
        if (address === '长沙') {
          return { status: '1', geocodes: [{ formatted_address: '湖南省长沙市', location: '112.93,28.22', adcode: '430100' }] };
        }
        const isOrigin = address === '天安门';
        return {
          status: '1',
          geocodes: [
            {
              formatted_address: isOrigin ? '北京市东城区天安门' : '北京市东城区故宫',
              location: isOrigin ? '116.397,39.909' : '116.397,39.918',
              adcode: '110101',
            },
          ],
        };
      }
      if (url.endsWith('/v3/weather/weatherInfo')) {
        return {
          status: '1',
          lives: [{ city: '长沙市', weather: '多云', temperature: '22', winddirection: '东北', windpower: '3', humidity: '55', reporttime: '2026-11-23 12:00:00' }],
        };
      }
      if (url.endsWith('/v3/direction/driving')) {
        return {
          status: '1',
          route: { paths: [{ distance: '1500', duration: '600', steps: [{ instruction: '向东步行 300 米' }] }] },
        };
      }
      return { status: '0', info: '未实现' };
    });
    const amap = new AmapClient({ key: 'k', http: amapHttp });

    const amapWeather = await amap.run('weather', { city: '长沙' });
    check('高德 weather：走 adcode 查天气并整形', amapWeather.weather === '多云' && amapWeather.humidity === '55');

    const route = await amap.run('route_planning', { origin: '天安门', destination: '故宫', mode: 'driving' });
    check(
      '高德 route_planning：结果里带可点击的导航链接',
      route.distanceKm === 1.5 && route.durationMin === 10 &&
        Boolean(route.navigation && route.navigation.appLink && route.navigation.webLink),
      route.navigation ? '已带 appLink/webLink' : '缺少 navigation'
    );

    // --- 和风天气 ---
    const { QWeatherClient } = require('../src/qweather');
    const qwHttp = fakeHttp((url) => {
      if (url.endsWith('/geo/v2/city/lookup')) {
        return { code: '200', location: [{ name: '长沙', id: '101250101', lat: '28.19', lon: '112.97', adm2: '长沙', adm1: '湖南省' }] };
      }
      if (url.includes('/weather/v1/current/')) {
        return {
          validTime: '2026-11-23T12:00+08:00',
          condition: { text: '多云' },
          temperature: { value: 22.44 },
          feelsLike: { value: 23.11 },
          humidity: 0.69,
          wind: { direction: { compass: 'ne' }, scale: 3 },
          precipitation: { amount: { value: 0 }, type: 'none' },
          uvIndex: 4,
          visibility: { value: 12000 },
        };
      }
      if (url.includes('/weather/v1/daily/')) {
        return {
          days: [
            {
              forecastStartTime: '2026-11-23T22:00Z',
              temperatureMax: { value: 25.24 },
              temperatureMin: { value: 16.81 },
              uvIndexMax: 5,
              daytime: { condition: { text: '多云' }, humidity: 0.6, precipitation: { amount: { value: 0 }, probability: 0.2 } },
              nighttime: { condition: { text: '晴' } },
              astro: { sunrise: '2026-11-23T22:40Z', sunset: '2026-11-24T09:55Z' },
            },
          ],
        };
      }
      if (url.includes('/weatheralert/v1/current/')) {
        return {
          metadata: { zeroResult: false },
          alerts: [
            {
              senderName: '长沙市气象台',
              eventType: { name: '大风' },
              severity: 'minor',
              color: { code: 'blue' },
              headline: '大风蓝色预警',
              effectiveTime: '2026-11-23T09:00+08:00',
              expireTime: '2026-11-24T09:00+08:00',
              instruction: '关好门窗',
            },
          ],
        };
      }
      throw new Error('未实现');
    });
    const qweather = new QWeatherClient({ apiKey: 'k', baseUrl: 'https://mock.qweatherapi.com', http: qwHttp });
    const shaped = await qweather.run('weather', { city: '长沙', days: 3 });

    check(
      '和风 weather：温度四舍五入、湿度转百分比',
      shaped.now.temperatureC === 22.4 && shaped.now.humidityPct === 69,
      `${shaped.now.temperatureC}℃ / ${shaped.now.humidityPct}%`
    );
    check('和风 weather：预报按天裁剪并带降水概率', shaped.forecast.length === 1 && shaped.forecast[0].precipitationProbabilityPct === 20);
    check('和风 weather：预警被简化为可读结构', shaped.alerts.length === 1 && shaped.alerts[0].headline === '大风蓝色预警');

    // 预警接口挂了，不该让整个天气查询失败
    const qwDegraded = new QWeatherClient({
      apiKey: 'k',
      baseUrl: 'https://mock.qweatherapi.com',
      http: {
        async get(url, options) {
          if (url.includes('/weatheralert/')) {
            const error = new Error('boom');
            error.response = { status: 500 };
            throw error;
          }
          return qwHttp.get(url, options);
        },
      },
    });
    const degraded = await qwDegraded.run('weather', { city: '长沙' });
    check(
      '和风 weather：预警接口失败时降级但保留实时数据',
      degraded.now.text === '多云' && degraded.alertsError === '预警接口暂时不可用',
      `alertsError=${degraded.alertsError}`
    );

    const notFound = await qweather.run('weather', { city: '' });
    check('和风 weather：缺少 city 时返回结构化错误', Boolean(notFound.error));

    // 域名解析失败是最常见的配置错误（把文档里的示例地址当成了自己的 API Host）
    const wrongHost = new QWeatherClient({
      apiKey: 'k',
      baseUrl: 'https://example-not-mine.qweatherapi.com',
      http: {
        async get() {
          const error = new Error('getaddrinfo ENOTFOUND');
          error.code = 'ENOTFOUND';
          throw error;
        },
      },
    });
    let hostHint = '';
    try {
      await wrongHost.run('weather', { city: '长沙' });
    } catch (error) {
      hostHint = error.message;
    }
    check('和风：域名解析失败时提示去核对 API Host', /API Host/.test(hostHint), hostHint.slice(0, 32));

    // --- 静态地图：签名 ---
    const { UrlSigner, buildAmapStaticMapUrl, looksLikeCoords } = require('../src/static-map');
    const signer = new UrlSigner('test-secret', { ttlMs: 60_000 });
    const signedPath = signer.sign({ location: '112.90,28.20', zoom: 14, size: '600*360' });
    const signedQuery = Object.fromEntries(new URL('http://localhost' + signedPath).searchParams.entries());

    check('静态图签名：自己签的地址能验过', signer.verify(signedQuery).ok, signedPath.slice(0, 28) + '…');
    check('静态图签名：改掉参数就验不过', !signer.verify({ ...signedQuery, zoom: '15' }).ok);
    check('静态图签名：过期后验不过', !signer.verify(signedQuery, Date.now() + 120_000).ok);

    const keyProbe = 'SECRETKEY123';
    check(
      '静态图：签名地址里不含高德 key',
      !signedPath.includes(keyProbe) && buildAmapStaticMapUrl({ key: keyProbe, location: '112.90,28.20' }).includes(keyProbe)
    );
    check('静态图：坐标和地址能区分开', looksLikeCoords('112.9,28.2') && !looksLikeCoords('长沙岳麓山'));

    // --- 飞书云文档导出 ---
    const { FeishuClient, explainFeishuError, sanitizeBlocks } = require('../src/feishu');

    const feishuCalls = [];
    const fakeFeishuHttp = {
      async request(config) {
        feishuCalls.push(config);
        const path = String(config.url || '').replace('https://open.feishu.cn', '');
        // 真实接口把 token 放在响应根部，不在 data 里
        if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
          return { data: { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 } };
        }
        if (path === '/open-apis/docx/v1/documents') {
          return { data: { code: 0, data: { document: { document_id: 'doxcn1', revision_id: 1, title: config.data.title } } } };
        }
        if (path === '/open-apis/docx/v1/documents/blocks/convert') {
          return {
            data: {
              code: 0,
              data: {
                first_level_block_ids: ['h1', 't1'],
                blocks: [
                  { block_id: 'h1', block_type: 3, heading1: { elements: [] }, children: [], revision_id: 1, parent_id: '' },
                  {
                    block_id: 't1',
                    block_type: 31,
                    table: { property: { row_size: 1, column_size: 1 }, merge_info: [{ row_span: 1 }] },
                    children: ['c1'],
                    revision_id: 2,
                  },
                  { block_id: 'c1', block_type: 32, table_cell: {}, children: ['p1'] },
                  { block_id: 'p1', block_type: 2, text: { elements: [] }, children: [] },
                ],
              },
            },
          };
        }
        if (path.includes('/blocks/') && path.endsWith('/descendant')) {
          return { data: { code: 0, data: { block_id_relations: [] } } };
        }
        // 故意返回一个和 webOrigin 不同的域名，用来证明链接是问飞书要的
        if (path === '/open-apis/drive/v1/metas/batch_query') {
          return {
            data: {
              code: 0,
              data: { metas: [{ doc_token: 'doxcn1', url: 'https://real-tenant.feishu.cn/docx/doxcn1' }] },
            },
          };
        }
        if (path.includes('/permissions/')) return { data: { code: 0, data: {} } };
        return { data: { code: 999, msg: 'unexpected ' + path } };
      },
    };

    const feishu = new FeishuClient({
      appId: 'cli_test',
      appSecret: 'secret',
      webOrigin: 'https://demo.feishu.cn',
      folderToken: 'fld_test',
      shareTo: 'me@example.com',
      linkShare: 'anyone_readable',
      http: fakeFeishuHttp,
    });

    const exported = await feishu.exportMarkdown({ title: '长沙 3 日行程单', markdown: '# Day 1\n\n- 岳麓山' });
    const tokenCalls = feishuCalls.filter((c) => String(c.url).endsWith('/tenant_access_token/internal')).length;
    const createCall = feishuCalls.find((c) => String(c.url).endsWith('/open-apis/docx/v1/documents'));
    const convertCall = feishuCalls.find((c) => String(c.url).endsWith('/blocks/convert'));
    const insertCall = feishuCalls.find((c) => String(c.url).endsWith('/descendant'));
    const permCall = feishuCalls.find((c) => String(c.url).endsWith('/members'));

    check('飞书：导出返回飞书给的真实链接（不是拼域名）', exported.url === 'https://real-tenant.feishu.cn/docx/doxcn1', exported.url);
    check('飞书：tenant_access_token 只取一次（复用缓存）', tokenCalls === 1, `实际 ${tokenCalls} 次`);
    check('飞书：建文档时带上文件夹 token', Boolean(createCall && createCall.data.folder_token === 'fld_test'));
    check(
      '飞书：Markdown 走 convert 接口转换',
      Boolean(convertCall && convertCall.data.content_type === 'markdown' && convertCall.data.content.includes('岳麓山'))
    );

    const inserted = insertCall ? insertCall.data.descendants || [] : [];
    const insertedIds = inserted.map((b) => b.block_id);
    const tableBlock = inserted.find((b) => b.block_id === 't1');
    check('飞书：回插的 block 已剔除只读字段', !inserted.some((b) => b.revision_id !== undefined || b.parent_id !== undefined || b.merge_info !== undefined));
    check('飞书：表格与单元格的父子关系保留', Boolean(tableBlock && tableBlock.children.join() === 'c1') && insertedIds.includes('p1'));
    check('飞书：一级块作为 children_id 提交', Boolean(insertCall && insertCall.data.children_id.join() === 'h1,t1'));
    check('飞书：给分享对象授了权限', Boolean(permCall && permCall.data.member_id === 'me@example.com') && exported.shared === true);

    const publicCall = feishuCalls.find((c) => String(c.url).endsWith('/public'));
    check(
      '飞书：可设成「互联网可读」链接分享（不需要邮箱）',
      Boolean(
        publicCall &&
          publicCall.method === 'PATCH' &&
          publicCall.data.link_share_entity === 'anyone_readable' &&
          publicCall.data.external_access === true &&
          publicCall.params.type === 'docx'
      ) && exported.linkShared === true
    );
    check(
      '飞书：member_type 兼容 open_id 写法',
      new FeishuClient({ appId: 'a', appSecret: 'b', shareMemberType: 'open_id' }).shareMemberType === 'openid'
    );

    // 超过 50 个一级块时分批
    const batchCalls = [];
    const batchClient = new FeishuClient({
      appId: 'cli_test',
      appSecret: 'secret',
      http: {
        async request(config) {
          if (String(config.url).endsWith('/tenant_access_token/internal')) {
            return { data: { code: 0, msg: 'ok', tenant_access_token: 't-2', expire: 7200 } };
          }
          batchCalls.push(config);
          return { data: { code: 0, data: {} } };
        },
      },
    });
    const manyBlocks = [];
    const manyIds = [];
    for (let i = 0; i < 60; i += 1) {
      manyIds.push(`b${i}`);
      manyBlocks.push({ block_id: `b${i}`, block_type: 2, text: { elements: [] }, children: [] });
    }
    await batchClient.insertBlocks('doxcn1', { blocks: manyBlocks, firstLevelIds: manyIds });
    check('飞书：一级块超过 50 个自动分批插入', batchCalls.length === 2, `实际 ${batchCalls.length} 次`);

    check(
      '飞书：错误码映射成可读提示',
      explainFeishuError(1770040, 'no permission').includes('权限') &&
        explainFeishuError(99991400, 'rate').includes('限流') &&
        explainFeishuError(21001, 'policy').includes('21001')
    );

    // 真实环境踩到过：merge_info 藏在 table.property 里，只删顶层会导致 1770001
    const cleanedTable = sanitizeBlocks([
      {
        block_id: 't1',
        block_type: 31,
        revision_id: 2,
        parent_id: 'doc',
        children: ['c1'],
        table: {
          cells: ['c1'],
          property: { row_size: 1, column_size: 1, merge_info: [{ row_span: 1 }] },
        },
      },
    ]);
    const dumped = JSON.stringify(cleanedTable);
    check(
      '飞书：表格的 merge_info / cells 被递归剔除',
      !dumped.includes('merge_info') &&
        !dumped.includes('cells') &&
        !dumped.includes('revision_id') &&
        cleanedTable[0].children.join() === 'c1',
      dumped.slice(0, 90)
    );

    // --- MCP 客户端（对着假 MCP 服务测协议层）---
    const { McpClient, registerMcpTools, parseSseMessages } = require('../src/mcp-client');
    const mcpFake = createFakeMcpServer();
    await new Promise((resolve) => mcpFake.server.listen(0, '127.0.0.1', resolve));
    const mcpPort = mcpFake.server.address().port;

    const mcp = new McpClient({
      url: `http://127.0.0.1:${mcpPort}/mcp`,
      apiKey: 'fake-key',
      name: 'tripmatch',
    });

    const info = await mcp.initialize();
    check('MCP：initialize 握手成功并协商版本', info.protocolVersion === '2025-06-18', mcp.protocolVersion);
    check('MCP：记下了 Mcp-Session-Id', mcp.sessionId === 'sess-1');

    const mcpToolList = await mcp.listTools();
    check('MCP：tools/list 支持普通 JSON 响应', mcpToolList.length === 3, `实际 ${mcpToolList.length} 个`);

    const mcpRegistry = new ToolRegistry();
    const regResult = await registerMcpTools(mcpRegistry, mcp, { prefix: 'tripmatch__', allow: ['flight', 'train'] });
    check(
      'MCP：按白名单过滤并加前缀注册',
      regResult.registered.join() === 'tripmatch__flight_search,tripmatch__train_search' &&
        regResult.total === 3,
      regResult.registered.join()
    );

    const mcpOutput = await mcpRegistry.run('tripmatch__flight_search', { from: 'HFE' });
    check(
      'MCP：tools/call 走 SSE 并解析成结构化结果',
      Boolean(mcpOutput && mcpOutput.ok === true && mcpOutput.args.from === 'HFE'),
      JSON.stringify(mcpOutput)
    );

    const handshake = mcpFake.seen[0];
    const afterInit = mcpFake.seen.filter((item) => item.method === 'tools/list')[0];
    check(
      'MCP：带上 API Key，后续请求回传 session',
      handshake.headers['x-api-key'] === 'fake-key' && afterInit.headers['mcp-session-id'] === 'sess-1'
    );

    check(
      'MCP：SSE 解析只取 data 帧',
      parseSseMessages('event: message\ndata: {"a":1}\n\n: keepalive\n\n').length === 1
    );

    // JSON-RPC 的 error 字段必须冒出来，不能被当成成功
    const errorHttp = {
      async post(url, body) {
        const id = body.id;
        if (body.method === 'initialize') {
          return { headers: {}, data: { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18' } } };
        }
        if (body.method === 'notifications/initialized') {
          return { headers: {}, data: '' };
        }
        return { headers: {}, data: { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid params' } } };
      },
    };
    const errClient = new McpClient({ url: 'http://x/mcp', name: 'tripmatch', http: errorHttp });
    await errClient.initialize();
    let mcpErrorMessage = '';
    try {
      await errClient.callTool('flight_search', {});
    } catch (error) {
      mcpErrorMessage = error.message;
    }
    check('MCP：JSON-RPC error 转成可读错误抛出', /invalid params/.test(mcpErrorMessage), mcpErrorMessage.slice(0, 48));

    mcpFake.server.close();

    // --- 工具结果 → 卡片 ---
    const { parsePythonLiteral } = require('../src/py-literal');
    const { buildUiCard } = require('../src/ui-cards');

    check(
      'Python 字面量：单引号、嵌套、None/True/False 都能解析',
      (() => {
        const parsed = parsePythonLiteral("{'a': [1, 2.5, None, True, False], 'b': 'x'}");
        return parsed.a.length === 5 && parsed.a[2] === null && parsed.a[3] === true && parsed.b === 'x';
      })()
    );

    // 真实返回样式：前缀 + Python repr + data.data 双层嵌套
    const trainPayload =
      "Train tickets: {'code': 200, 'message': 'Success', 'data': {'code': 0, 'msg': 'ok', 'data': [" +
      "{'trainNumber': 'G52', 'fromStation': '合肥南', 'toStation': '北京南', 'fromTime': '07:18', 'toTime': '10:55', 'useTime': 217, " +
      "'seatLists': [{'seatName': '二等座', 'seatPrice': 473.5, 'ticketLeft': 0}]}, " +
      "{'trainNumber': 'G2554', 'fromStation': '合肥', 'toStation': '北京南', 'fromTime': '09:00', 'toTime': '13:53', 'useTime': 293, " +
      "'seatLists': [{'seatName': '二等座', 'seatPrice': 468.0, 'ticketLeft': 99}]}]}}";

    const trainCard = buildUiCard('tripmatch__searchTrainTickets', trainPayload);
    check(
      '卡片：车次列表解析出车次/时刻/时长/票价/余票',
      Boolean(
        trainCard &&
          trainCard.type === 'train-list' &&
          trainCard.rows.length === 2 &&
          trainCard.rows[0].duration === '3h37m' &&
          trainCard.rows[0].seat.soldOut === true &&
          trainCard.rows[1].seat.price === 468
      ),
      trainCard ? JSON.stringify(trainCard.rows[0]) : '没生成卡片'
    );

    const flightPayload =
      "Flight search results: {'code': 200, 'data': [{'FlightNo': 'CA1844', 'FlightCompany': '中国国际航空股份有限公司', " +
      "'FlightDeptimePlanDate': '2026-12-04 16:15:00', 'FlightArrtimePlanDate': '2026-12-04 18:15:00', 'FlightDuration': '92', " +
      "'FlightDep': '合肥', 'FlightArr': '北京', 'FlightDepAirport': '合肥新桥', 'FlightArrAirport': '北京首都', " +
      "'FlightTerminal': 'T3', 'OntimeRate': '100.00%'}]}";

    const flightCard = buildUiCard('tripmatch__searchFlightsByDepArr', flightPayload);
    check(
      '卡片：航班列表解析出航班号/时刻/机型和准点率',
      Boolean(
        flightCard &&
          flightCard.type === 'flight-list' &&
          flightCard.rows[0].depTime === '16:15' &&
          flightCard.rows[0].duration === '1h32m' &&
          flightCard.rows[0].airline === '中国国际航空' &&
          flightCard.rows[0].ontimeRate === '100.00%'
      ),
      flightCard ? JSON.stringify(flightCard.rows[0]) : '没生成卡片'
    );

    check(
      '卡片：服务端返回"暂无数据"时不生成空卡片',
      buildUiCard('tripmatch__getFlightPriceByCities', "Flight prices: {'code': 200, 'data': {'error_code': 10, 'error': '暂无数据'}}") === null
    );
    check('卡片：非列表结果（天气对象）不生成卡片', buildUiCard('weather', { now: { text: '多云' } }) === null);

    // --- 工具 skill 包：按需加载（省 prompt）---
    const { SkillCatalog, createToolsResolver } = require('../src/tool-skills');
    const skillRegistry = new ToolRegistry();
    for (const name of ['geocode', 'weather', 'tripmatch__train_search', 'tripmatch__flight_search']) {
      skillRegistry.register({
        schema: { type: 'function', function: { name, description: name } },
        handler: async () => name,
      });
    }

    const catalog = new SkillCatalog(skillRegistry, [
      { name: 'tripmatch', title: '火车/航班', description: '查车次与航班', match: (n) => n.startsWith('tripmatch__') },
    ]);
    skillRegistry.register({ schema: { type: 'function', function: { name: 'use_skill' } }, handler: async () => ({}) });

    const baseNames = skillRegistry.names().filter((n) => !catalog.hiddenToolNames.includes(n));
    const emptySession = { peek: () => ({ activeSkills: new Set() }) };
    const resolveBefore = createToolsResolver({ registry: skillRegistry, catalog, sessions: emptySession, baseNames });
    const beforeNames = resolveBefore('s1').map((s) => s.function.name);

    check(
      'skill：收进技能包的工具不在基线 tools 里',
      !beforeNames.some((n) => n.startsWith('tripmatch__')) &&
        beforeNames.includes('use_skill') &&
        beforeNames.includes('geocode'),
      beforeNames.join(',')
    );
    check('skill：清单只写能力不写 schema', /tripmatch：火车\/航班/.test(catalog.summaryText()) && catalog.summaryText().length < 300);

    const activeSession = { peek: () => ({ activeSkills: new Set(['tripmatch__train_search']) }) };
    const resolveAfter = createToolsResolver({ registry: skillRegistry, catalog, sessions: activeSession, baseNames });
    const afterNames = resolveAfter('s1').map((s) => s.function.name);

    check(
      'skill：加载后该工具出现在下一轮 tools',
      afterNames.includes('tripmatch__train_search') && !afterNames.includes('tripmatch__flight_search'),
      afterNames.join(',')
    );
  })();
}

// ---------------------------------------------------------------------------
// 2. 端到端测试
// ---------------------------------------------------------------------------

async function runE2ETests() {
  console.log('\n【端到端】');

  const health = await (await fetch(`${baseUrl}/health`)).json();
  check(
    '健康检查声明需要令牌且天气走和风',
    health.ok === true && health.authRequired === true && health.weatherProvider === 'qweather'
  );
  check(
    '工具列表：一个 weather + 一个 map_image',
    Array.isArray(health.tools) &&
      health.tools.filter((n) => n === 'weather').length === 1 &&
      health.tools.includes('map_image'),
    (health.tools || []).join(',')
  );

  check(
    '启动时自动接入 MCP，且白名单生效',
    health.mcpLinked === true &&
      health.tools.includes('tripmatch__flight_search') &&
      health.tools.includes('tripmatch__train_search') &&
      !health.tools.includes('tripmatch__weather_at_airport'),
    (health.tools || []).filter((n) => n.startsWith('tripmatch__')).join(',')
  );

  check(
    'skill：MCP 工具默认不进基线 tools（prompt 成本下来了）',
    Array.isArray(health.skills) &&
      health.skills.includes('tripmatch') &&
      Array.isArray(health.baseTools) &&
      !health.baseTools.some((n) => n.startsWith('tripmatch__')) &&
      health.baseTools.includes('use_skill'),
    `baseline=${(health.baseTools || []).join(',')}`
  );

  // --- 静态图代理必须验签名 ---
  const noSig = await fetch(`${baseUrl}/api/staticmap?location=112.90,28.20`);
  await noSig.body?.cancel?.();
  check('静态图代理：无签名被拒（403）', noSig.status === 403, `实际 ${noSig.status}`);

  const forgedSig = await fetch(
    `${baseUrl}/api/staticmap?location=112.90,28.20&exp=${Date.now() + 60_000}&sig=deadbeefdeadbeefdeadbeefdeadbeef`
  );
  await forgedSig.body?.cancel?.();
  check('静态图代理：伪造签名被拒（403）', forgedSig.status === 403, `实际 ${forgedSig.status}`);

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
  check('最终文本完整', text === '长沙今天多云，最高 25℃，暂无需要特别注意的预警。', `实际「${text}」`);
  check('done 事件里的完整文本一致', doneContent === text, `实际「${doneContent}」`);

  // --- tool_calls 归并与回填 ---
  check('模型发起了一轮工具调用', Boolean(secondRoundBody));
  if (secondRoundBody) {
    const messages = secondRoundBody.messages || [];
    const tools = secondRoundBody.tools || [];
    const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls);
    const toolMessage = messages.find((m) => m.role === 'tool');
    const call = assistant && assistant.tool_calls && assistant.tool_calls[0];

    const weatherTool = tools.find((t) => t.function && t.function.name === 'weather');
    check(
      '发给模型的 weather 已切换成和风（描述含预警）',
      Boolean(weatherTool) && /预警/.test(weatherTool.function.description),
      weatherTool ? weatherTool.function.description.slice(0, 24) : '找不到 weather 工具'
    );

    check('tool_calls.function.name 分片拼接正确', Boolean(call && call.function.name === 'weather'), call ? call.function.name : '缺失');
    check('tool_calls.arguments 按 index 正确归并', Boolean(call && call.function.arguments === '{"city":"长沙"}'), call ? call.function.arguments : '缺失');
    check(
      '工具结果带正确 tool_call_id 回填',
      Boolean(toolMessage && toolMessage.tool_call_id === 'call_abc'),
      toolMessage ? `tool_call_id=${toolMessage.tool_call_id}` : '缺少 tool 消息'
    );

    let payload = null;
    try {
      payload = JSON.parse(toolMessage.content);
    } catch {
      payload = null;
    }
    check(
      '工具结果走了和风链路并带回预报与预警',
      Boolean(
        payload &&
          payload.now &&
          payload.now.text === '多云' &&
          payload.now.humidityPct === 69 &&
          Array.isArray(payload.forecast) &&
          payload.forecast.length === 2 &&
          payload.alerts.length === 1
      ),
      payload ? `now=${payload.now.text} forecast=${payload.forecast.length} alerts=${payload.alerts.length}` : '解析失败'
    );
  }

  // --- 结构化卡片：问火车会下发 card 事件 ---
  const trainResponse = await postJson('/api/chat/stream', {
    message: '查一下 12 月 4 日合肥到北京的火车票',
    sessionId: 'smoke-train-01',
  });
  const trainSse = await readSse(trainResponse);
  const trainCard = trainSse.cards[0];

  check(
    '火车问题会下发 card 事件',
    trainSse.events.includes('card') && trainSse.cards.length === 1,
    `card ${trainSse.cards.length} 个`
  );
  check(
    '卡片数据来自工具结果，不是模型复述',
    Boolean(
      trainCard &&
        trainCard.type === 'train-list' &&
        trainCard.rows.length === 2 &&
        trainCard.rows[0].trainNumber === 'G52' &&
        trainCard.rows[0].seat.soldOut === true
    ),
    trainCard ? `${trainCard.title}：${trainCard.rows.map((r) => r.trainNumber).join('/')}` : '无卡片'
  );
  check(
    '卡片在正文之前下发（前端先卡片后文字）',
    trainSse.events.indexOf('card') > -1 && trainSse.events.indexOf('card') < trainSse.events.lastIndexOf('delta')
  );
  check(
    'MCP 工具按命名空间注入模型',
    Boolean(
      trainRoundBody &&
        (trainRoundBody.tools || []).some((t) => t.function.name === 'tripmatch__train_search')
    )
  );

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
    beforeClear.sessions === 3 && afterClear.sessions === 2,
    `${beforeClear.sessions} → ${afterClear.sessions}`
  );

  const clearAll = await postJson('/api/clear-history', {});
  const clearAllBody = await clearAll.json();
  check('不带 sessionId 的清空请求被拒绝（400）', clearAll.status === 400 && Boolean(clearAllBody.error));

  const leftover = await (await fetch(`${baseUrl}/health`)).json();
  check('被拒绝的请求没有误删任何会话', leftover.sessions === 2, `实际 ${leftover.sessions}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

(async () => {
  let app = null;
  let failedStart = false;
  let mcpForApp = null;

  try {
    await runUnitTests();

    await new Promise((resolve) => mockModel.listen(MOCK_MODEL_PORT, '127.0.0.1', resolve));
    await new Promise((resolve) => mockQWeather.listen(MOCK_QWEATHER_PORT, '127.0.0.1', resolve));
    mcpForApp = createFakeMcpServer();
    await new Promise((resolve) => mcpForApp.server.listen(MOCK_MCP_PORT, '127.0.0.1', resolve));
    console.log(`\n假模型服务 :${MOCK_MODEL_PORT}    假和风服务 :${MOCK_QWEATHER_PORT}    假 MCP :${MOCK_MCP_PORT}`);

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
    mockQWeather.close();
    if (mcpForApp) mcpForApp.server.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`结果：${results.length - failed} 通过 / ${failed} 失败${failedStart ? '（有异常中断）' : ''}`);
  console.log('='.repeat(56));
  process.exit(failed ? 1 : 0);
})();
