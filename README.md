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
| 实时天气 | 按城市查询当前天气、温度、风力、湿度 |
| 多轮对话 | 基于 sessionId 隔离会话，自动裁剪上下文控制 token |
| 流式输出 | SSE 逐 token 推送，前端打字机效果 |
| 接口缓存 | 高德请求走 LRU 缓存，重复查询不打外部接口 |
| 行程单导出 | 要求"打印版"时，模型直接输出可保存为 .html 的 A4 规划表 |

---

### 示例输出

`examples/sample-plan.html` 是模型生成的 A4 行程单样例，浏览器直接打开可以看打印效果
（里面的地点和价格为示例数据，不是实时查询结果）。

---

## 架构

```
┌──────────────┐   POST /chat/stream    ┌──────────────────────────────────────┐
│   浏览器     │ ─────────────────────► │  Express                             │
│  index.html  │ ◄───────────────────── │                                      │
└──────────────┘   SSE: delta / done    │  ┌────────────────────────────────┐  │
                                       │  │ Agent 循环 (最多 5 轮)         │  │
                                       │  │                                │  │
                                       │  │  1. streamChatCompletion()     │  │
                                       │  │     ↓ 流式读取 tool_calls 增量 │  │
                                       │  │  2. 有工具调用？               │  │
                                       │  │     ├─ 是 → runTool() → 回填   │  │
                                       │  │     └─ 否 → 返回最终回答       │  │
                                       │  └────────────┬───────────────────┘  │
                                       │               │                      │
                                       │      ┌────────▼─────────┐            │
                                       │      │  LRUCache (200)  │            │
                                       │      └────────┬─────────┘            │
                                       └───────────────┼──────────────────────┘
                                                       │
                                     ┌─────────────────▼──────────────────┐
                                     │  高德开放平台 Web 服务 API          │
                                     │  geocode / place / direction /     │
                                     │  weather                           │
                                     └────────────────────────────────────┘
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

这一步是这类项目最容易写错的地方，也是面试常问的点。

---

## 技术栈

- **后端**：Node.js 18+ / Express 5
- **模型**：任意兼容 OpenAI Chat Completions 协议的服务（OpenAI、通义、DeepSeek 等）
- **地图**：高德开放平台 Web 服务 API
- **前端**：原生 HTML / CSS / JS，无构建步骤
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

# 4. 启动
npm start
```

打开 http://localhost:3000/index.html

### 密钥申请

| 密钥 | 获取地址 | 说明 |
|---|---|---|
| `AMAP_KEY` | https://console.amap.com/dev/key/app | 新建应用时选 **Web服务** 类型，不要选 Web端(JS API) |
| `AI_API_KEY` | 取决于你用哪家模型 | 需要支持 `tools` 参数 |

---

## 手机访问

前端全部使用相对路径（`/chat/stream`、`/clear-history`），所以手机只要连到这台电脑，
打开局域网地址就能用，不需要改任何代码。

1. 手机和电脑连**同一个 Wi-Fi**（手机别用流量）
2. `npm start`，终端会直接打印可用地址：

```
服务器已启动，模型: deepseek-chat
本机访问:   http://localhost:3000/index.html

手机访问（手机与电脑连同一个 Wi-Fi）:
  http://192.168.1.7:3000/index.html
```

3. 手机浏览器打开那个 `192.168.x.x` 的地址

### 手机打不开怎么办

按顺序排查：

| 现象 | 处理 |
|---|---|
| 手机白屏 / 转圈超时 | Windows 防火墙拦了。管理员 PowerShell 执行：`netsh advfirewall firewall add rule name="travel-assistant" dir=in action=allow protocol=TCP localport=3000` |
| 手机能开页面，但发消息没反应 | 说明静态文件通了但接口没通，检查是不是还残留着 `http://localhost:3000` 的硬编码地址 |
| 地址正确但连不上 | 很多公司/学校 Wi-Fi 开了「AP 隔离」，设备之间不能互访，换手机热点试 |
| 终端没打印局域网地址 | 电脑没连局域网，或只有 `127.0.0.1` |

### 想放到公网

局域网只能自己用。要给别人（比如面试官）一个能点开的链接，需要部署到公网，可选：

- **Railway / Render**：免费额度够跑这种小服务，绑定 GitHub 仓库自动部署
- **自己的云服务器**：`nginx` 反代 + `pm2` 守护，注意 SSE 要关掉缓冲（`proxy_buffering off`）

部署后记得把 `.env` 里的密钥配到平台的环境变量里，**不要把 `.env` 提交进仓库**。

---

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `3000` | 服务端口 |
| `AI_API_URL` | 否 | OpenAI 官方地址 | 兼容 OpenAI 协议的任意端点 |
| `AI_API_KEY` | **是** | — | 模型密钥 |
| `AI_MODEL` | 否 | `gpt-4o-mini` | 必须支持 Function Calling |
| `AI_TEMPERATURE` | 否 | `0.7` | 采样温度 |
| `AMAP_KEY` | **是** | — | 高德 Web 服务密钥 |

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/chat` | 非流式，返回 `{ reply, sessionId }` |
| `POST` | `/chat/stream` | SSE 流式，事件类型见下 |
| `POST` | `/clear-history` | 清空指定会话（不传 sessionId 则清空全部） |
| `GET` | `/health` | 健康检查，返回会话数与缓存条目数 |

### SSE 事件

```
event: session   data: {"sessionId":"abc123"}
event: delta     data: {"content":"岳"}          ← 逐 token，前端拼接
event: done      data: {"sessionId":"abc123","content":"完整回答"}
event: error     data: {"message":"错误原因"}
```

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

---

## 测试

```bash
npm test
```

`test/smoke.js` 会起一个假的 OpenAI 兼容服务，模拟「模型先返回 tool_calls 分片、拿到工具结果后再
输出正文」的完整两轮对话，然后断言 SSE 事件序列、文本拼装、`tool_calls` 归并结果和
`tool_call_id` 回填是否正确。

**不需要真实模型 key、高德 key 或外网**，所以可以放进 CI。

```
  PASS  收到 session 事件
  PASS  收到多个 delta 分片  → 实际 14 个
  PASS  tool_calls.arguments 按 index 正确归并  → 实际 {"city":"长沙"}
  PASS  工具结果带正确 tool_call_id 回填  → tool_call_id=call_abc
```

---

## 踩过的坑

1. **`tool_calls` 分片**：见上文，不按 index 归并就会得到一堆残缺的 JSON。
2. **高德的错误不是 HTTP 错误码**：HTTP 200 + `status: "0"` 才是失败，必须判 `data.status`。
3. **`weather` 接口要的是 adcode 不是城市名**：得先调 geocode 拿到 `adcode` 再查天气。
4. **SSE 被中间层缓冲**：加了 `X-Accel-Buffering: no` 和 `Cache-Control: no-transform`，
   否则 Nginx 一类的反代会攒够一波才吐出来，看不到逐字效果。
5. **密钥泄露**：第一版把 key 写死在 `server.js` 里，传上 GitHub 后才发现。现在全部走 `.env`，
   并用 `.gitignore` 排除。

---

## Roadmap

- [ ] 接入 RAG：把旅游攻略文档入库，回答时引用出处
- [ ] 工具结果加上结构化展示（地图卡片、路线图）
- [x] 端到端冒烟测试（`npm test`，不依赖外网）
- [ ] 工具层单元测试（把高德返回 mock 掉，覆盖 `status: "0"` 等异常分支）
- [ ] 会话持久化（当前是内存态，重启即清空）

---

## License

MIT
