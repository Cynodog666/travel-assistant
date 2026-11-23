'use strict';

/**
 * 极简 MCP 客户端（Streamable HTTP 传输）。
 *
 * 为什么手写而不引 SDK：这里只需要「连一个远程 MCP、列工具、调工具」三件事，
 * 协议本身是 JSON-RPC 2.0 上一个很薄的壳。手写 200 行，比带一个依赖树更适合这个项目。
 *
 * 协议要点（容易踩的地方都在这儿）：
 *   1. 必须先 initialize 握手，再发 notifications/initialized，之后才能 tools/list / tools/call；
 *   2. 响应可能是普通 JSON，也可能是 SSE 流（text/event-stream），两种都要能解析；
 *   3. 服务端可能在响应头里给 Mcp-Session-Id，后续请求必须原样带回去；
 *   4. 握手要协商 protocolVersion，服务端不支持时会拒，所以这里按新版到旧版依次退让。
 */

const axios = require('axios');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_TIMEOUT_MS = 10_000;

/** 从 SSE 文本里取出所有 JSON-RPC 消息。 */
function parseSseMessages(text) {
  const messages = [];
  const frames = String(text).split(/\r?\n\r?\n/);

  for (const frame of frames) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;

    const payload = dataLines.join('\n');
    if (!payload || payload === '[DONE]') continue;

    try {
      messages.push(JSON.parse(payload));
    } catch {
      // 心跳或非 JSON 帧，忽略
    }
  }

  return messages;
}

/** 从响应里挑出与请求 id 匹配的那条 JSON-RPC 消息。 */
function pickResponse(messages, id) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const matched = messages.find((message) => message && message.id === id);
  if (matched) return matched;
  // 有些服务端不回 id，退而求其次取最后一条带 result/error 的
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && (message.result !== undefined || message.error !== undefined)) return message;
  }
  return null;
}

class McpClient {
  constructor({
    url,
    apiKey = '',
    name = 'mcp',
    headerName = 'X-API-Key',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    http = axios,
  }) {
    if (!url) throw new Error('McpClient 需要 url');
    this.url = url;
    this.apiKey = apiKey;
    this.name = name;
    this.headerName = headerName;
    this.timeoutMs = timeoutMs;
    this.http = http;
    this.sessionId = '';
    this.protocolVersion = '';
    this.serverInfo = null;
    this.nextId = 1;
    this.ready = false;
  }

  headers() {
    const headers = {
      'Content-Type': 'application/json',
      // 两个都声明：服务端可能回 JSON，也可能回 SSE
      Accept: 'application/json, text/event-stream',
    };
    if (this.apiKey) headers[this.headerName] = this.apiKey;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  async post(body) {
    let response;
    try {
      response = await this.http.post(this.url, body, {
        headers: this.headers(),
        timeout: this.timeoutMs,
        // 302 之类的跳转交给 axios 自己跟
        maxRedirects: 5,
      });
    } catch (error) {
      const status = error && error.response && error.response.status;
      if (status === 401 || status === 403) {
        throw new Error(`${this.name} MCP 鉴权失败（HTTP ${status}）：检查 API Key 是否正确、是否过期`);
      }
      if (error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')) {
        throw new Error(`${this.name} MCP 请求超时（${this.timeoutMs}ms）`);
      }
      if (error && (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')) {
        throw new Error(`${this.name} MCP 域名解析失败：${this.url}`);
      }
      throw new Error(`${this.name} MCP 请求失败：${(error && error.message) || '未知错误'}`);
    }

    const session = response.headers && (response.headers['mcp-session-id'] || response.headers['Mcp-Session-Id']);
    if (session) this.sessionId = session;

    return response;
  }

  /** 把响应体解析成 JSON-RPC 消息数组；兼容 JSON 与 SSE 两种形态。 */
  static toMessages(response) {
    const contentType = String((response.headers && response.headers['content-type']) || '');
    const body = response.data;

    if (typeof body === 'object' && body !== null) {
      return Array.isArray(body) ? body : [body];
    }

    const text = String(body || '');
    if (!text.trim()) return [];

    if (contentType.includes('text/event-stream') || /^\s*(event|data):/m.test(text)) {
      return parseSseMessages(text);
    }

    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  /** 发一条 JSON-RPC 请求并返回匹配的响应消息。 */
  async request(method, params) {
    const id = this.nextId;
    this.nextId += 1;

    const response = await this.post({
      jsonrpc: '2.0',
      id,
      method,
      params: params === undefined ? {} : params,
    });

    const message = pickResponse(McpClient.toMessages(response), id);
    if (!message) {
      throw new Error(`${this.name} MCP 返回里找不到 ${method} 的响应（可能鉴权被拒或服务端异常）`);
    }
    if (message.error) {
      const detail = message.error.message || JSON.stringify(message.error);
      throw new Error(`${this.name} MCP ${method} 出错：${detail}`);
    }
    return message.result || {};
  }

  async notify(method, params) {
    // 通知没有 id，服务端一般回 202/空体，失败也不影响后续
    try {
      await this.post({ jsonrpc: '2.0', method, params: params === undefined ? {} : params });
    } catch {
      /* 忽略 */
    }
  }

  async initialize() {
    let lastError = null;

    for (const version of PROTOCOL_VERSIONS) {
      try {
        const result = await this.request('initialize', {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'travel-assistant', version: '2.1.0' },
        });
        this.protocolVersion = result.protocolVersion || version;
        this.serverInfo = result.serverInfo || null;
        await this.notify('notifications/initialized');
        this.ready = true;
        return { protocolVersion: this.protocolVersion, serverInfo: this.serverInfo };
      } catch (error) {
        lastError = error;
        // 版本不被接受时试下一个；鉴权类错误则直接放弃
        if (/鉴权|401|403/.test(error.message)) throw error;
        this.sessionId = '';
      }
    }

    throw lastError || new Error(`${this.name} MCP 初始化失败`);
  }

  async ensureReady() {
    if (!this.ready) await this.initialize();
  }

  async listTools() {
    await this.ensureReady();
    const result = await this.request('tools/list', {});
    return Array.isArray(result.tools) ? result.tools : [];
  }

  /**
   * 调一个工具，把 MCP 的 content 数组压成模型好读的形态：
   * 单个 text 且内容是 JSON 就解析成对象，否则拼成字符串。
   */
  async callTool(name, args = {}) {
    await this.ensureReady();
    const result = await this.request('tools/call', { name, arguments: args });

    const contents = Array.isArray(result.content) ? result.content : [];
    const texts = contents.filter((item) => item && item.type === 'text').map((item) => item.text);
    let payload = texts.length === 1 ? texts[0] : texts.join('\n');

    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          payload = JSON.parse(trimmed);
        } catch {
          /* 不是 JSON 就保留原文 */
        }
      }
    }

    if (result.isError) {
      return { error: typeof payload === 'string' ? payload : JSON.stringify(payload) };
    }
    return payload;
  }
}

/**
 * 把 MCP 的工具注册进项目自己的 ToolRegistry。
 *
 * 命名统一加前缀，避免和已有工具（比如 weather）撞名；模型看到的名字本来就带前缀，
 * 也不会混淆两个数据源。
 */
function registerMcpTools(registry, client, { prefix = 'mcp__', allow = [] } = {}) {
  const filters = allow.map((item) => String(item).trim()).filter(Boolean);

  const matches = (toolName) =>
    !filters.length || filters.some((keyword) => toolName.toLowerCase().includes(keyword.toLowerCase()));

  return client.listTools().then((tools) => {
    const registered = [];
    for (const tool of tools) {
      if (!tool || !tool.name) continue;
      if (!matches(tool.name)) continue;

      const exposedName = `${prefix}${tool.name}`.slice(0, 64);
      registry.register({
        schema: {
          type: 'function',
          function: {
            name: exposedName,
            description: tool.description || `${client.name} 提供的 ${tool.name}`,
            parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
              ? tool.inputSchema
              : { type: 'object', properties: {} },
          },
        },
        handler: (args) => client.callTool(tool.name, args),
      });
      registered.push(exposedName);
    }
    return { registered, total: tools.length };
  });
}

module.exports = { McpClient, registerMcpTools, parseSseMessages, pickResponse, PROTOCOL_VERSIONS };
