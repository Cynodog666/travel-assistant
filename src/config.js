'use strict';

/**
 * 配置集中管理：读取 .env，做类型校验，缺必填项时给出可执行的提示。
 *
 * 所有可调参数都在这里，server.js 和各个模块只消费 loadConfig() 的返回值，
 * 不再直接读 process.env，方便测试时注入假配置。
 */

const path = require('path');

// 只有被 require 一次时加载 .env；测试里会自己注入 env，不受影响。
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

class ConfigError extends Error {}

function toInt(name, raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`环境变量 ${name} 必须是 ${min} ~ ${max} 之间的整数，当前是「${raw}」`);
  }
  return value;
}

function toNumber(name, raw, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`环境变量 ${name} 必须是 ${min} ~ ${max} 之间的数字，当前是「${raw}」`);
  }
  return value;
}

function toBool(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function loadConfig(env = process.env) {
  const config = {
    nodeEnv: (env.NODE_ENV || 'development').trim(),
    port: toInt('PORT', env.PORT, 3000, { min: 1, max: 65535 }),

    aiApiUrl: (env.AI_API_URL || 'https://api.openai.com/v1/chat/completions').trim(),
    aiApiKey: (env.AI_API_KEY || '').trim(),
    aiModel: (env.AI_MODEL || 'gpt-4o-mini').trim(),
    aiTemperature: toNumber('AI_TEMPERATURE', env.AI_TEMPERATURE, 0.7, { min: 0, max: 2 }),
    aiTimeoutMs: toInt('AI_TIMEOUT_MS', env.AI_TIMEOUT_MS, 60_000, { min: 1_000, max: 600_000 }),

    amapKey: (env.AMAP_KEY || '').trim(),
    // 默认走高德官方域名；测试指向本地假服务，部署时也可以指向代理
    amapBaseUrl: (env.AMAP_BASE_URL || 'https://restapi.amap.com').trim().replace(/\/+$/, ''),
    amapTimeoutMs: toInt('AMAP_TIMEOUT_MS', env.AMAP_TIMEOUT_MS, 8_000, { min: 1_000, max: 60_000 }),
    amapCacheSize: toInt('AMAP_CACHE_SIZE', env.AMAP_CACHE_SIZE, 200, { min: 1, max: 10_000 }),

    // 和风天气：可选。配了就用「实时 + 预报 + 预警」替换高德那个只有实时值的 weather 工具。
    // 注意它必须配控制台分配的专属 API Host，不是固定域名。
    qweatherApiKey: (env.QWEATHER_API_KEY || '').trim(),
    qweatherBaseUrl: (env.QWEATHER_BASE_URL || '').trim().replace(/\/+$/, ''),
    qweatherTimeoutMs: toInt('QWEATHER_TIMEOUT_MS', env.QWEATHER_TIMEOUT_MS, 8_000, { min: 1_000, max: 60_000 }),

    maxToolSteps: toInt('MAX_TOOL_STEPS', env.MAX_TOOL_STEPS, 5, { min: 1, max: 20 }),
    maxHistoryTurns: toInt('MAX_HISTORY_TURNS', env.MAX_HISTORY_TURNS, 20, { min: 1, max: 200 }),
    maxSessions: toInt('MAX_SESSIONS', env.MAX_SESSIONS, 500, { min: 1, max: 100_000 }),
    sessionTtlMs: toInt('SESSION_TTL_MS', env.SESSION_TTL_MS, 2 * 60 * 60 * 1000, { min: 60_000 }),

    // 访问令牌：留空表示不鉴权（只适合本机），上公网必须设置。
    accessToken: (env.ACCESS_TOKEN || '').trim(),
    trustProxy: toBool(env.TRUST_PROXY, false),

    rateLimitMax: toInt('RATE_LIMIT_MAX', env.RATE_LIMIT_MAX, 20, { min: 1, max: 100_000 }),
    rateLimitWindowMs: toInt('RATE_LIMIT_WINDOW_MS', env.RATE_LIMIT_WINDOW_MS, 60_000, { min: 1_000 }),
  };

  const missing = [];
  if (!config.aiApiKey) missing.push('AI_API_KEY');
  if (!config.amapKey) missing.push('AMAP_KEY');
  if (missing.length) {
    throw new ConfigError(
      [
        `缺少环境变量：${missing.join('、')}`,
        '  先执行：copy .env.example .env（macOS/Linux：cp .env.example .env）',
        '  然后打开 .env，填入对应的密钥。',
      ].join('\n')
    );
  }

  if (config.qweatherApiKey && !config.qweatherBaseUrl) {
    throw new ConfigError(
      [
        '设置了 QWEATHER_API_KEY 但没有设置 QWEATHER_BASE_URL。',
        '  和风天气的接口地址是每个项目独立的（控制台「设置 → API Host」），形如：',
        '    QWEATHER_BASE_URL=https://abcdefg.re.qweatherapi.com',
        '  想先用高德自带的实时天气，把 QWEATHER_API_KEY 留空即可。',
      ].join('\n')
    );
  }

  return config;
}

/** 天气能力用哪套实现：配了和风就走和风，否则退回高德。 */
function weatherProviderOf(config) {
  return config.qweatherApiKey && config.qweatherBaseUrl ? 'qweather' : 'amap';
}

module.exports = { loadConfig, ConfigError, weatherProviderOf, ROOT_DIR, PUBLIC_DIR };
