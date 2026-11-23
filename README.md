# 坤坤 · 对话式旅行规划助手

> 一个能真正"查数据"而不是"编数据"的旅行 Agent：用 Function Calling 调度高德地图开放平台的
> 地理编码 / POI 检索 / 路径规划 / 天气四类工具，并通过 SSE 把模型的回答逐字推送到前端。

---

## 这个项目解决什么问题

直接问大模型"长沙岳麓山附近有什么好吃的"，它经常一本正经地编出不存在的地名和门店。

这个项目的做法是：**把"会不会编"的问题，变成"能不能查"的问题**。

模型不再凭记忆回答，而是先调用真实的工具拿到数据，再基于工具返回值组织语言。工具返回空结果或报错时，
它会如实告诉用户"没查到"，而不是用编造的内容填补。

---

## 功能

| 能力 | 说明 |
|---|---|
| 地址解析 | 中文地址 → 经纬度 + 行政区划编码 |
| 地点检索 | 按关键词搜酒店 / 餐厅 / 景点，返回名称、地址、坐标、电话 |
| 路线规划 | 两地点之间的驾车 / 步行路线，含距离、耗时、分段指引 |
| 实时天气 | 按城市查询当前天气、温度、风力、湿度；配了和风后升级为「实时 + 逐日预报 + 气象预警」 |
| 一键导航 | 路线规划结果自带高德深链（`amapuri://`）和 H5 链接，点一下直接开始导航 |
| 地图配图 | `map_image` 工具生成静态地图，回答里直接出图（高德 key 不出服务端） |
| 多轮对话 | 基于 sessionId 隔离会话，自动裁剪上下文控制 token，闲置超时自动回收 |
| 流式输出 | SSE 逐 token 推送，前端打字机效果 |
| 接口缓存 | 高德请求走 LRU 缓存，重复查询不打外部接口 |
| 访问控制 | Bearer 令牌 + 定长比较，前端有令牌输入层；令牌错/缺失一律拒绝 |
| 限流 | 按 IP 的固定窗口限流，防止被刷爆模型和高德配额 |
| 断连即停 | 用户关页面立刻中断上游模型请求，不再白跑完整条 Agent 循环 |
| 行程单导出 | 要求"打印版"时，模型直接输出可保存为 .html 的 A4 规划表 |

### 示例输出

`examples/sample-plan.html` 是模型生成的 A4 行程单样例，浏览器直接打开可以看打印效果
（里面的地点和价格为示例数据，不是实时查询结果）。

---

## 架构

```
┌──────────────────┐   POST /api/chat/stream   ┌──────────────────────────────────────┐
│     浏览器       │ ────────────────────────► │  Express                             │
│ public/index.html│ ◄──────────────────────── │                                      │
└──────────────────┘   SSE: delta / done       │  ① 响应头 + 静态（只托管 public/）    │
                                              │  ② Bearer 令牌校验 → 401/403         │
                                              │  ③ 按 IP 限流 → 429                  │
                                              │  ④ Agent 循环 (最多 5 轮)            │
                                              │      streamChatCompletion()          │
                                              │        ↓ 流式读取 tool_calls 增量    │
                                              │      有工具调用？                    │
                                              │        ├─ 是 → amap.run() → 回填     │
                                              │        └─ 否 → 返回最终回答          │
                                              └───────────────┬──────────────────────┘
                                                              │
                                       ┌──────────────────────▼───────────────────┐
                                       │  高德开放平台 Web 服务 API               │
                                       │  geocode / place / direction / weather   │
                                       └──────────────────────────────────────────┘
```

### Agent 循环的关键点

模型在流式返回时，`tool_calls` 是**分片到达**的：第一片只有 `id` 和 `name`，后续片不断追加
`arguments` 的字符串片段。所以不能直接 `JSON.parse`，必须按 `index` 把同名分片累加起来，
等整个流结束才是完整的 JSON。

```js
// 按 index 归并分片
const index = call.index ?? 0;
toolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
toolCalls[index].function.arguments += call.function.arguments; // 字符串拼接，不是覆盖
```

这一步是这类项目最容易写错的地方，也是面试常问的点。`name` 同理——有的服务会把它也拆成
`"wea"` + `"ther"` 两片，直接赋值就会拿到一个不存在的工具名。

---

## 目录结构

```
.
├── server.js            服务入口：路由、鉴权、限流、SSE、生命周期
├── src/
│   ├── config.js        环境变量集中读取与校验
│   ├── agent.js         Agent 循环 + 流式 tool_calls 归并 + 中断/超时
│   ├── amap.js          高德四类工具与缓存
│   ├── amap-uri.js      高德 URI：把路线变成可点击的导航链接
│   ├── qweather.js      和风天气：实时 / 预报 / 预警（可选，按配置替换高德天气）
│   ├── static-map.js    静态地图：签名 URL + 服务端代理取图
│   ├── tool-registry.js 工具注册表：schema 与 handler 的映射
│   ├── session.js       会话存储：裁剪、TTL、容量淘汰
│   ├── security.js      令牌校验 + 限流
│   └── lru-cache.js     LRU 缓存
├── public/              唯一对外托管的目录
│   ├── index.html       页面结构 + 样式
│   └── app.js           令牌管理 / SSE 解析 / 导出（无构建步骤）
├── test/smoke.js        单元 + 端到端测试，不依赖外网
└── examples/            模型生成的行程单样例
```

**重要**：`express.static` 只指向 `public/`。以前它指向项目根目录，`/server.js`、`/package.json`、
旧备份目录里的源码都能被直接下载，其中还躺着一把明文密钥——这个坑下面还会再提一次。

---

## 工具与天气实现

交给模型的工具由 `src/tool-registry.js` 组装，**同名工具只允许有一个**，避免模型在两个都能
"查天气"的工具之间摇骰子：

| 工具 | 来源 | 说明 |
|---|---|---|
| `geocode` | 高德 | 地址 → 经纬度 + adcode |
| `poi_search` | 高德 | 关键词搜地点 |
| `route_planning` | 高德 | 路线 + **导航链接**（appLink / webLink） |
| `weather` | 和风 **或** 高德 | 配了 `QWEATHER_API_KEY` + `QWEATHER_BASE_URL` 就和风，否则退回高德实时值 |
| `map_image` | 高德 | 地点或坐标 → 静态地图 PNG，返回 markdown 图片，前端直接渲染 |

和风那条路是这样走的（v1 接口，和高德那套"城市名直接查"不同）：

```
城市名 ──/geo/v2/city/lookup──► 经纬度 + LocationID
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
  /weather/v1/current      /weather/v1/daily          /weatheralert/v1/current
  实时（温度/体感/风/UV）    逐日预报（1-10 天）          正在生效的气象预警
```

几个实现上的选择：

- **实时数据必须成功，预报和预警允许失败**。预报挂了只记 `forecastError`，预警挂了记
  `alertsError`，别让一个次要接口把整个天气查询变成报错。
- **字段做了裁剪和单位统一**（℃ / % / mm），原始响应字段太多，直接塞给模型既费 token
  又容易读错。
- **鉴权走 `X-QW-Api-Key` 头**，不用 JWT——和风两种方式不能混用，API KEY 更简单。
  注意 2027 年起和风会对 API KEY 的每日请求量做限制，届时再换 JWT（Ed25519 签名）。
- **只用和风自己的经纬度**，不把高德的 GCJ-02 坐标传过去，省掉坐标系偏移那一堆事。

`route_planning` 返回的链接长这样（`t=0` 驾车、`t=1` 公交、`t=2` 步行、`t=3` 骑行）：

```
appLink: amapuri://route/plan/?slat=39.909&slon=116.397&sname=天安门&...
webLink: https://uri.amap.com/navigation?from=116.397,39.909,天安门&to=...&mode=car
```

`appLink` 只有装了高德 App 的手机能唤醒，`webLink` 是万能的 H5 兜底，所以两个都给。
前端 `renderMarkdown` 会把裸链接转成可点的 `<a>`，否则手机上根本点不动。

### 静态地图为什么走签名代理

高德静态图接口的 URL 里带 `key`。如果把原始 URL 直接返回给前端，key 就白纸黑字躺在
页面源码和聊天记录里了——这和之前"静态目录泄露源码"是同一类错误，只是更隐蔽。

所以流程改成：

```
map_image 工具 ──► 服务端用 HMAC 签一个 /api/staticmap?location=...&exp=...&sig=...
                            │
浏览器 <img src=...> ───────┘   （img 请求带不了 Authorization 头，签名就代替了它）
                            ▼
                  校验 sig + exp → 带着 key 去高德取图 → 直接把 PNG 流回去
```

几个细节：

- 签名串是「排序后的查询参数 + exp」，`exp` 和 `sig` 本身不参与计算，否则校验时会把 `exp` 拼两遍。
- 参数只要被改一个字节（比如把 `zoom` 从 14 改成 15），签名就对不上 → 403。所以服务端可以放心
  信任这些参数，不需要再做一堆入参校验。
- 有效期默认 1 小时。注意：**导出的 .html 行程单里如果嵌了地图，1 小时后图会失效**，
  要长期保存需要在导出时把图片转成 base64 内联。
- 400/500 时高德返回的是 JSON 而不是图片，代理会识别出来转成 502，而不是把一段 JSON 当 PNG 吐给浏览器。

---

## 技术栈

- **后端**：Node.js 18+ / Express 5
- **模型**：任意兼容 OpenAI Chat Completions 协议的服务（OpenAI、通义、DeepSeek 等）
- **地图**：高德开放平台 Web 服务 API
- **前端**：原生 HTML / CSS / JS，无构建步骤，无外部字体和 CDN 依赖
- **传输**：SSE（Server-Sent Events）

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置密钥
copy .env.example .env     # Windows
# cp .env.example .env     # macOS / Linux

# 3. 编辑 .env，填入 AI_API_KEY 和 AMAP_KEY
# 4. 如果要对公网开放，再生成并填入 ACCESS_TOKEN：
npm run gen-token

# 5. 启动
npm start
```

打开 http://localhost:3000/index.html

### 密钥申请

| 密钥 | 获取地址 | 说明 |
|---|---|---|
| `AMAP_KEY` | https://console.amap.com/dev/key/app | 新建应用时选 **Web服务** 类型，不要选 Web端(JS API) |
| `AI_API_KEY` | 取决于你用哪家模型 | 需要支持 `tools` 参数 |

---

## 访问控制

接口默认要求令牌，三种传法任选其一：

```
Authorization: Bearer <ACCESS_TOKEN>
x-access-token: <ACCESS_TOKEN>
```

浏览器端不需要手动拼——`public/app.js` 里统一由 `apiFetch()` 注入，本地存在
`localStorage.travelAccessToken`。首次打开时前端会请求一次 `/api/health`，
若服务端声明 `authRequired: true` 且本地没令牌，就会先弹令牌输入层。

| 状态码 | 含义 |
|---|---|
| `401` | 没带令牌（`TOKEN_MISSING`） |
| `403` | 令牌不对（`TOKEN_INVALID`） |
| `429` | 触发限流，响应带 `Retry-After` |

`ACCESS_TOKEN` 留空等于关闭鉴权，**只适合本机自用**；`NODE_ENV=production` 且没设令牌时
进程会直接拒绝启动，避免一个手滑就把额度公开出去。

---

## 手机访问

前端全部使用相对路径（`/api/chat/stream`、`/api/clear-history`），所以手机只要连到这台电脑，
打开局域网地址就能用，不需要改任何代码。

1. 手机和电脑连**同一个 Wi-Fi**（手机别用流量）
2. `npm start`，终端会直接打印可用地址：

```
服务器已启动，模型: deepseek-chat
访问令牌: 已启用
限流: 20 次 / 60 秒 / IP
本机访问:   http://localhost:3000/index.html

局域网访问（手机与电脑连同一个 Wi-Fi）:
  http://192.168.1.7:3000/index.html
```

3. 手机浏览器打开那个 `192.168.x.x` 的地址，输入 `ACCESS_TOKEN` 即可

### 手机打不开怎么办

按顺序排查：

| 现象 | 处理 |
|---|---|
| 手机白屏 / 转圈超时 | Windows 防火墙拦了。管理员 PowerShell 执行：`netsh advfirewall firewall add rule name="travel-assistant" dir=in action=allow protocol=TCP localport=3000` |
| 手机能开页面，但发消息没反应 | 说明静态文件通了但接口没通，先确认 `/api/health` 能返回 JSON |
| 一直提示令牌不正确 | 手机浏览器缓存了旧令牌，清一下站点数据或换个浏览器 |
| 地址正确但连不上 | 很多公司/学校 Wi-Fi 开了「AP 隔离」，设备之间不能互访，换手机热点试 |

---

## 部署到公网

最小可用组合：`ACCESS_TOKEN` + `TRUST_PROXY=true` + Nginx 关缓冲。

### 1. 环境变量（必须）

```bash
NODE_ENV=production
ACCESS_TOKEN=<用 npm run gen-token 生成>
TRUST_PROXY=true          # 在 Nginx / Railway / Render 后面就要开
```

- 不设 `ACCESS_TOKEN`：`production` 下直接启动失败（这是故意的）。
- 不开 `TRUST_PROXY`：所有请求的 `req.ip` 都是反代的地址，限流会变成"全体用户共用一个额度"。

### 2. Nginx 反代

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

        # SSE 关键：不缓冲、不压缩、长连接
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 300s;
        gzip               off;
    }
}
```

代码里已经带了 `X-Accel-Buffering: no` 和 `Cache-Control: no-transform`，但把
`proxy_buffering off` 写进配置更保险——否则正文会攒够一波才吐出来，看不到逐字效果。

### 3. 进程守护

```bash
npm install -g pm2
pm2 start server.js --name travel-assistant
pm2 logs travel-assistant
```

`SIGINT` / `SIGTERM` 会优雅关闭：先停止接受新连接，5 秒内没退干净再强退。

### 4. 上线后自查

```bash
curl -i https://your-domain.com/api/health          # 200 + "authRequired": true
curl -i https://your-domain.com/server.js           # 必须 404
curl -i https://your-domain.com/.env                # 必须 404
curl -i -X POST https://your-domain.com/api/chat \
     -H 'Content-Type: application/json' \
     -d '{"message":"长沙天气","sessionId":"selfcheck-001"}'   # 必须 401
```

---

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `3000` | 服务端口 |
| `NODE_ENV` | 否 | `development` | `production` 时强制要求 `ACCESS_TOKEN` |
| `AI_API_URL` | 否 | OpenAI 官方地址 | 兼容 OpenAI 协议的任意端点 |
| `AI_API_KEY` | **是** | — | 模型密钥 |
| `AI_MODEL` | 否 | `gpt-4o-mini` | 必须支持 Function Calling |
| `AI_TEMPERATURE` | 否 | `0.7` | 采样温度 |
| `AI_TIMEOUT_MS` | 否 | `60000` | 单次模型调用超时 |
| `AMAP_KEY` | **是** | — | 高德 Web 服务密钥 |
| `AMAP_BASE_URL` | 否 | `https://restapi.amap.com` | 走代理或测试时改这里 |
| `AMAP_TIMEOUT_MS` | 否 | `8000` | 高德接口超时 |
| `AMAP_CACHE_SIZE` | 否 | `200` | 高德接口缓存条数 |
| `QWEATHER_API_KEY` | 否 | — | 和风天气 API Key；不填就用高德自带的实时天气 |
| `QWEATHER_BASE_URL` | 配和风时必填 | — | 控制台「设置」里分给你的 API Host，前面补 `https://`（别照抄文档里的示例地址） |
| `QWEATHER_TIMEOUT_MS` | 否 | `8000` | 和风接口超时 |
| `STATICMAP_SECRET` | 否 | 复用 `ACCESS_TOKEN` / `AMAP_KEY` | 静态图链接的签名密钥，想单独轮换时设置 |
| `ACCESS_TOKEN` | 公网必填 | 空（不鉴权） | 接口访问令牌 |
| `TRUST_PROXY` | 反代后必填 | `false` | 信任 `X-Forwarded-For` |
| `RATE_LIMIT_MAX` | 否 | `20` | 每 IP 每窗口最大请求数 |
| `RATE_LIMIT_WINDOW_MS` | 否 | `60000` | 限流窗口长度 |
| `MAX_TOOL_STEPS` | 否 | `5` | 单轮对话最多几轮工具调用 |
| `MAX_HISTORY_TURNS` | 否 | `20` | 每会话保留最近多少轮 |
| `MAX_SESSIONS` | 否 | `500` | 内存里最多保留多少会话 |
| `SESSION_TTL_MS` | 否 | `7200000` | 会话闲置多久回收 |

---

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/api/chat` | 是 | 非流式，返回 `{ reply, sessionId }` |
| `POST` | `/api/chat/stream` | 是 | SSE 流式，事件类型见下 |
| `POST` | `/api/clear-history` | 是 | 清空**指定**会话，`sessionId` 必填 |
| `GET` | `/api/health` | 否 | 健康检查：会话数、缓存条目数、天气实现、工具列表、是否需要令牌 |
| `GET` | `/api/staticmap` | HMAC 签名 | 静态地图代理，给 `<img>` 用；参数被改或签名过期一律 403 |

旧的 `/chat`、`/chat/stream`、`/clear-history` 仍然可用（同一套处理器），方便老脚本无痛迁移。

### SSE 事件

```
event: session   data: {"sessionId":"abc123"}
event: delta     data: {"content":"岳"}          ← 逐 token，前端拼接
event: done      data: {"sessionId":"abc123","content":"完整回答"}
event: error     data: {"message":"错误原因"}
```

`done` 事件里带完整文本，前端以它为准兜底：万一某个 delta 丢了，最终内容还拼得回来。

### 清空语义

`/api/clear-history` 必须带 `sessionId`，只删这一个会话；缺参数直接 400。

这是修掉的一个真 bug：旧版前端在发请求前就把 `sessionId` 置成了 `null`，而旧版后端把
"没传 sessionId" 理解成**清空全部会话 + 清空所有缓存**。单机自用看不出来，一旦多人共用，
别人点一下"清空"就能把你的上下文删干净。

---

## 设计取舍

**为什么不用 LangChain？**
这个规模的项目只有 4 个工具、1 层循环，直接用原生 `fetch` + 手写循环，代码量不到 60 行，
反而比引入框架更容易调试。工具多了、要接 RAG 或做多 Agent 协作时，再上框架。

**为什么缓存放在工具层而不是接口层？**
缓存 key 是「服务名 + 参数」，命中粒度比接口级缓存细。同一轮对话里模型可能用不同措辞问同一个
地点，工具层的参数化 key 更容易命中。

**为什么保留非流式的 `/chat`？**
方便脚本测试和 curl 调试，也作为流式接口出问题时的降级路径。

**为什么令牌不用 JWT？**
这个项目只有一个使用方（你自己或几个朋友），不需要签发、刷新、过期、吊销那一套。
一个随机字符串 + 定长比较就够了，密钥泄露直接换 `.env` 重启即可。
真要多人注册登录，那是另一个量级的系统，不该塞进这个项目里。

**为什么限流是手写的固定窗口？**
不引依赖，20 行内可审计。`Map` + LRU 保证 key 数量有上限，不会被伪造 IP 撑爆内存。
缺点是单机、不够精确（窗口边界会放过最多 2 倍请求）；多实例部署时应换 Redis 或网关限流。

---

## 测试

```bash
npm test
```

分两层，**不需要真实模型 key、地图/天气 key 和外网**，可以放进 CI：

1. **单元测试**：LRU 淘汰顺序、会话裁剪（保证 system 保留且消息成对）、限流命中与拒绝、
   令牌定长比较、缺密钥/缺 API Host 时的配置校验、工具注册表（重名拒绝、按名分发、未知工具）、
   导航链接生成（经纬度、`t=0/t=2`、中文名编码）、高德 `weather` 与带导航的 `route_planning`、
   和风天气的字段整形与「预警接口失败时降级」；
2. **端到端**：起一个假模型服务（模拟 `tool_calls` 分片）+ 一个假和风天气服务（通过
   `QWEATHER_BASE_URL` 指过去），启动真实 `server.js`，然后断言：
   - 静态目录里拿不到 `server.js`、`.env`、备份目录；
   - 无令牌 401、错令牌 403、非法 sessionId 400；
   - SSE 事件序列 `session → delta… → done`、文本拼装完整；
   - `tool_calls.function.name` 和 `arguments` 都按 index 正确归并；
   - 工具结果带正确的 `tool_call_id` 回填，且确实走了和风链路（带回预报与预警）；
   - 发给模型的工具列表里**只有一个 weather**，且已切换成和风版本；
   - 清空指定会话只影响那一个会话。

```
  PASS  会话裁剪保留 system 且消息成对
  PASS  只填和风 key 不填 API Host 时报错并给出提示
  PASS  导航链接：深链是 amapuri:// 且带经纬度
  PASS  高德 route_planning：结果里带可点击的导航链接
  PASS  和风 weather：温度四舍五入、湿度转百分比  → 22.4℃ / 69%
  PASS  和风 weather：预警接口失败时降级但保留实时数据
  PASS  静态目录只暴露 public（源码/密钥/备份均 404）
  PASS  工具结果走了和风链路并带回预报与预警  → now=多云 forecast=2 alerts=1
  PASS  清空只删自己那一个会话  → 2 → 1
  …
结果：56 通过 / 0 失败
```

---

## 踩过的坑

1. **`tool_calls` 分片**：见上文，不按 index 归并就会得到一堆残缺的 JSON；`name` 也可能被拆片。
2. **高德的错误不是 HTTP 错误码**：HTTP 200 + `status: "0"` 才是失败，必须判 `data.status`。
3. **`weather` 接口要的是 adcode 不是城市名**：得先调 geocode 拿到 `adcode` 再查天气。
4. **SSE 被中间层缓冲**：加了 `X-Accel-Buffering: no` 和 `Cache-Control: no-transform`，
   否则 Nginx 一类的反代会攒够一波才吐出来，看不到逐字效果。
5. **密钥泄露**：第一版把 key 写死在 `server.js` 里，传上 GitHub 后才发现。现在全部走 `.env`，
   并用 `.gitignore` 排除。
6. **静态目录开太大**：第二版用 `express.static(__dirname)`，本意是托管 `index.html`，实际把
   `/server.js`、`/package.json`、`/_backup_v1/server.js` 全吐出去了——备份文件里还有一把明文 key。
   现在只托管 `public/`，并加了测试盯着这条线。
7. **清空按钮会误伤别人**：见「清空语义」一节。
8. **用户关页面后上游还在跑**：SSE 写不回去也不会报错，模型调用和高德请求照常烧钱。
   现在用 `res.on('close')` + `AbortController` 一路传到 `fetch` 和 `axios`。
9. **和风天气换了两套接口**：网上教程大多是旧的 `devapi.qweather.com + key 参数 + 城市名`，
   现在必须是「控制台分配的专属 API Host + `X-QW-Api-Key` 头 + 先做城市搜索拿经纬度」。
   照着老教程写会一直 401，而且 API KEY 和 JWT 两种鉴权不能混着用。
10. **`URLSearchParams` 会把空格编成 `+`**：地图 URI 的参数是普通查询串，`+` 不会被解成空格，
    起名带空格的地点就会定位失败。这里改用 `encodeURIComponent` 手动拼。
11. **静态图不能把带 key 的 URL 给前端**：改成 HMAC 签名 URL + 服务端代理取图，`<img>` 也因此
    不需要带 Authorization 头。
12. **签名里别把 `exp` 又拼一遍**：`sig = HMAC(排序参数 + exp)`，如果 `exp` 同时还留在排序参数里，
    校验时就会变成 `exp` 出现两次，自己签的自己验不过——这次就是这么写出 bug 的，测试立刻抓到了。

---

## Roadmap

- [x] 端到端冒烟测试（`npm test`，不依赖外网）
- [x] 访问令牌 + 限流 + 静态目录白名单
- [x] 客户端断开即中断上游
- [x] 会话按 id 清空、闲置会话自动回收
- [x] 和风天气（实时 + 预报 + 预警）与高德实时天气的按配置切换
- [x] 路线结果带一键导航链接（`amapuri://` + H5 兜底）
- [x] 静态地图配图（签名 URL + 服务端代理，key 不出服务端）
- [ ] 接入 RAG：把旅游攻略文档入库，回答时引用出处
- [ ] 工具结果加上结构化展示（地图卡片、路线图）
- [ ] 会话持久化（当前是内存态，重启即清空；多实例需要 Redis）
- [ ] 高德返回 mock 的异常分支单测（`status: "0"`、空结果、超时）

---

## License

MIT
