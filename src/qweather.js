'use strict';

/**
 * 和风天气（QWeather）客户端。
 *
 * 为什么不用高德那个 weather：高德只给「当前天气」一个扁平值，和风能给
 * 实时 + 每日预报 + 正在生效的气象预警，这些才是行程规划真正要用的。
 *
 * 接口形态（v1，2025 起的新版）需要注意：
 *   1. 必须用控制台分配的专属 API Host（形如 https://xxxx.re.qweatherapi.com）；
 *   2. 先说清楚「查哪儿」：先 /geo/v2/city/lookup 拿到经纬度，再查天气；
 *   3. 鉴权走请求头 X-QW-Api-Key；官方也支持 JWT(Bearer)，但两者不能混用。
 *
 * 返回值都做了裁剪和单位统一（温度 ℃、湿度 %、降水 mm），
 * 因为完整响应字段太多，直接塞给模型既费 token 又容易读错。
 */

const axios = require('axios');
const { LRUCache } = require('./lru-cache');

const COMPASS_TO_CN = {
  n: '北', nne: '北东北', ne: '东北', ene: '东东北',
  e: '东', ese: '东东南', se: '东南', sse: '南东南',
  s: '南', ssw: '南西南', sw: '西南', wsw: '西西南',
  w: '西', wnw: '西西北', nw: '西北', nnw: '北西北',
  vrb: '风向不定', none: '无持续风向',
};

const PRECIP_TO_CN = {
  rain: '雨', snow: '雪', ice: '冰粒或冻雨', mixed: '混合降水', none: '无降水', unknown: '未知',
};

const round1 = (value) => Math.round(Number(value) * 10) / 10;
const toPct = (value) => (value === undefined || value === null ? null : Math.round(Number(value) * 100));
const coord = (value) => Number(value).toFixed(2);

/** 交给模型的工具描述：只暴露一个 weather，避免和高德那个重名打架。 */
const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'weather',
    description:
      '查询某个城市的实时天气、未来几天预报，以及正在生效的气象灾害预警（数据来自和风天气）。' +
      '涉及天气、穿衣、是否下雨、能否出行时优先调用它。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，例如「长沙」或「长沙市」' },
        days: { type: 'integer', description: '需要未来几天的预报，1-7，默认 3', minimum: 1, maximum: 7 },
      },
      required: ['city'],
    },
  },
};

class QWeatherClient {
  constructor({ apiKey, baseUrl, timeoutMs = 8000, http = axios, cacheSize = 200 }) {
    if (!apiKey) throw new Error('QWeatherClient 需要一个 apiKey');
    if (!baseUrl) throw new Error('QWeatherClient 需要控制台分配的 API Host（baseUrl）');
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.http = http;
    this.cache = new LRUCache(cacheSize);
  }

  async request(path, params = {}, { signal } = {}) {
    const cacheKey = `${path}?${JSON.stringify(params)}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    let data;
    try {
      const response = await this.http.get(this.baseUrl + path, {
        params,
        timeout: this.timeoutMs,
        signal,
        headers: { 'X-QW-Api-Key': this.apiKey },
      });
      data = response.data;
    } catch (error) {
      const status = error && error.response && error.response.status;
      if (status === 401 || status === 403) {
        throw new Error('和风天气鉴权失败（401/403）：检查 QWEATHER_API_KEY 和 QWEATHER_BASE_URL 是否匹配');
      }
      if (status === 404) throw new Error(`和风天气接口路径不存在：${path}`);

      // 最常见的两种配置错误，单独给出能直接照做的提示
      const code = error && error.code;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        throw new Error(
          `和风天气域名解析失败（${this.baseUrl}）。QWEATHER_BASE_URL 必须是控制台「设置」里分给你的真实 API Host，` +
            '不能照抄文档或示例里的地址，也不要带多余路径'
        );
      }
      if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
        throw new Error(`和风天气请求超时（${this.timeoutMs}ms），检查服务器出网或 QWEATHER_TIMEOUT_MS`);
      }

      throw new Error(`和风天气请求失败：${(error && error.message) || '未知错误'}`);
    }

    if (!data) throw new Error('和风天气返回了空响应');
    if (data.code && data.code !== '200') {
      throw new Error(`和风天气返回异常：code=${data.code}`);
    }

    this.cache.set(cacheKey, data);
    return data;
  }

  /** 城市名 → 经纬度 + LocationID。重名时优先返回排名靠前（通常是地级市）的那个。 */
  async lookupCity(city, options) {
    const data = await this.request(
      '/geo/v2/city/lookup',
      { location: city, number: 1, lang: 'zh' },
      options
    );
    const first = data.location && data.location[0];
    if (!first) return null;
    return {
      id: first.id,
      name: first.name,
      adm1: first.adm1,
      adm2: first.adm2,
      country: first.country,
      lat: Number(first.lat),
      lon: Number(first.lon),
    };
  }

  async current(lat, lon, options) {
    return this.request(`/weather/v1/current/${coord(lat)}/${coord(lon)}`, { localTime: true, lang: 'zh' }, options);
  }

  async daily(lat, lon, days, options) {
    return this.request(
      `/weather/v1/daily/${coord(lat)}/${coord(lon)}`,
      { days, localTime: true, lang: 'zh' },
      options
    );
  }

  /** 没有生效预警时接口照常 200，但 metadata.zeroResult = true。 */
  async alerts(lat, lon, options) {
    return this.request(`/weatheralert/v1/current/${coord(lat)}/${coord(lon)}`, { localTime: true, lang: 'zh' }, options);
  }

  async run(name, args, options = {}) {
    if (name !== 'weather') return { error: `和风天气不支持的工具：${name}` };

    const city = args && args.city;
    if (!city) return { error: '缺少参数 city' };

    const days = Math.min(7, Math.max(1, Number(args.days) || 3));

    const place = await this.lookupCity(city, options);
    if (!place) return { message: `没有找到「${city}」这个城市` };

    // 实时天气是核心，必须成功；预报和预警失败就降级，别把整个工具结果变成报错
    const current = await this.current(place.lat, place.lon, options);
    const [dailyResult, alertResult] = await Promise.allSettled([
      this.daily(place.lat, place.lon, days, options),
      this.alerts(place.lat, place.lon, options),
    ]);

    return this.shape(place, current, dailyResult, alertResult);
  }

  shape(place, current, dailyResult, alertResult) {
    const wind = (current.wind && current.wind.direction) || {};
    const precipitation = current.precipitation || {};
    const rain = (precipitation.amount && precipitation.amount.value) || 0;

    const result = {
      city: place.adm2 || place.name,
      province: place.adm1,
      locationId: place.id,
      observedAt: current.validTime,
      now: {
        text: (current.condition && current.condition.text) || '未知',
        temperatureC: round1(current.temperature && current.temperature.value),
        feelsLikeC: round1(current.feelsLike && current.feelsLike.value),
        humidityPct: toPct(current.humidity),
        wind: `${COMPASS_TO_CN[wind.compass] || wind.compass || '未知'}风 ${current.wind ? current.wind.scale : '?'}级`,
        precipitationMm: round1(rain),
        precipitationType: PRECIP_TO_CN[precipitation.type] || '未知',
        uvIndex: current.uvIndex,
        pressureHpa: current.pressure && current.pressure.value,
        visibilityKm: current.visibility ? round1(current.visibility.value / 1000) : null,
      },
      forecast: [],
      alerts: [],
    };

    if (dailyResult && dailyResult.status === 'fulfilled') {
      const days = (dailyResult.value && dailyResult.value.days) || [];
      result.forecast = days.slice(0, 7).map((day) => {
        const dayTime = day.daytime || {};
        const nightTime = day.nighttime || {};
        const dayPrecip = (dayTime.precipitation && dayTime.precipitation.amount) || {};
        return {
          date: String(day.forecastStartTime || '').slice(0, 10),
          textDay: (dayTime.condition && dayTime.condition.text) || '未知',
          textNight: (nightTime.condition && nightTime.condition.text) || '未知',
          tempMaxC: round1(day.temperatureMax && day.temperatureMax.value),
          tempMinC: round1(day.temperatureMin && day.temperatureMin.value),
          humidityPct: toPct(dayTime.humidity),
          precipitationMm: round1(dayPrecip.value || 0),
          precipitationProbabilityPct: toPct(dayTime.precipitation && dayTime.precipitation.probability),
          uvIndexMax: day.uvIndexMax,
          sunrise: day.astro && String(day.astro.sunrise || '').slice(11, 16),
          sunset: day.astro && String(day.astro.sunset || '').slice(11, 16),
        };
      });
    } else if (dailyResult) {
      result.forecastError = '预报接口暂时不可用';
    }

    if (alertResult && alertResult.status === 'fulfilled') {
      const payload = alertResult.value || {};
      const zero = payload.metadata && payload.metadata.zeroResult;
      result.alerts = zero
        ? []
        : (payload.alerts || []).map((alert) => ({
            event: alert.eventType && alert.eventType.name,
            level: alert.color && alert.color.code,
            severity: alert.severity,
            headline: alert.headline,
            sender: alert.senderName,
            effectiveTime: alert.effectiveTime,
            expireTime: alert.expireTime,
            instruction: alert.instruction,
          }));
    } else if (alertResult) {
      result.alertsError = '预警接口暂时不可用';
    }

    return result;
  }
}

module.exports = { QWeatherClient, WEATHER_TOOL };
