'use strict';

/**
 * 坤坤 - 对话式旅行规划助手
 *
 * 架构：
 *   前端 (index.html)  --POST /chat/stream-->  Express
 *                                              |
 *                                              +-- Agent 循环 (Function Calling)
 *                                                    |-- streamChatCompletion()  模型流式推理
 *                                                    |-- runTool()               工具执行
 *                                                    +-- LRUCache               高德接口缓存
 *
 * 依赖：Node >= 18（需要全局 fetch / TextDecoder）
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);

const AI_API_URL = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const AI_TEMPERATURE = Number(process.env.AI_TEMPERATURE || 0.7);

const AMAP_KEY = process.env.AMAP_KEY || '';

const MAX_TOOL_STEPS = 5; // 单轮对话里最多允许几轮工具调用
const MAX_HISTORY_TURNS = 20; // 每个会话保留最近多少轮对话
const MAX_SESSIONS = 500; // 内存里最多保留多少个会话

if (!AI_API_KEY || !AMAP_KEY) {
  console.error('');
  console.error('[启动失败] 缺少环境变量。');
  console.error('  请先执行：copy .env.example .env');
  console.error('  然后打开 .env，填入 AI_API_KEY 和 AMAP_KEY。');
  console.error('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LRU 缓存：高德接口的重复查询直接命中缓存，减少外部请求
// ---------------------------------------------------------------------------

class LRUCache {
  constructor(maxSize = 200) {
    this.maxSize = maxSize;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  get size() {
    return this.map.size;
  }
}

const amapCache = new LRUCache(200);

// ---------------------------------------------------------------------------
// 高德地图开放平台
// ---------------------------------------------------------------------------

const AMAP_ENDPOINTS = {
  geoCode: 'https://restapi.amap.com/v3/geocode/geo',
  regeoCode: 'https://restapi.amap.com/v3/geocode/regeo',
  poiSearch: 'https://restapi.amap.com/v3/place/text',
  driving: 'https://restapi.amap.com/v3/direction/driving',
  walking: 'https://restapi.amap.com/v3/direction/walking',
  weather: 'https://restapi.amap.com/v3/weather/weatherInfo',
};

/**
 * 统一的高德请求入口：负责拼 key、判错、写缓存。
 */
async function amapRequest(service, params) {
  const endpoint = AMAP_ENDPOINTS[service];
  if (!endpoint) throw new Error(`未知的高德服务: ${service}`);

  const cacheKey = `${service}:${JSON.stringify(params)}`;
  const cached = amapCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data } = await axios.get(endpoint, {
    params: { ...params, key: AMAP_KEY, output: 'json' },
    timeout: 8000,
  });

  if (data.status !== '1') {
    throw new Error(`高德接口返回异常（${service}）：${data.info || '未知错误'}`);
  }

  amapCache.set(cacheKey, data);
  return data;
}

async function resolveLocation(address) {
  const data = await amapRequest('geoCode', { address });
  const first = data.geocodes && data.geocodes[0];
  if (!first) throw new Error(`无法解析地址：${address}`);
  return { location: first.location, adcode: first.adcode, formatted: first.formatted_address };
}

// ---------------------------------------------------------------------------
// 工具定义：交给模型的 Function Calling 描述
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'geocode',
      description: '把中文地址或地名解析成经纬度坐标，并返回行政区划编码。',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: '详细地址或地名，例如「长沙市岳麓山」' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'poi_search',
      description: '按关键词搜索地点（酒店、餐厅、景点等），返回名称、地址、坐标和电话。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '搜索关键词，例如「外滩附近酒店」' },
          city: { type: 'string', description: '限定城市，例如「上海」。不确定时留空。' },
        },
        required: ['keywords'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'route_planning',
      description: '规划两点之间的路线，返回距离、预计耗时和主要路段的行驶指引。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: '起点地址或地名' },
          destination: { type: 'string', description: '终点地址或地名' },
          mode: { type: 'string', enum: ['driving', 'walking'], description: '出行方式，默认驾车' },
        },
        required: ['origin', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: '查询某个城市当前的实时天气。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，例如「长沙」' },
        },
        required: ['city'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

async function runTool(name, args) {
  switch (name) {
    case 'geocode': {
      const data = await amapRequest('geoCode', { address: args.address });
      const geocodes = data.geocodes || [];
      if (!geocodes.length) return { message: `没有解析出「${args.address}」的坐标` };
      return geocodes.slice(0, 1).map((g) => ({
        address: g.formatted_address,
        location: g.location,
        province: g.province,
        city: g.city || g.province,
        district: g.district,
        adcode: g.adcode,
      }));
    }

    case 'poi_search': {
      const params = { keywords: args.keywords, pageSize: 10 };
      if (args.city) params.city = args.city;
      const data = await amapRequest('poiSearch', params);
      const pois = data.pois || [];
      if (!pois.length) return { message: `没有搜到「${args.keywords}」相关的地点` };
      return {
        count: Number(data.count || pois.length),
        pois: pois.slice(0, 5).map((p) => ({
          name: p.name,
          address: p.address,
          location: p.location,
          tel: p.tel || '无',
          type: p.type,
        })),
      };
    }

    case 'route_planning': {
      const mode = args.mode === 'walking' ? 'walking' : 'driving';
      const [origin, destination] = await Promise.all([
        resolveLocation(args.origin),
        resolveLocation(args.destination),
      ]);
      const data = await amapRequest(mode, {
        origin: origin.location,
        destination: destination.location,
      });
      const route = data.route;
      const path = route && route.paths && route.paths[0];
      if (!path) return { message: '没有规划出可用路线，可能是起终点太近或地址无法解析' };
      return {
        mode: mode === 'walking' ? '步行' : '驾车',
        distanceKm: Number((path.distance / 1000).toFixed(2)),
        durationMin: Math.round(path.duration / 60),
        steps: (path.steps || []).slice(0, 10).map((s) => s.instruction),
      };
    }

    case 'weather': {
      const located = await resolveLocation(args.city);
      const data = await amapRequest('weather', {
        city: located.adcode,
        extensions: 'base',
      });
      const live = data.lives && data.lives[0];
      if (!live) return { message: `没有查到「${args.city}」的天气` };
      return {
        city: live.city,
        weather: live.weather,
        temperatureC: live.temperature,
        wind: `${live.winddirection}风 ${live.windpower}级`,
        humidity: live.humidity,
        reportTime: live.reporttime,
      };
    }

    default:
      return { error: `未知工具：${name}` };
  }
}

// ---------------------------------------------------------------------------
// 模型调用：真正的流式（SSE / chunked）+ tool_calls 增量拼装
// ---------------------------------------------------------------------------

/**
 * 调用一次模型，流式读取，逐段回调 onDelta。
 * 返回 { content, toolCalls }，其中 toolCalls 已按 index 拼装成完整结构。
 */
async function streamChatCompletion(messages, { tools, onDelta }) {
  const response = await fetch(AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: AI_TEMPERATURE,
      stream: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型接口 ${response.status}：${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  const toolCalls = [];

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
        continue;
      }

      const delta = event.choices && event.choices[0] && event.choices[0].delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = typeof call.index === 'number' ? call.index : 0;
          if (!toolCalls[index]) {
            toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          const slot = toolCalls[index];
          if (call.id) slot.id = call.id;
          if (call.function && call.function.name) slot.function.name += call.function.name;
          if (call.function && call.function.arguments) slot.function.arguments += call.function.arguments;
        }
      }
    }
  }

  return { content, toolCalls: toolCalls.filter(Boolean) };
}

/**
 * Agent 主循环：模型决定调工具 -> 执行 -> 把结果回填 -> 再来一轮，直到产出最终回答。
 */
async function runAgent(messages, onDelta) {
  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const { content, toolCalls } = await streamChatCompletion(messages, { tools: TOOLS, onDelta });

    if (!toolCalls.length) {
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

        let result;
        try {
          result = await runTool(call.function.name, args);
        } catch (error) {
          result = { error: error.message };
        }

        return {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        };
      })
    );

    messages.push(...toolMessages);
  }

  return '这个问题需要调用的工具太多了，我先停在这里。你可以把问题拆成几步问我，比如先问路线，再问天气。';
}

// ---------------------------------------------------------------------------
// 会话管理（内存态，进程重启即清空）
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是「坤坤」，一个中文旅行管家。

你可以调用以下工具获取真实数据：geocode（地址转坐标）、poi_search（搜地点）、
route_planning（规划路线）、weather（查天气）。

规则：
1. 涉及具体地点、距离、路线、天气时，必须先调用工具，不要凭记忆编造。
2. 工具返回错误时，如实告诉用户没查到，不要用编造的内容填补。
3. 回答简洁，用中文，重点信息用列表呈现。
4. 当用户要求"打印版""规划表""行程单"时，输出一份完整的、可直接保存为 .html 的
   A4 旅行规划表（从 <!DOCTYPE html> 开始，到 </html> 结束），要求：
   - 尺寸 210mm × 297mm，四周留 10mm 打印边距
   - 用网格/表格排版，信息分区清晰，打印友好（浅底色、深色字、字号不小于 10pt）
   - 包含：标题区（目的地、日期、天数、天气）、每日行程表、交通信息、住宿餐饮、实用提示
   - 内联 CSS，不依赖外部资源，确保离线也能正常打开`;

const sessions = new Map();

function generateSessionId() {
  return Math.random().toString(36).slice(2, 15) + Date.now().toString(36);
}

function getSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      messages: [{ role: 'system', content: SYSTEM_PROMPT }],
      updatedAt: Date.now(),
    };
  }
  session.updatedAt = Date.now();
  sessions.set(sessionId, session);

  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  return session;
}

function trimHistory(messages) {
  const system = messages[0];
  const rest = messages.slice(1).slice(-MAX_HISTORY_TURNS * 2);
  return [system, ...rest];
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

/** 非流式接口：保留给老前端或脚本调用。 */
app.post('/chat', async (req, res) => {
  const { message, sessionId = generateSessionId() } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message 不能为空' });
  }

  try {
    const session = getSession(sessionId);
    const working = [...session.messages, { role: 'user', content: message }];
    const reply = await runAgent(working, null);

    session.messages = trimHistory([...session.messages, { role: 'user', content: message }, { role: 'assistant', content: reply }]);
    return res.json({ reply, sessionId });
  } catch (error) {
    console.error('[chat] 失败：', error.message);
    return res.status(500).json({ error: error.message });
  }
});

/** 流式接口：SSE，逐 token 推送。 */
app.post('/chat/stream', async (req, res) => {
  const { message, sessionId = generateSessionId() } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message 不能为空' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('session', { sessionId });

    const session = getSession(sessionId);
    const working = [...session.messages, { role: 'user', content: message }];

    const reply = await runAgent(working, (delta) => send('delta', { content: delta }));

    session.messages = trimHistory([
      ...session.messages,
      { role: 'user', content: message },
      { role: 'assistant', content: reply },
    ]);

    send('done', { sessionId, content: reply });
  } catch (error) {
    console.error('[chat/stream] 失败：', error.message);
    send('error', { message: error.message });
  } finally {
    res.end();
  }
});

app.post('/clear-history', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    sessions.delete(sessionId);
  } else {
    sessions.clear();
  }
  amapCache.map.clear();
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, sessions: sessions.size, cache: amapCache.size });
});

/**
 * 列出本机的局域网 IPv4 地址，方便用手机访问（连同一个 Wi-Fi 即可）。
 */
function getLanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

app.listen(PORT, () => {
  console.log('');
  console.log(`服务器已启动，模型: ${AI_MODEL}`);
  console.log(`本机访问:   http://localhost:${PORT}/index.html`);

  const lan = getLanAddresses();
  if (lan.length) {
    console.log('');
    console.log('手机访问（手机与电脑连同一个 Wi-Fi）:');
    for (const address of lan) {
      console.log(`  http://${address}:${PORT}/index.html`);
    }
    console.log('');
    console.log('如果手机打不开，多半是 Windows 防火墙拦了，见 README 的「手机访问」一节。');
  }
  console.log('');
});
