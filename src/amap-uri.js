'use strict';

/**
 * 高德 URI API：把「路线」变成用户能直接点开的链接。
 *
 * 两个用途：
 *   - webLink：H5 链接（uri.amap.com），不需要 key，微信/浏览器里都能打开；
 *   - appLink：amapuri:// 深链，能直接唤起高德 App 开始导航。
 *
 * 注意坐标顺序是「经度,纬度」，而 amapuri 的参数名是 slat/slon，
 * 也就是经纬度分开传，这里别搞反。
 */

const MODE_CONFIG = {
  driving: { schemeType: 0, webMode: 'car' },
  transit: { schemeType: 1, webMode: 'bus' },
  walking: { schemeType: 2, webMode: 'walk' },
  riding: { schemeType: 3, webMode: 'ride' },
};

/** "116.4,39.9" → { lon, lat }；非法输入返回 null。 */
function parseLocation(location) {
  const parts = String(location || '').split(',');
  if (parts.length !== 2) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { lon, lat };
}

/** 用 encodeURIComponent 拼查询串（URLSearchParams 会把空格变成 +，在地图参数里会解析错）。 */
function toQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/**
 * 生成导航链接。
 * @returns {{appLink: string, webLink: string} | null} 坐标非法时返回 null
 */
function buildNavigationLinks({
  origin,
  destination,
  originName = '起点',
  destinationName = '终点',
  mode = 'driving',
  src = 'kun-kun-travel',
} = {}) {
  const from = parseLocation(origin);
  const to = parseLocation(destination);
  if (!from || !to) return null;

  const config = MODE_CONFIG[mode] || MODE_CONFIG.driving;

  const appLink =
    'amapuri://route/plan/?' +
    toQuery({
      slat: from.lat,
      slon: from.lon,
      sname: originName,
      dlat: to.lat,
      dlon: to.lon,
      dname: destinationName,
      dev: 0,
      t: config.schemeType,
    });

  const webLink =
    'https://uri.amap.com/navigation?' +
    toQuery({
      from: `${from.lon},${from.lat},${originName}`,
      to: `${to.lon},${to.lat},${destinationName}`,
      mode: config.webMode,
      policy: 1,
      src,
      coordinate: 'gaode',
      callnative: 0,
    });

  return { appLink, webLink };
}

module.exports = { buildNavigationLinks, parseLocation, MODE_CONFIG };
