'use strict';

/**
 * 坤坤 - 对话式旅行规划助手（服务入口）
 *
 * 架构：
 *   前端 (public/index.html) --POST /api/chat/stream--> Express
 *                                                        |
 *                                                        +-- Agent 循环 (Function Calling)
 *                                                              |-- streamChatCompletion()  模型流式推理
 *                                                              |-- amap.run()              高德四类工具
 *                                                              +-- LRUCache               高德接口缓存
 *
 * 依赖：Node >= 18（需要全局 fetch / TextDecoder）
 *
 * 安全要点（上公网必看）：
 *   - 静态目录只暴露 public/，代码、.env、备份目录一律不可下载；
 *   - 接口默认要求 ACCESS_TOKEN，采用 Bearer 头，定长比较；
 *   - 接口有限流，防止刷爆模型和高德的配额；
 *   - 客户端断开时立刻中断上游请求。
 */

const express = require('express');
const cors = require('cors');
const os = require('os');
const crypto = require('crypto');

const { loadConfig, ConfigError, weatherProviderOf, PUBLIC_DIR } = require('./src/config');
const { AmapClient, TOOLS } = require('./src/amap');
const { QWeatherClient, WEATHER_TOOL } = require('./src/qweather');
const { ToolRegistry } = require('./src/tool-registry');
const { createStaticMapService, createMapImageTool, STATICMAP_PATH } = require('./src/static-map');
const { FeishuClient, createFeishuExportTool } = require('./src/feishu');
const { McpClient, registerMcpTools } = require('./src/mcp-client');
const { buildUiCard } = require('./src/ui-cards');
const { Agent, AgentAbortError } = require('./src/agent');
const { SessionStore } = require('./src/session');
const { createAuthGuard, RateLimiter, createRateLimitMiddleware } = require('./src/security');

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGE_LENGTH = 4000;

const generateSessionId = () => crypto.randomUUID();

/**
 * 组装工具：高德固定三个（地理编码 / POI / 路线），
 * weather 则按配置二选一——和风优先，没有 key 就用高德自带的实时天气。
 */
function createToolRegistry(config, amap, qweather, mapImage, feishuTool) {
  const registry = new ToolRegistry();
  const amapToolNames = ['geocode', 'poi_search', 'route_planning'];
  const useQWeather = weatherProviderOf(config) === 'qweather';
  if (!useQWeather) amapToolNames.push('weather');

  for (const name of amapToolNames) {
    const schema = TOOLS.find((tool) => tool.function.name === name);
    if (!schema) throw new Error(`缺少高德工具定义：${name}`);
    registry.register({
      schema,
      handler: (args, options) => amap.run(name, args, options),
    });
  }

  if (useQWeather) {
    registry.register({
      schema: WEATHER_TOOL,
      handler: (args, options) => qweather.run('weather', args, options),
    });
  }

  if (mapImage) {
    registry.register({ schema: mapImage.schema, handler: mapImage.handler });
  }

  if (feishuTool) {
    registry.register({ schema: feishuTool.schema, handler: feishuTool.handler });
  }

  return registry;
}

function createDeps(config) {
  const amap = new AmapClient({
    key: config.amapKey,
    baseUrl: config.amapBaseUrl,
    cacheSize: config.amapCacheSize,
    timeoutMs: config.amapTimeoutMs,
  });

  const qweather = config.qweatherApiKey
    ? new QWeatherClient({
        apiKey: config.qweatherApiKey,
        baseUrl: config.qweatherBaseUrl,
        timeoutMs: config.qweatherTimeoutMs,
      })
    : null;

  // 静态图的签名密钥：优先用专门的配置，否则退化到已有的两个密钥之一
  const staticMapSecret = config.staticMapSecret || config.accessToken || config.amapKey;
  const staticMap = createStaticMapService({ amap, secret: staticMapSecret });
  const mapImage = createMapImageTool({ amap, service: staticMap });

  // 飞书导出：没配应用凭证就不注册这个工具，免得模型选到必然失败的选项
  const feishu = config.feishuAppId
    ? new FeishuClient({
        appId: config.feishuAppId,
        appSecret: config.feishuAppSecret,
        webOrigin: config.feishuWebOrigin,
        folderToken: config.feishuFolderToken,
        shareTo: config.feishuShareTo,
        shareMemberType: config.feishuShareMemberType,
        linkShare: config.feishuLinkShare,
      })
    : null;
  const feishuTool = feishu ? createFeishuExportTool({ client: feishu }) : null;

  const registry = createToolRegistry(config, amap, qweather, mapImage, feishuTool);
  const agent = new Agent({ config, registry });
  const sessions = new SessionStore({
    maxSessions: config.maxSessions,
    maxHistoryTurns: config.maxHistoryTurns,
    ttlMs: config.sessionTtlMs,
  });
  return { amap, qweather, mapImage, staticMap, feishu, registry, agent, sessions };
}

function createApp(config, deps = createDeps(config)) {
  const { amap, registry, agent, sessions, staticMap } = deps;
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  const authGuard = createAuthGuard(config.accessToken);
  const limiter = new RateLimiter({
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  });
  const rateLimit = createRateLimitMiddleware(limiter);

  // ---------------------------------------------------------------------
  // 通用响应头：禁止 MIME 嗅探、不把地址带到第三方
  // ---------------------------------------------------------------------
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // ---------------------------------------------------------------------
  // 静态资源：只托管 public/，且不设置长缓存（方便改完直接刷新看到）
  // ---------------------------------------------------------------------
  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      dotfiles: 'ignore',
      maxAge: 0,
      etag: true,
    })
  );

  // ---------------------------------------------------------------------
  // 访问日志：只记接口，不刷屏静态文件
  // ---------------------------------------------------------------------
  app.use('/api', (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      const time = new Date().toLocaleString('zh-CN', { hour12: false });
      console.log(`[${time}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms ${req.ip}`);
    });
    next();
  });

  // ---------------------------------------------------------------------
  // 健康检查：放在鉴权之外，方便部署平台探活；不泄露任何密钥或内容
  // ---------------------------------------------------------------------
  const health = (req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      sessions: sessions.size,
      cache: amap.cache.size,
      model: config.aiModel,
      weatherProvider: weatherProviderOf(config),
      tools: registry.names(),
      feishu: Boolean(config.feishuAppId),
      mcpLinked: Boolean(deps.mcp),
      // 前端用它决定要不要弹令牌输入层；不涉及任何密钥内容
      authRequired: Boolean(config.accessToken),
    });
  };
  app.get('/health', health);
  app.get('/api/health', health);

  /** 校验请求体，返回 { message, sessionId } 或 null（已写过响应）。 */
  function readChatRequest(req, res) {
    const { message, sessionId } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message 不能为空' });
      return null;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `message 不能超过 ${MAX_MESSAGE_LENGTH} 个字符` });
      return null;
    }
    if (sessionId !== undefined && sessionId !== null && !SESSION_ID_PATTERN.test(String(sessionId))) {
      res.status(400).json({ error: 'sessionId 格式不合法' });
      return null;
    }
    return {
      message: message.trim(),
      sessionId: sessionId || generateSessionId(),
    };
  }

  const chatMiddleware = [authGuard, rateLimit].filter(Boolean);

  // ---------------------------------------------------------------------
  // 静态地图代理：<img> 请求带不了 Authorization 头，所以用 HMAC 签名兜住，
  // 同时保证高德的 key 永远不出服务端。
  // ---------------------------------------------------------------------
  app.get([STATICMAP_PATH, '/staticmap'], rateLimit, async (req, res) => {
    const verdict = staticMap.signer.verify(req.query);
    if (!verdict.ok) {
      res.status(403).json({ error: verdict.reason });
      return;
    }

    const location = String(req.query.location || '');
    if (!location) {
      res.status(400).json({ error: '缺少 location' });
      return;
    }

    const zoom = Math.min(17, Math.max(10, Number(req.query.zoom) || 14));
    const size = /^\d{2,4}\*\d{2,4}$/.test(String(req.query.size || '')) ? String(req.query.size) : '600*360';
    const markers = req.query.markers ? String(req.query.markers) : undefined;

    try {
      const image = await staticMap.fetchImage({ location, zoom, size, scale: 1, markers });
      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Cache-Control', 'private, max-age=600');
      if (!res.writableEnded) res.send(image.buffer);
    } catch (error) {
      console.error('[staticmap] 失败：', error.message);
      if (!res.headersSent) res.status(502).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------
  // 非流式接口：脚本调试和降级路径
  // ---------------------------------------------------------------------
  app.post(['/api/chat', '/chat'], chatMiddleware, async (req, res) => {
    const input = readChatRequest(req, res);
    if (!input) return;

    try {
      const session = sessions.touch(input.sessionId);
      const working = [...session.messages, { role: 'user', content: input.message }];
      const reply = await agent.run(working, {});
      sessions.appendTurn(input.sessionId, input.message, reply);
      res.json({ reply, sessionId: input.sessionId });
    } catch (error) {
      if (error instanceof AgentAbortError && error.timedOut) {
        res.status(504).json({ error: error.message });
        return;
      }
      console.error('[chat] 失败：', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------
  // 流式接口：SSE，逐 token 推送
  // ---------------------------------------------------------------------
  app.post(['/api/chat/stream', '/chat/stream'], chatMiddleware, async (req, res) => {
    const input = readChatRequest(req, res);
    if (!input) return;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 让 Nginx 别攒缓冲，否则看不到逐字效果
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // 客户端一断开就中断上游，别让模型和高德继续白跑
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      send('session', { sessionId: input.sessionId });

      const session = sessions.touch(input.sessionId);
      const working = [...session.messages, { role: 'user', content: input.message }];

      const reply = await agent.run(working, {
        signal: controller.signal,
        onDelta: (delta) => send('delta', { content: delta }),
        // 结构化的工具结果直接推成卡片事件，前端原样渲染，不劳模型复述
        onToolResult: (toolName, toolResult) => {
          const card = buildUiCard(toolName, toolResult);
          if (card) send('card', card);
        },
      });

      sessions.appendTurn(input.sessionId, input.message, reply);
      send('done', { sessionId: input.sessionId, content: reply });
    } catch (error) {
      if (error instanceof AgentAbortError || controller.signal.aborted) {
        // 用户主动关页面，不算错误，也不用写任何东西
        console.log(`[chat/stream] 客户端断开，已中断上游（session=${input.sessionId}）`);
      } else {
        console.error('[chat/stream] 失败：', error.message);
        send('error', { message: error.message });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // ---------------------------------------------------------------------
  // 清空会话：只允许清自己这一个，绝不能顺手把别人的会话和高德缓存全清了
  // ---------------------------------------------------------------------
  app.post(['/api/clear-history', '/clear-history'], chatMiddleware, (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId || !SESSION_ID_PATTERN.test(String(sessionId))) {
      res.status(400).json({ error: '缺少合法的 sessionId' });
      return;
    }
    sessions.delete(String(sessionId));
    res.json({ success: true, sessionId: String(sessionId) });
  });

  // 未匹配到任何路由
  app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  // 兜底：避免某个 handler 抛错导致进程退出
  app.use((error, req, res, next) => {
    const status = error && (error.status || error.statusCode);
    if (status && status >= 400 && status < 500) {
      // 典型场景：请求体不是合法 JSON、body 太大
      if (!res.headersSent) res.status(status).json({ error: '请求格式不正确' });
      return;
    }
    console.error('[未捕获异常]', error && error.stack ? error.stack : error);
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({ error: '服务内部错误' });
  });

  return app;
}

function getLanAddresses() {
  const addresses = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('');
      console.error(`[启动失败] ${error.message}`);
      console.error('');
      process.exit(1);
    }
    throw error;
  }

  const deps = createDeps(config);

  // 飞常准 Tripmatch MCP：连不上就跳过，绝不因为外部服务拖垮启动
  if (config.tripMatchApiKey) {
    const mcp = new McpClient({
      url: config.tripMatchUrl,
      apiKey: config.tripMatchApiKey,
      name: 'tripmatch',
      timeoutMs: config.tripMatchTimeoutMs,
    });
    try {
      const { registered, total } = await registerMcpTools(deps.registry, mcp, {
        prefix: config.tripMatchPrefix,
        allow: config.tripMatchToolAllow,
      });
      deps.mcp = mcp;
      console.log(`[MCP] Tripmatch 已接入：注册 ${registered.length}/${total} 个工具`);
      console.log(`      ${registered.join(', ')}`);
    } catch (error) {
      console.warn(`[MCP] Tripmatch 接入失败，已跳过：${error.message}`);
    }
  }

  const app = createApp(config, deps);

  if (!config.accessToken) {
    if (config.nodeEnv === 'production') {
      console.error('');
      console.error('[启动失败] NODE_ENV=production 时必须设置 ACCESS_TOKEN。');
      console.error('         公网上不设令牌等于把模型和高德的额度公开送人。');
      console.error('         生成一个：node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"');
      console.error('');
      process.exit(1);
    }
    console.warn('');
    console.warn('[警告] 没有设置 ACCESS_TOKEN，任何能访问到这个端口的人都能直接刷你的模型和高德配额。');
    console.warn('       本机自用可以不管；部署到公网请务必在 .env 里设置 ACCESS_TOKEN。');
    console.warn('');
  }

  const server = app.listen(config.port, () => {
    console.log('');
    console.log(`服务器已启动，模型: ${config.aiModel}`);
    console.log(`天气数据: ${weatherProviderOf(config) === 'qweather' ? '和风天气（实时 + 预报 + 预警）' : '高德（仅实时）'}`);
    console.log(`工具: ${deps.registry.names().join(', ')}`);
    console.log(`访问令牌: ${config.accessToken ? '已启用' : '未启用（本机自用可忽略）'}`);
    console.log(`限流: ${config.rateLimitMax} 次 / ${Math.round(config.rateLimitWindowMs / 1000)} 秒 / IP`);
    console.log(`本机访问:   http://localhost:${config.port}/index.html`);

    const lan = getLanAddresses();
    if (lan.length) {
      console.log('');
      console.log('局域网访问（手机与电脑连同一个 Wi-Fi）:');
      for (const address of lan) {
        console.log(`  http://${address}:${config.port}/index.html`);
      }
    }
    console.log('');
  });

  // 定期清理过期会话，别让内存一直涨
  const pruneTimer = setInterval(() => {
    const removed = deps.sessions.prune();
    if (removed) console.log(`[会话] 清理过期会话 ${removed} 个，当前 ${deps.sessions.size} 个`);
  }, 60_000);
  pruneTimer.unref();

  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭服务…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[启动失败]', error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { createApp, createDeps, main };
