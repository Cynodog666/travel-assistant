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

// 回插前必须从 convert 结果里剔除的字段：只读或由服务端生成
const STRIP_FIELDS = ['revision_id', 'parent_id', 'merge_info', 'comment_ids', 'comments'];

const MAX_BLOCKS_PER_REQUEST = 1000;
const MAX_FIRST_LEVEL_PER_CHUNK = 50;

/** 飞书常见错误码 → 能直接照做的提示 */
function explainFeishuError(code, msg) {
  if (code === 99991400) return `飞书接口被限流了（${msg || '频率超限'}），稍后重试`;
  if (code === 1770040 || code === 1770032 || code === 1770032) {
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

/** 把 convert 返回的 blocks 清成可以回插的形态。 */
function sanitizeBlocks(blocks) {
  return (blocks || []).map((block) => {
    const clean = {};
    for (const [key, value] of Object.entries(block)) {
      if (STRIP_FIELDS.includes(key)) continue;
      clean[key] = value;
    }
    if (!Array.isArray(clean.children)) clean.children = [];
    return clean;
  });
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

  async request(method, path, { body, query, auth = true } = {}) {
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
      if (detail && typeof detail === 'object' && detail.code !== undefined) {
        throw new Error(explainFeishuError(detail.code, detail.msg));
      }
      throw new Error(`飞书请求失败（HTTP ${status || '?'}）：${(error && error.message) || '未知错误'}`);
    }

    const payload = response.data || {};
    if (payload.code !== 0) {
      throw new Error(explainFeishuError(payload.code, payload.msg));
    }
    return payload.data || {};
  }

  /** tenant_access_token 有 2 小时有效期，这里提前 60 秒过期，避免边界失败。 */
  async tenantToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) return this.token;

    const data = await this.request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
      auth: false,
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
   * 一条龙：建文档 → Markdown 转 blocks → 插入 → 可选授权。
   * 返回 { documentId, url, blocks, shared }。
   */
  async exportMarkdown({ title, markdown }) {
    if (!markdown || !String(markdown).trim()) throw new Error('没有可导出的内容');

    const documentId = await this.createDocument(title || '旅行行程单');
    const converted = await this.convertMarkdown(String(markdown));
    const inserted = await this.insertBlocks(documentId, converted);

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

    return {
      documentId,
      url: this.documentUrl(documentId),
      blocks: inserted,
      shared,
      linkShared,
      shareError: shareErrors.join('；'),
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
        markdown: { type: 'string', description: '文档正文，Markdown 格式，可含标题、列表、表格' },
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

      try {
        const result = await client.exportMarkdown({ title, markdown });
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
