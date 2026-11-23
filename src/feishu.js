'use strict';

/**
 * 飞书云文档导出。
 *
 * 整个流程用官方推荐的「三段式」，而不是自己拼 block：
 *   1. 创建空文档            POST /open-apis/docx/v1/documents
 *   2. Markdown → blocks     POST /open-apis/docx/v1/documents/blocks/convert
 *   3. blocks 批量插入文档    POST /open-apis/docx/v1/documents/{id}/blocks/{id}/descendant
 *
 * 为什么不用手写转换器：convert 接口本身就支持标题/列表/引用/代码块/表格，
 * 自己写一遍只会把表格和嵌套列表写错。
 *
 * 两个坑（官方文档里写了，但很容易漏）：
 *   - 表格 block 里的 merge_info 是只读字段，回插时必须删掉，否则报 1770006 schema mismatch；
 *   - 单次插入最多 1000 个 block，超了要分批，否则报 1770007。
 *
 * 还有一个不是坑但必须知道的事实：用 tenant_access_token 创建的文档归属于「应用」，
 * 你自己在飞书里是看不到的。所以要么让应用把文档分享给你（本模块的 shareTo），
 * 要么把文档建在应用有权限的文件夹里。
 */

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://open.feishu.cn';

// 回插前必须从 convert 结果里剔除的字段：只读或由服务端生成。
// 注意 merge_info 可能出现在 block 顶层，也可能藏在 table.property 里，所以要递归删。
const STRIP_FIELDS = ['revision_id', 'parent_id', 'merge_info', 'comment_ids', 'comments', 'cells'];

/** 递归剔掉只读字段；children 里的临时 id 要保留（那是父子关系）。 */
function stripReadOnly(value) {
  if (Array.isArray(value)) return value.map(stripReadOnly);
  if (!value || typeof value !== 'object') return value;

  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (STRIP_FIELDS.includes(key)) continue;
    clean[key] = stripReadOnly(item);
  }
  return clean;
}

/** 把 convert 返回的 blocks 清成可以回插的形态。 */
function sanitizeBlocks(blocks) {
  return (blocks || []).map((block) => {
    const clean = stripReadOnly(block);
    if (!Array.isArray(clean.children)) clean.children = [];
    return clean;
  });
}

const MAX_BLOCKS_PER_REQUEST = 1000;
const MAX_FIRST_LEVEL_PER_CHUNK = 50;

/** 飞书常见错误码 → 能直接照做的提示 */
function explainFeishuError(code, msg) {
  if (code === 99991400) return `飞书接口被限流了（${msg || '频率超限'}），稍后重试`;
  if (code === 21001) {
    return (
      '飞书返回 21001（Access denied due to platform policy）：应用级被拒，连令牌都不签发。' +
      '最可能是应用未启用/版本未发布，或账号是个人版（个人版拿不到 tenant_access_token）。' +
      '先用开放平台「API 调试台」用同一对凭证试一次：那边也报 21001 就说明与代码无关'
    );
  }
  if (code === 1770040 || code === 1770032) {
    return `没有云文档权限（${msg}）：检查应用是否开通 docx:document / drive:drive，并把应用加进目标文件夹的协作者`;
  }
  if (code === 1770039) return `文件夹不存在（${msg}）：检查 FEISHU_FOLDER_TOKEN 是否填错`;
  if (code === 1770006) return `文档结构不合法（${msg}）：通常是 block 里带了只读字段，或父子关系不对`;
  if (code === 1770007) return `单次 block 太多（${msg}）：需要分批插入`;
  if (code === 10003 || code === 99991663) {
    return `应用凭证无效（${msg}）：检查 FEISHU_APP_ID / FEISHU_APP_SECRET`;
  }
  return `飞书接口失败（code=${code}）：${msg || '未知错误'}`;
}

/** 取出 roots 及其子孙 block（保持原有顺序），用于分批插入。 */
function collectClosure(blocksById, roots) {
  const picked = [];
  const seen = new Set();

  const walk = (id) => {
    if (seen.has(id)) return;
    const block = blocksById.get(id);
    if (!block) return;
    seen.add(id);
    picked.push(block);
    for (const child of block.children || []) walk(child);
  };

  for (const root of roots) walk(root);
  return picked;
}

class FeishuClient {
  constructor({
    appId,
    appSecret,
    webOrigin = '',
    baseUrl = DEFAULT_BASE_URL,
    folderToken = '',
    shareTo = '',
    shareMemberType = 'email',
    linkShare = '',
    timeoutMs = 15000,
    http = axios,
  }) {
    if (!appId || !appSecret) throw new Error('FeishuClient 需要 appId 和 appSecret');
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.webOrigin = String(webOrigin || '').replace(/\/+$/, '');
    this.folderToken = folderToken || '';
    this.shareTo = shareTo || '';
    // 飞书那边叫 openid（没有下划线），这里顺手兼容一下常见写法
    this.shareMemberType = String(shareMemberType || 'email').replace('_', '');
    this.linkShare = linkShare || '';
    this.timeoutMs = timeoutMs;
    this.http = http;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async request(method, path, { body, query, auth = true, raw = false } = {}) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (auth) headers.Authorization = `Bearer ${await this.tenantToken()}`;

    let response;
    try {
      response = await this.http.request({
        method,
        url: this.baseUrl + path,
        params: query,
        data: body,
        headers,
        timeout: this.timeoutMs,
      });
    } catch (error) {
      const status = error && error.response && error.response.status;
      const detail = error && error.response && error.response.data;
      // 飞书的 log_id 在响应头里，提工单/找客服时只有它能定位到具体那次请求
      const logId =
        (error && error.response && error.response.headers &&
          (error.response.headers['x-tt-logid'] || error.response.headers['X-Tt-Logid'])) ||
        (detail && detail.error && detail.error.log_id) ||
        '';

      if (detail && typeof detail === 'object' && detail.code !== undefined) {
        const hint = explainFeishuError(detail.code, detail.msg);
        throw new Error(logId ? `${hint}｜log_id=${logId}` : hint);
      }
      throw new Error(`飞书请求失败（HTTP ${status || '?'}）：${(error && error.message) || '未知错误'}`);
    }

    const payload = response.data || {};
    if (payload.code !== 0) {
      const logId =
        (response.headers && (response.headers['x-tt-logid'] || response.headers['X-Tt-Logid'])) ||
        (payload.error && payload.error.log_id) ||
        '';
      const hint = explainFeishuError(payload.code, payload.msg);
      throw new Error(logId ? `${hint}｜log_id=${logId}` : hint);
    }
    // 取 token 这类接口把结果放在响应根部（不在 data 里），需要原始 payload
    return raw ? payload : (payload.data || {});
  }

  /** tenant_access_token 有 2 小时有效期，这里提前 60 秒过期，避免边界失败。 */
  async tenantToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) return this.token;

    // 注意：这个接口的 tenant_access_token / expire 在响应根部，不在 data 里
    const data = await this.request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
      auth: false,
      raw: true,
      body: { app_id: this.appId, app_secret: this.appSecret },
    });

    if (!data.tenant_access_token) throw new Error('飞书没有返回 tenant_access_token');
    this.token = data.tenant_access_token;
    const ttlMs = Math.max(60, Number(data.expire) || 7200) * 1000;
    this.tokenExpiresAt = now + ttlMs - 60_000;
    return this.token;
  }

  async createDocument(title) {
    const body = { title };
    if (this.folderToken) body.folder_token = this.folderToken;
    const data = await this.request('POST', '/open-apis/docx/v1/documents', { body });
    const documentId = data.document && data.document.document_id;
    if (!documentId) throw new Error('飞书没有返回 document_id');
    return documentId;
  }

  async convertMarkdown(markdown) {
    const data = await this.request('POST', '/open-apis/docx/v1/documents/blocks/convert', {
      body: { content_type: 'markdown', content: markdown },
    });
    const blocks = sanitizeBlocks(data.blocks);
    const firstLevelIds = Array.isArray(data.first_level_block_ids) ? data.first_level_block_ids : [];
    if (!blocks.length) throw new Error('飞书没有把内容转换成任何 block');
    return { blocks, firstLevelIds };
  }

  /** 分批插入，每批 ≤1000 个 block、≤50 个一级块。 */
  async insertBlocks(documentId, { blocks, firstLevelIds }) {
    const blocksById = new Map(blocks.map((block) => [block.block_id, block]));
    let inserted = 0;

    for (let i = 0; i < firstLevelIds.length; i += MAX_FIRST_LEVEL_PER_CHUNK) {
      const chunkRoots = firstLevelIds.slice(i, i + MAX_FIRST_LEVEL_PER_CHUNK);
      const chunkBlocks = collectClosure(blocksById, chunkRoots);

      if (chunkBlocks.length > MAX_BLOCKS_PER_REQUEST) {
        throw new Error(`单批 block 数超过 ${MAX_BLOCKS_PER_REQUEST}（${chunkBlocks.length}），请把行程拆短一些`);
      }

      await this.request(
        'POST',
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/descendant`,
        {
          query: { document_revision_id: -1 },
          body: {
            children_id: chunkRoots,
            index: -1,
            descendants: chunkBlocks,
          },
        }
      );
      inserted += chunkBlocks.length;
    }

    return inserted;
  }

  /** 把文档授权给某个人，否则文档只属于「应用」，你打不开。 */
  async grantPermission(documentId) {
    if (!this.shareTo) return false;
    await this.request(
      'POST',
      `/open-apis/drive/v1/permissions/${encodeURIComponent(documentId)}/members`,
      {
        query: { type: 'docx', need_notification: false },
        body: {
          member_type: this.shareMemberType,
          member_id: this.shareTo,
          perm: 'full_access',
        },
      }
    );
    return true;
  }

  /**
   * 设置链接分享。比「授权给某个邮箱」省事的地方在于：不需要知道对方是谁，
   * 拿到链接就能看——特别适合"生成完直接把链接发出去"这种演示场景。
   * value: anyone_readable（互联网可读）/ tenant_readable（组织内可读）/ off
   */
  async setLinkShare(documentId, value) {
    if (!value || value === 'off') return false;
    const body = { link_share_entity: value };
    if (value === 'anyone_readable') body.external_access = true;

    await this.request(
      'PATCH',
      `/open-apis/drive/v1/permissions/${encodeURIComponent(documentId)}/public`,
      { query: { type: 'docx' }, body }
    );
    return true;
  }

  documentUrl(documentId) {
    return this.webOrigin ? `${this.webOrigin}/docx/${documentId}` : '';
  }

  /**
   * 直接问飞书要文档真实链接，比拿 FEISHU_WEB_ORIGIN 拼字符串靠谱得多
   * （租户域名每个人都不一样，填错就是一条 404 链接）。
   * 需要权限：drive:drive.metadata:readonly 或 drive:drive。
   */
  async fetchDocumentUrl(documentId) {
    const data = await this.request('POST', '/open-apis/drive/v1/metas/batch_query', {
      body: {
        request_docs: [{ doc_token: documentId, doc_type: 'docx' }],
        with_url: true,
      },
    });
    const meta = data.metas && data.metas[0];
    return (meta && meta.url) || '';
  }

  /** 往某个 block 下插入子块；index 为 -1 表示追加到末尾。 */
  async insertDescendant(documentId, { childrenId, descendants, index = -1 }) {
    await this.request(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/descendant`,
      {
        query: { document_revision_id: -1 },
        body: { children_id: childrenId, index, descendants },
      }
    );
  }

  /** 文首的高亮块：一眼看到标题和关键信息。 */
  async insertHeaderCallout(documentId, { title, lines, emojiId = 'bulb' }) {
    const childIds = lines.map((_, i) => `hdr_line_${i}`);
    const descendants = [
      {
        block_id: 'hdr_callout',
        block_type: 19,
        callout: { emoji_id: emojiId },
        children: childIds,
      },
      ...lines.map((line, i) => ({
        block_id: childIds[i],
        block_type: 2,
        text: {
          elements: [
            {
              text_run: {
                content: String(line),
                text_element_style: i === 0 ? { bold: true } : {},
              },
            },
          ],
        },
        children: [],
      })),
    ];

    await this.insertDescendant(documentId, {
      childrenId: ['hdr_callout'],
      descendants,
      index: 0,
    });

    return { title, lines: lines.length };
  }

  /** 在每个一级标题前插一条分割线，让各段之间有呼吸感。 */
  async insertSectionDividers(documentId, { blocks, firstLevelIds }) {
    const byId = new Map((blocks || []).map((block) => [block.block_id, block]));
    const positions = [];

    firstLevelIds.forEach((id, index) => {
      const block = byId.get(id);
      if (!block) return;
      if (block.block_type !== 3 && block.block_type !== 4) return; // heading1 / heading2
      if (index === 0) return;

      // 前一个块已经是分割线就不再加：模型自己写的 `---` 会被 convert 成原生分割线，
      // 再插一条就会出现两个挨着的横线。
      const previous = byId.get(firstLevelIds[index - 1]);
      if (previous && previous.block_type === 22) return;

      positions.push(index);
    });

    // 从后往前插，前面的位置才不会被顶偏
    positions.sort((a, b) => b - a);
    for (const [i, position] of positions.entries()) {
      await this.insertDescendant(documentId, {
        childrenId: [`divider_${i}`],
        descendants: [{ block_id: `divider_${i}`, block_type: 22, divider: {}, children: [] }],
        index: position,
      });
    }

    return positions.length;
  }

  /** 文末署名：数据来源 + 生成时间。 */
  async insertFooterNote(documentId, content) {
    await this.insertDescendant(documentId, {
      childrenId: ['footer_note'],
      descendants: [
        {
          block_id: 'footer_note',
          block_type: 15,
          quote: { elements: [{ text_run: { content: String(content) } }] },
          children: [],
        },
      ],
      index: -1,
    });
  }

  /**
   * 一条龙：建文档 → Markdown 转 blocks → 插入 → 装饰（高亮块/分割线/署名）→ 分享。
   * 返回 { documentId, url, blocks, shared, linkShared, decorate }。
   */
  async exportMarkdown({ title, markdown, summary = '', highlights = [], decorate = true }) {
    if (!markdown || !String(markdown).trim()) throw new Error('没有可导出的内容');

    const documentTitle = title || '旅行行程单';
    const documentId = await this.createDocument(documentTitle);
    const converted = await this.convertMarkdown(String(markdown));
    const inserted = await this.insertBlocks(documentId, converted);

    // 装饰是可选的：加了更好看，但失败了不能影响文档已经生成
    const decoration = { header: false, dividers: 0, footer: false };
    let decorateError = '';

    if (decorate) {
      try {
        decoration.dividers = await this.insertSectionDividers(documentId, converted);

        const lines = [summary, ...(Array.isArray(highlights) ? highlights : [])]
          .map((line) => String(line || '').trim())
          .filter(Boolean);

        // 模型没给概览就用正文第一段兜底
        if (!lines.length) {
          const firstParagraph = String(markdown)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith('#') && !line.startsWith('|') && !line.startsWith('-'));
          if (firstParagraph) lines.push(firstParagraph.slice(0, 120));
        }

        if (lines.length) {
          await this.insertHeaderCallout(documentId, { title: documentTitle, lines });
          decoration.header = true;
        }

        await this.insertFooterNote(
          documentId,
          `由「坤坤 · 旅行管家」生成 · ${new Date().toLocaleString('zh-CN', { hour12: false })}` +
            ' · 数据来源：高德地图 / 和风天气 / 飞常准'
        );
        decoration.footer = true;
      } catch (error) {
        decorateError = error.message;
      }
    }

    // 两种授信方式，能配哪个配哪个，都失败也不影响文档本身已经建好
    let linkShared = false;
    let shared = false;
    const shareErrors = [];

    if (this.linkShare) {
      try {
        linkShared = await this.setLinkShare(documentId, this.linkShare);
      } catch (error) {
        shareErrors.push(`链接分享设置失败：${error.message}`);
      }
    }

    if (this.shareTo) {
      try {
        shared = await this.grantPermission(documentId);
      } catch (error) {
        shareErrors.push(`协作者授权失败：${error.message}`);
      }
    }

    // 先问飞书要真实链接，拿不到再用 FEISHU_WEB_ORIGIN 拼（可能拼错，所以放后面）
    let url = '';
    let urlError = '';
    try {
      url = await this.fetchDocumentUrl(documentId);
    } catch (error) {
      urlError = error.message;
    }
    if (!url) url = this.documentUrl(documentId);

    return {
      documentId,
      url,
      blocks: inserted,
      shared,
      linkShared,
      decoration,
      decorateError,
      shareError: shareErrors.join('；'),
      urlError,
    };
  }
}

/** 交给模型的工具：把回答内容整理成飞书文档。 */
const FEISHU_EXPORT_TOOL = {
  type: 'function',
  function: {
    name: 'export_to_feishu',
    description:
      '把行程单导出成一篇飞书云文档，返回可以直接分享的链接。' +
      '当用户说「导出到飞书」「发我个文档链接」「生成一篇可分享的行程单」时使用。' +
      'markdown 参数要写完整内容（标题、每日安排、交通、住宿、提示），支持表格。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题，例如「长沙 3 日行程单」' },
        summary: { type: 'string', description: '一句话概览，会显示在文档顶部的高亮块里，例如「3 天 2 晚 · 预算 1500 元 · 岳麓山 + 橘子洲」' },
        highlights: {
          type: 'array',
          items: { type: 'string' },
          description: '2-4 条关键信息，显示在顶部高亮块，例如「出行日期：12/04-12/06」「天气：第1天中雨，带伞」',
        },
        markdown: {
          type: 'string',
          description:
            '文档正文（Markdown）。为了好看请这样写：' +
            '每个大板块用 `## 📅 Day 1 · 12/04 · 多云` 这种带 emoji 的二级标题；' +
            '关键信息用无序列表，不要把内容一股脑塞进表格；' +
            '表格最多 1-2 个，只用于需要对齐对比的地方（预算明细、车次对比）；' +
            '重要提醒单独用一段以「⚠️」开头。',
        },
      },
      required: ['title', 'markdown'],
    },
  },
};

function createFeishuExportTool({ client }) {
  return {
    schema: FEISHU_EXPORT_TOOL,
    async handler(args) {
      const title = String((args && args.title) || '').trim() || '旅行行程单';
      const markdown = String((args && args.markdown) || '');
      if (!markdown.trim()) return { error: '缺少参数 markdown' };

      const summary = String((args && args.summary) || '').trim();
      const highlights = Array.isArray(args && args.highlights)
        ? args.highlights.map((item) => String(item)).slice(0, 4)
        : [];

      try {
        const result = await client.exportMarkdown({ title, markdown, summary, highlights });
        return {
          ...result,
          tip: result.url
            ? '把 url 直接发给用户，并说明这是飞书文档'
            : '文档已创建，但没配 FEISHU_WEB_ORIGIN，只能返回 documentId',
        };
      } catch (error) {
        return { error: error.message };
      }
    },
  };
}

module.exports = {
  FeishuClient,
  createFeishuExportTool,
  FEISHU_EXPORT_TOOL,
  sanitizeBlocks,
  collectClosure,
  explainFeishuError,
  MAX_BLOCKS_PER_REQUEST,
};
