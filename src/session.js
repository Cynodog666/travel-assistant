'use strict';

/**
 * 会话存储（内存态）。
 *
 * 只保存成对的 user / assistant 消息，不保存中间的 tool 消息——
 * 这样裁剪历史时永远不会把「tool 消息」和它的「assistant.tool_calls」拆散，
 * 也就不会出现某些服务端报的 "tool message without preceding tool_calls"。
 */

const SYSTEM_PROMPT = `你是「坤坤」，一个中文旅行管家。

你可以调用以下工具获取真实数据：geocode（地址转坐标）、poi_search（搜地点）、
route_planning（规划路线）、weather（查天气）。

规则：
1. 涉及具体地点、距离、路线、天气时，必须先调用工具，不要凭记忆编造。
2. 工具返回错误时，如实告诉用户没查到，不要用编造的内容填补。
3. 回答简洁，用中文，重点信息用列表呈现。
4. 规划路线后，如果工具结果里有 navigation.appLink / navigation.webLink，
   把它们原样附在回答里，并说明「点击可直接导航」。不要把链接改写成别的形式。
5. 天气类问题用 weather 工具；它同时含实时、未来几天预报和气象预警，
   有预警时要明确提醒用户。
6. 用户想看地图、位置示意、某个景点在哪时，调用 map_image，
   并把它返回的 markdown 字段原样写进回答（前端会渲染成图片）。
7. 用户要求"导出到飞书""发我个文档链接""生成一篇可分享的行程单"时，
   调用 export_to_feishu：title 写清晰的标题；summary 写一句话概览；
   highlights 放 2-4 条关键信息（日期、天数、预算、天气提醒）；
   markdown 写正文，并**刻意写得好看一点**：
   - 每个板块用带 emoji 的二级标题，例如「## 📅 Day 1 · 12/04 · 多云」
   - 用无序列表承载信息，不要把内容全塞进表格
   - 表格最多 1-2 个，只用于预算明细、车次对比这类需要对齐的地方
   - 重要提醒单独成段，以 ⚠️ 开头
   最后把返回的 url 发给用户。
6. 用户想要的是一份**能看的行程单/规划表**时（例如"做个行程单""帮我规划一下""出行计划"），
   先组织好内容，然后调用 export_to_feishu 把它写成飞书文档，再把返回的 url 发给用户。
   这是默认做法，不要直接甩一段 HTML 给用户。
7. 只有当用户明确要求"打印版""要打印""保存成 html""离线能看"时，
   才输出完整的、可直接保存为 .html 的 A4 旅行规划表（从 <!DOCTYPE html> 开始，到 </html> 结束），要求：
   - 尺寸 210mm × 297mm，四周留 10mm 打印边距
   - 用网格/表格排版，信息分区清晰，打印友好（浅底色、深色字、字号不小于 10pt）
   - 包含：标题区（目的地、日期、天数、天气）、每日行程表、交通信息、住宿餐饮、实用提示
   - 内联 CSS，不依赖外部资源，确保离线也能正常打开
8. 如果调用 export_to_feishu 失败（返回 error），如实说明原因，再退回到 HTML 或纯文本方案，
   不要假装已经导出成功。
9. 车次、航班、车站这类列表，界面会自动渲染成卡片（含车次号、时刻、票价、余票、准点率）。
   所以你不要再把明细整整齐齐复述一遍，只给结论、取舍建议、和需要提醒的点
   （比如"二等座已售罄""机票不含税费"）。数据一律以工具返回为准，不要自己补数字。
10. 交通类工具（火车票、航班、空铁联运）默认没有常驻。用户问这些时，先调用 use_skill
    并把 skill 设为 tripmatch，加载成功后再调用具体工具；已经加载过的会话不用重复加载。
11. 火车票结果里的 trainType / highSpeed 是系统按车次号判定的，**直接使用，不要自己推测**：
    G 高铁 / C 城际 / D 动车 / S 市域 算高铁动车；Z 直达特快 / T 特快 / K 快速 / V 普速 /
    纯数字 普快 都算普速列车。绝对不要把普速夜车说成高铁，也不要说"高铁有卧铺"。
12. 车次时长直接用返回里的 duration 字段（形如 3h37m），**不要自己用到达时间减出发时间**，
    跨天、整点附近很容易算错。票价和余票也只引用字段值。`;

class SessionStore {
  constructor({ maxSessions = 500, maxHistoryTurns = 20, ttlMs = 0, systemPrompt = SYSTEM_PROMPT } = {}) {
    this.maxSessions = maxSessions;
    this.maxHistoryTurns = maxHistoryTurns;
    this.ttlMs = ttlMs;
    this.systemPrompt = systemPrompt;
    this.sessions = new Map();
  }

  /** 取出会话（不存在则创建），顺手做一次过期淘汰和容量淘汰。 */
  touch(sessionId) {
    this.prune();

    let session = this.sessions.get(sessionId);
    if (session) {
      // 删掉再插回，让 Map 的插入顺序≈最近使用顺序，淘汰时才是真的淘汰最久没动的
      this.sessions.delete(sessionId);
    } else {
      session = {
        messages: [{ role: 'system', content: this.systemPrompt }],
        // 本会话已加载的工具 skill 包里的工具名；由 use_skill 追加
        activeSkills: new Set(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    session.updatedAt = Date.now();
    this.sessions.set(sessionId, session);

    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }

    return session;
  }

  /** 只取消息快照，用于拼装本轮请求：不要直接改它，落库走 appendTurn。 */
  history(sessionId) {
    return this.touch(sessionId).messages;
  }

  /** 只看不建：按需加载工具时要读会话状态，但不能因此新建会话。 */
  peek(sessionId) {
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /**
   * 一轮成功对话之后才落库。
   * 流式失败、客户端中途断开都不写，避免留下「用户问了但没答」的残缺历史。
   */
  appendTurn(sessionId, userContent, assistantContent) {
    const session = this.touch(sessionId);
    const next = [
      ...session.messages,
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ];
    const system = next[0];
    const rest = next.slice(1).slice(-this.maxHistoryTurns * 2);
    session.messages = [system, ...rest];
    return session;
  }

  delete(sessionId) {
    return this.sessions.delete(sessionId);
  }

  clear() {
    this.sessions.clear();
  }

  /** 清掉超过 TTL 没动过的会话；ttlMs <= 0 时不做任何事。 */
  prune(now = Date.now()) {
    if (!this.ttlMs) return 0;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = { SessionStore, SYSTEM_PROMPT };
