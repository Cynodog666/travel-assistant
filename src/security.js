'use strict';

/**
 * 上公网要用到的几件小事：访问令牌校验、内存限流、客户端真实 IP。
 *
 * 都不引入额外依赖：令牌校验用 crypto 的定长比较，
 * 限流是一个按 key 计数的滑动窗口（够单机用，多实例请换成 Redis）。
 */

const crypto = require('crypto');
const { LRUCache } = require('./lru-cache');

/** 定长比较，避免通过响应时间泄露令牌长度和前缀。 */
function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

/** 从 Authorization: Bearer xxx 或 x-access-token 头里取令牌。 */
function extractToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) return match[1].trim();
  const alt = req.get('x-access-token');
  return alt ? alt.trim() : '';
}

function createAuthGuard(expectedToken) {
  // 没配令牌就退化成「不鉴权」，只在 localhost 自用时可以接受
  if (!expectedToken) return null;

  return function authGuard(req, res, next) {
    const provided = extractToken(req);
    if (!provided) {
      res.status(401).json({ error: '缺少访问令牌', code: 'TOKEN_MISSING' });
      return;
    }
    if (!safeEqual(provided, expectedToken)) {
      res.status(403).json({ error: '访问令牌不正确', code: 'TOKEN_INVALID' });
      return;
    }
    next();
  };
}

/**
 * 固定窗口限流：每个 key 在 windowMs 内最多 max 次。
 * 用 LRU 限制 key 数量，避免被大量伪造 IP 撑爆内存。
 */
class RateLimiter {
  constructor({ max = 20, windowMs = 60_000, maxKeys = 10_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.buckets = new LRUCache(maxKeys);
  }

  take(key, cost = 1) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
    }
    bucket.count += cost;
    this.buckets.set(key, bucket);

    if (bucket.count > this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, bucket.resetAt - now),
      };
    }
    return { allowed: true, remaining: this.max - bucket.count, retryAfterMs: 0 };
  }
}

function createRateLimitMiddleware(limiter, options = {}) {
  const keyOf = options.keyOf || ((req) => req.ip);

  return function rateLimit(req, res, next) {
    const result = limiter.take(keyOf(req));
    res.setHeader('X-RateLimit-Limit', String(limiter.max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({ error: '请求太频繁了，歇一会儿再试', code: 'RATE_LIMITED' });
      return;
    }
    next();
  };
}

module.exports = { safeEqual, extractToken, createAuthGuard, RateLimiter, createRateLimitMiddleware };
