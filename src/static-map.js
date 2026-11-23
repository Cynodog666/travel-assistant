'use strict';

/**
 * 高德静态地图（staticmap）：
 *
 * 用法是「服务端代理 + 签名 URL」。原因很直接——高德静态图接口的 URL 里带 key，
 * 如果把原始 URL 直接返回给前端，key 就泄露在页面源码和聊天记录里了。
 *
 * 所以流程是：
 *   1. 工具生成 /api/staticmap?location=...&sig=...&exp=... 这种相对地址；
 *   2. 浏览器 <img> 加载它（img 请求带不了 Authorization 头，所以用 HMAC 签名代替）；
 *   3. 服务端校验签名后才带着 key 去高德取图，key 永远不出服务端。
 */

const crypto = require('crypto');
const { LRUCache } = require('./lru-cache');

const AMAP_STATICMAP_ENDPOINT = 'https://restapi.amap.com/v3/staticmap';
const STATICMAP_PATH = '/api/staticmap';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 小时：足够用户回看聊天记录里的图

const COORD_PATTERN = /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/;

/** 把查询参数按 key 排序后编码，保证签名和校验时拼出来的串完全一致。 */
function canonicalQuery(params) {
  return Object.keys(params)
    // exp 单独拼在末尾，sig 自己当然不参与签名
    .filter((key) => key !== 'sig' && key !== 'exp' && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&');
}

class UrlSigner {
  constructor(secret, { ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!secret) throw new Error('UrlSigner 需要一个 secret');
    this.secret = String(secret);
    this.ttlMs = ttlMs;
  }

  signPayload(query, exp) {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${STATICMAP_PATH}?${canonicalQuery(query)}&exp=${exp}`)
      .digest('hex')
      .slice(0, 32);
  }

  /** 生成带签名的相对地址（不带 host，前端直接用相对路径即可）。 */
  sign(query, now = Date.now()) {
    const exp = now + this.ttlMs;
    const sig = this.signPayload(query, exp);
    return `${STATICMAP_PATH}?${canonicalQuery(query)}&exp=${exp}&sig=${sig}`;
  }

  /** 校验签名与有效期；exp 缺失或过期都算失败。 */
  verify(query, now = Date.now()) {
    const exp = Number(query.exp);
    const sig = String(query.sig || '');
    if (!Number.isFinite(exp) || !sig) return { ok: false, reason: '缺少签名或有效期' };
    if (exp < now) return { ok: false, reason: '签名已过期' };

    const expected = this.signPayload(query, exp);
    const left = Buffer.from(expected);
    const right = Buffer.from(sig);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      return { ok: false, reason: '签名不正确' };
    }
    return { ok: true };
  }
}

/** 校验一个「地址」参数是不是已经是「经度,纬度」。 */
function looksLikeCoords(value) {
  return COORD_PATTERN.test(String(value || '').trim());
}

/**
 * 拼真正的高德静态图地址（只在服务端使用，不要返回给客户端）。
 */
function buildAmapStaticMapUrl({ key, location, zoom = 14, size = '600*360', scale = 1, markers }) {
  const parts = [
    `location=${encodeURIComponent(location)}`,
    `zoom=${encodeURIComponent(zoom)}`,
    `size=${encodeURIComponent(size)}`,
    `scale=${encodeURIComponent(scale)}`,
    `key=${encodeURIComponent(key)}`,
  ];
  if (markers) parts.push(`markers=${encodeURIComponent(markers)}`);
  return `${AMAP_STATICMAP_ENDPOINT}?${parts.join('&')}`;
}

/** 生成静态图用的 params 画像（不含 key），签名和代理都基于它。 */
function createStaticMapService({ amap, secret, ttlMs = DEFAULT_TTL_MS, cacheSize = 100, http, timeoutMs = 8000 }) {
  const signer = new UrlSigner(secret, { ttlMs });
  const cache = new LRUCache(cacheSize);
  const axios = http || require('axios');

  async function fetchImage(query, { signal } = {}) {
    const cacheKey = canonicalQuery(query);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const url = buildAmapStaticMapUrl({
      key: amap.key,
      location: query.location,
      zoom: query.zoom,
      size: query.size,
      scale: query.scale,
      markers: query.markers,
    });

    let response;
    try {
      response = await axios.get(url, { responseType: 'arraybuffer', timeout: timeoutMs, signal });
    } catch (error) {
      throw new Error(`高德静态图请求失败：${(error && error.message) || '未知错误'}`);
    }

    const buffer = Buffer.from(response.data || []);
    if (!buffer.length) throw new Error('高德静态图返回了空内容');

    // 参数不合法时高德会返回 JSON 而不是图片，这里要认出来，别把 JSON 当 PNG 吐出去
    if (buffer.slice(0, 1).toString() === '{') {
      let detail = '未知错误';
      try {
        const parsed = JSON.parse(buffer.toString('utf8'));
        detail = parsed.info || detail;
      } catch {
        /* 保持默认 */
      }
      throw new Error(`高德静态图参数错误：${detail}`);
    }

    const image = { buffer, contentType: response.headers && response.headers['content-type'] || 'image/png' };
    cache.set(cacheKey, image);
    return image;
  }

  return { signer, fetchImage, cache };
}

/** 交给模型的工具：生成一张地图图片，并把 markdown 原样放进回答。 */
const MAP_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'map_image',
    description:
      '为某个地点（地址或「经度,纬度」坐标）生成一张静态地图图片。' +
      '返回结果里的 markdown 字段要原样放进你的回答，用户才能看到图。',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '地址或地名，例如「长沙岳麓山」；也可以直接给「经度,纬度」' },
        zoom: { type: 'integer', description: '地图缩放级别 10-17，默认 14', minimum: 10, maximum: 17 },
        size: { type: 'string', description: '图片尺寸，形如 600*360，默认 600*360' },
      },
      required: ['location'],
    },
  },
};

/** 把「地图服务 + 地理编码」包成一个工具。 */
function createMapImageTool({ amap, service }) {
  return {
    schema: MAP_IMAGE_TOOL,
    async handler(args, options = {}) {
      const query = String((args && args.location) || '').trim();
      if (!query) return { error: '缺少参数 location' };

      let coordinates = query;
      let name = query;

      if (!looksLikeCoords(query)) {
        // 地址要先转坐标；这里复用高德地理编码，顺带拿到规范化的地址名
        const place = await amap.resolveLocation(query, options);
        coordinates = place.location;
        name = place.formatted || query;
      }

      const zoom = Math.min(17, Math.max(10, Number(args && args.zoom) || 14));
      const size = /^\d{2,4}\*\d{2,4}$/.test((args && args.size) || '') ? args.size : '600*360';
      const relativeUrl = service.signer.sign({
        location: coordinates,
        zoom,
        size,
        scale: 1,
        markers: `mid,0xFF7A00,1:${coordinates}`,
      });

      return {
        name,
        location: coordinates,
        imageUrl: relativeUrl,
        markdown: `![${name}](${relativeUrl})`,
        tip: '把 markdown 字段原样写进回答，前端会渲染成地图',
      };
    },
  };
}

module.exports = {
  UrlSigner,
  createStaticMapService,
  createMapImageTool,
  buildAmapStaticMapUrl,
  looksLikeCoords,
  MAP_IMAGE_TOOL,
  STATICMAP_PATH,
  AMAP_STATICMAP_ENDPOINT,
  DEFAULT_TTL_MS,
};
