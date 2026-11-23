'use strict';

/**
 * 高德地图工具集：接口地址、缓存、统一请求入口、4 个工具的定义与实现。
 *
 * 改成 class 是为了让测试能塞一个假 cache / 假 axios 进来，
 * 也避免模块级可变状态在多个实例之间互相污染。
 */

const axios = require('axios');
const { LRUCache } = require('./lru-cache');

const AMAP_HOST = 'https://restapi.amap.com';

// 只存路径，host 由 baseUrl 决定（测试可以指到本地假服务，部署也可以挂代理）
const AMAP_PATHS = {
  geoCode: '/v3/geocode/geo',
  regeoCode: '/v3/geocode/regeo',
  poiSearch: '/v3/place/text',
  driving: '/v3/direction/driving',
  walking: '/v3/direction/walking',
  weather: '/v3/weather/weatherInfo',
};

const AMAP_ENDPOINTS = Object.fromEntries(
  Object.entries(AMAP_PATHS).map(([service, url]) => [service, AMAP_HOST + url])
);

/** 交给模型的 Function Calling 描述。 */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'geocode',
      description: '把中文地址或地名解析成经纬度坐标，并返回行政区划编码。',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: '详细地址或地名，例如「长沙市岳麓山」' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'poi_search',
      description: '按关键词搜索地点（酒店、餐厅、景点等），返回名称、地址、坐标和电话。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '搜索关键词，例如「外滩附近酒店」' },
          city: { type: 'string', description: '限定城市，例如「上海」。不确定时留空。' },
        },
        required: ['keywords'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'route_planning',
      description: '规划两点之间的路线，返回距离、预计耗时和主要路段的行驶指引。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: '起点地址或地名' },
          destination: { type: 'string', description: '终点地址或地名' },
          mode: { type: 'string', enum: ['driving', 'walking'], description: '出行方式，默认驾车' },
        },
        required: ['origin', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: '查询某个城市当前的实时天气。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，例如「长沙」' },
        },
        required: ['city'],
      },
    },
  },
];

class AmapClient {
  constructor({ key, baseUrl = AMAP_HOST, cacheSize = 200, timeoutMs = 8000, http = axios }) {
    if (!key) throw new Error('AmapClient 需要一个 key');
    this.key = key;
    this.baseUrl = String(baseUrl || AMAP_HOST).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.http = http;
    this.cache = new LRUCache(cacheSize);
  }

  endpointOf(service) {
    const url = AMAP_PATHS[service];
    if (!url) throw new Error(`未知的高德服务: ${service}`);
    return this.baseUrl + url;
  }

  /**
   * 统一的高德请求入口：拼 key、判错、写缓存。
   *
   * 注意：高德的错误不是 HTTP 错误码——HTTP 200 + status "0" 才是失败，
   * 所以必须判 data.status，不能只看 response.status。
   */
  async request(service, params, { signal } = {}) {
    const endpoint = this.endpointOf(service);

    const cacheKey = `${service}:${JSON.stringify(params)}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const { data } = await this.http.get(endpoint, {
      params: { ...params, key: this.key, output: 'json' },
      timeout: this.timeoutMs,
      signal,
    });

    if (!data || data.status !== '1') {
      throw new Error(`高德接口返回异常（${service}）：${(data && data.info) || '未知错误'}`);
    }

    this.cache.set(cacheKey, data);
    return data;
  }

  async resolveLocation(address, options) {
    const data = await this.request('geoCode', { address }, options);
    const first = data.geocodes && data.geocodes[0];
    if (!first) throw new Error(`无法解析地址：${address}`);
    return { location: first.location, adcode: first.adcode, formatted: first.formatted_address };
  }

  /** 执行一个工具调用；参数不合法或接口异常都靠抛错，由 agent 捕获后回填给模型。 */
  async run(name, args, options = {}) {
    const input = args && typeof args === 'object' ? args : {};

    switch (name) {
      case 'geocode': {
        if (!input.address) return { error: '缺少参数 address' };
        const data = await this.request('geoCode', { address: input.address }, options);
        const geocodes = data.geocodes || [];
        if (!geocodes.length) return { message: `没有解析出「${input.address}」的坐标` };
        return geocodes.slice(0, 1).map((g) => ({
          address: g.formatted_address,
          location: g.location,
          province: g.province,
          city: g.city || g.province,
          district: g.district,
          adcode: g.adcode,
        }));
      }

      case 'poi_search': {
        if (!input.keywords) return { error: '缺少参数 keywords' };
        const params = { keywords: input.keywords, pageSize: 10 };
        if (input.city) params.city = input.city;
        const data = await this.request('poiSearch', params, options);
        const pois = data.pois || [];
        if (!pois.length) return { message: `没有搜到「${input.keywords}」相关的地点` };
        return {
          count: Number(data.count || pois.length),
          pois: pois.slice(0, 5).map((p) => ({
            name: p.name,
            address: p.address,
            location: p.location,
            tel: p.tel || '无',
            type: p.type,
          })),
        };
      }

      case 'route_planning': {
        if (!input.origin || !input.destination) return { error: '缺少参数 origin 或 destination' };
        const mode = input.mode === 'walking' ? 'walking' : 'driving';
        const [origin, destination] = await Promise.all([
          this.resolveLocation(input.origin, options),
          this.resolveLocation(input.destination, options),
        ]);
        const data = await this.request(
          mode,
          { origin: origin.location, destination: destination.location },
          options
        );
        const route = data.route;
        const path = route && route.paths && route.paths[0];
        if (!path) return { message: '没有规划出可用路线，可能是起终点太近或地址无法解析' };
        return {
          mode: mode === 'walking' ? '步行' : '驾车',
          distanceKm: Number((Number(path.distance) / 1000).toFixed(2)),
          durationMin: Math.round(Number(path.duration) / 60),
          steps: (path.steps || []).slice(0, 10).map((s) => s.instruction),
        };
      }

      case 'weather': {
        if (!input.city) return { error: '缺少参数 city' };
        const located = await this.resolveLocation(input.city, options);
        const data = await this.request(
          'weather',
          { city: located.adcode, extensions: 'base' },
          options
        );
        const live = data.lives && data.lives[0];
        if (!live) return { message: `没有查到「${input.city}」的天气` };
        return {
          city: live.city,
          weather: live.weather,
          temperatureC: live.temperature,
          wind: `${live.winddirection}风 ${live.windpower}级`,
          humidity: live.humidity,
          reportTime: live.reporttime,
        };
      }

      default:
        return { error: `未知工具：${name}` };
    }
  }
}

module.exports = { AmapClient, AMAP_ENDPOINTS, TOOLS };
