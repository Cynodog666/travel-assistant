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
4. 当用户要求"打印版""规划表""行程单"时，输出一份完整的、可直接保存为 .html 的
   A4 旅行规划表（从 <!DOCTYPE html> 开始，到 </html> 结束），要求：
   - 尺寸 210mm × 297mm，四周留 10mm 打印边距
   - 用网格/表格排版，信息分区清晰，打印友好（浅底色、深色字、字号不小于 10pt）
   - 包含：标题区（目的地、日期、天数、天气）、每日行程表、交通信息、住宿餐饮、实用提示
   - 内联 CSS，不依赖外部资源，确保离线也能正常打开`;

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
