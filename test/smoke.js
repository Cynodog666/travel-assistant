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
    const answer = '长沙今天多云，最高 25℃，暂无需要特别注意的预警。';
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
    await runUnitTests();

    await new Promise((resolve) => mockModel.listen(MOCK_MODEL_PORT, '127.0.0.1', resolve));
    await new Promise((resolve) => mockQWeather.listen(MOCK_QWEATHER_PORT, '127.0.0.1', resolve));
    console.log(`\n假模型服务 :${MOCK_MODEL_PORT}    假和风服务 :${MOCK_QWEATHER_PORT}`);

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
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`结果：${results.length - failed} 通过 / ${failed} 失败${failedStart ? '（有异常中断）' : ''}`);
  console.log('='.repeat(56));
  process.exit(failed ? 1 : 0);
})();
