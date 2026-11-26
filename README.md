# 坤坤 · 对话式旅行规划助手

> 把「会不会编」的问题，变成「能不能查」的问题：模型先调真实工具拿数据，再基于返回值组织语言。

在线演示：<http://travel.haomeng.me>（访问令牌见 `.env`，也可直接找我索取）

直接问模型「长沙岳麓山附近有什么好吃的」，它经常一本正经地编出不存在的地名和门店。
这个项目里所有事实都来自工具：地址、POI、路线、天气、火车票、航班；查不到就如实说「没查到」。

## 能做什么

| 能力 | 说明 |
|---|---|
| 地址解析 | 中文地址 → 经纬度 + 行政区划编码 |
| 地点检索 | 关键词搜酒店 / 餐厅 / 景点，返回名称、地址、坐标、电话 |
| 路线规划 | 驾车 / 步行 / 公交路线，含距离、耗时、分段指引 |
| 一键导航 | 结果自带高德深链（`amapuri://`）和 H5 兜底链接 |
| 实时天气 | 和风（实时 + 逐日 + 预警），未配置时退回高德实时值 |
| 地图配图 | `map_image` 生成静态地图，key 不出服务端（签名代理） |
| 火车 / 航班 | 飞常准 MCP 8 个工具：余票、票价、空铁联运、准点率 |
| 结构化卡片 | 车次 / 航班直接渲染成卡片，数字不经模型转述 |
| 导出飞书 | `export_to_feishu` 把行程单写成飞书云文档（可选） |
| 多轮对话 | sessionId 隔离，自动裁剪上下文，闲置回收 |
| 流式输出 | SSE 逐 token 推送，前端打字机效果 |
| 访问控制 | Bearer 令牌（定长比较）+ 按 IP 限流 + 断连即停 |

## 架构

```
浏览器（public/，原生 JS，无构建步骤）
   │  POST /api/chat/stream        ▲ SSE: session / card / delta / done
   ▼                               │
Express ── 令牌校验 → 限流 → Agent 循环（≤ 5 轮工具调用）
                                ├─ 高德：geocode / poi_search / route_planning / weather
                                ├─ 和风天气（可选，替换高德天气）
                                ├─ 静态地图（HMAC 签名代理，key 不下发）
                                ├─ 飞常准 MCP（8 个火车 / 航班工具，按需加载）
                                └─ 飞书云文档导出（可选）
```

两个实现上的要点：

- **流式 `tool_calls` 是分片到达的**：首片只有 `id` / `name`，`arguments` 是不断追加的字符串，`name` 还可能被拆成两片。所以按 `index` 累加，等流结束再统一 `JSON.parse` 并回填 `tool_call_id`。
- **工具按需加载（skill 包）**：工具涨到 15 个后，每轮全量下发 schema 约 4735 tokens，实测每轮浪费约 3800。改成基线 7 个工具 + 一个 `use_skill`，模型要查火车 / 航班时才加载整包；skill 是会话级的，同一会话不会重复加载。

## 目录结构

```
.
├── server.js            entry point: routes, auth, rate limit, SSE, lifecycle
├── src/
│   ├── config.js        env loading & validation
│   ├── agent.js         agent loop, streaming tool_calls merge, abort / timeout
│   ├── amap.js          four AMap tools + LRU cache
│   ├── amap-uri.js      AMap deep links (amapuri:// and web fallback)
│   ├── qweather.js      QWeather: current / daily / alerts
│   ├── static-map.js    signed static-map proxy (key stays server-side)
│   ├── feishu.js        Feishu doc export: create → convert → batch insert
│   ├── mcp-client.js    MCP client over Streamable HTTP: init / list / call
│   ├── ui-cards.js      tool results → front-end cards (train / flight)
│   ├── py-literal.js    Python literal parser (MCP returns repr, not JSON)
│   ├── tool-registry.js tool schema <-> handler mapping
│   ├── tool-skills.js   skill packs: baseline tools + on-demand loading
│   ├── tripmatch-format.js  normalize MCP results before the model sees them
│   ├── train-types.js   train type by 12306 prefix (G / D / Z / V ...)
│   ├── session.js       session store: trimming, TTL, eviction
│   ├── security.js      bearer token check + fixed-window rate limit
│   └── lru-cache.js     small LRU cache
├── public/              the only directory served to the outside
│   ├── index.html       page structure and styles
│   └── app.js           token storage / SSE parsing / export
├── test/smoke.js        offline unit + end-to-end tests
└── examples/            sample generated itinerary
```

`express.static` 只指向 `public/`：源码、`.env`、备份目录一律 404。

## 快速开始

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# 填入 AI_API_KEY 与 AMAP_KEY
npm run gen-token           # 生成 ACCESS_TOKEN（对公网才需要）
npm start
```

打开 <http://localhost:3000/index.html>。

| 密钥 | 获取地址 | 备注 |
|---|---|---|
| `AMAP_KEY` | <https://console.amap.com/dev/key/app> | 必须选 **Web 服务**，不要选 Web 端（JS API） |
| `AI_API_KEY` | 取决于用的模型服务 | 需要支持 `tools` 参数 |

## 环境变量

核心几项，完整清单见 `.env.example`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `NODE_ENV` | `development` | `production` 下强制要求 `ACCESS_TOKEN` |
| `AI_API_URL` / `AI_API_KEY` / `AI_MODEL` | — | 兼容 OpenAI 协议的任意端点，需支持 Function Calling |
| `AMAP_KEY` | — | 高德 Web 服务密钥（必填） |
| `QWEATHER_API_KEY` / `QWEATHER_BASE_URL` | — | 和风密钥与控制台分给你的 API Host，不填就用高德天气 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — | 填了才注册飞书导出工具 |
| `TRIPMATCH_API_KEY` | — | 飞常准 MCP Key，填了才接入火车 / 航班 |
| `TRIPMATCH_TOOL_ALLOW` | 空（全部） | 逗号分隔白名单，只注册需要的 MCP 工具 |
| `ACCESS_TOKEN` | 空（不鉴权） | 公网必填，`npm run gen-token` 可生成 |
| `TRUST_PROXY` | `false` | 在 Nginx / 云厂商反代后面必须开，否则限流会算成同一个 IP |

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/api/chat/stream` | 是 | SSE 流式对话 |
| `POST` | `/api/chat` | 是 | 非流式，返回 `{ reply, sessionId }` |
| `POST` | `/api/clear-history` | 是 | 清空指定会话（`sessionId` 必填） |
| `GET` | `/api/health` | 否 | 会话数、缓存、工具列表、是否需要令牌 |
| `GET` | `/api/staticmap` | HMAC 签名 | 静态地图代理，给 `<img>` 用 |

令牌两种传法：`Authorization: Bearer <token>`、`x-access-token: <token>`（前端 `apiFetch()` 自动注入）。
错误码：`401` 缺令牌、`403` 令牌错、`429` 触限流（带 `Retry-After`）。

SSE 事件：

```
event: session   data: {"sessionId":"abc123"}
event: card      data: {"type":"train-list","title":"火车票","rows":[...]}
event: delta     data: {"content":"岳"}
event: done      data: {"sessionId":"abc123","content":"完整回答"}
event: error     data: {"message":"错误原因"}
```

## 部署

最小组合：`NODE_ENV=production` + `ACCESS_TOKEN` + `TRUST_PROXY=true` + Nginx 关缓冲。

```nginx
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    off;   # SSE 必须关，否则看不到逐字效果
        proxy_cache        off;
        proxy_read_timeout 300s;
        gzip               off;
    }
}
```

```bash
npm install -g pm2
pm2 start server.js --name travel-assistant
```

上线自查：`/api/health` 返回 200；`/server.js`、`/.env` 必须 404；`POST /api/chat` 不带令牌必须 401。

## 测试

```bash
npm test
```

101 个用例全部离线，不要真实 key、不联网：假模型服务模拟 `tool_calls` 分片，假天气服务返回固定数据，再启动真实的 `server.js`，断言 SSE 事件序列、文本拼装、分片归并、`tool_call_id` 回填，以及「源码 / 密钥 / 备份目录都拿不到」。

## 设计取舍

- **不引 Agent 框架**：4 个工具、1 层循环，原生 `fetch` + 手写循环不到 60 行，比引框架好调。
- **数字不交给模型算**：车次类型按 12306 前缀判定，时长直接给成品，结构化结果渲染成卡片，回复从 1500+ 字降到 560 字。
- **MCP 返回不是 JSON**：飞常准返回 Python `repr()`，用 40 行递归下降解析器处理；正则替换单引号会打坏文本。
- **令牌不用 JWT**：单机、少量使用者，随机字符串 + 定长比较就够，泄露直接换 `.env` 重启。

## License

MIT
