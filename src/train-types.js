'use strict';

/**
 * 车次类型判定。
 *
 * 为什么需要单独一个模块：飞常准返回的 trainNumber 只有车次号（G52 / Z227 / V1036），
 * **没有任何"车次类型"字段**。模型只好自己从前缀猜，结果就是把 V 开头的普速夜车
 * 也说成"高铁"。这个判定必须是确定性的，不能交给语言模型。
 *
 * 前缀规则（12306 的车次结构）：
 *   G 高铁 · C 城际 · D 动车 · S 市域   → 高速列车
 *   Z 直达特快 · T 特快 · K 快速 · Y 旅游 · L 临客 · V 普速 → 普速列车
 *   纯数字 → 普快
 */

const HIGH_SPEED_PREFIXES = {
  G: { type: '高铁', label: '高铁', category: 'high-speed' },
  C: { type: '城际', label: '城际', category: 'high-speed' },
  D: { type: '动车', label: '动车', category: 'high-speed' },
  S: { type: '市域', label: '市域', category: 'high-speed' },
};

const NORMAL_PREFIXES = {
  Z: { type: '直达特快', label: '普速', category: 'normal' },
  T: { type: '特快', label: '普速', category: 'normal' },
  K: { type: '快速', label: '普速', category: 'normal' },
  Y: { type: '旅游', label: '普速', category: 'normal' },
  L: { type: '临客', label: '普速', category: 'normal' },
  // 数据里真实出现过 V（如 V1036、V1072），从座位（软卧/硬卧）看是普速夜车
  V: { type: '普速', label: '普速', category: 'normal' },
};

const UNKNOWN = { type: '未知', label: '未知', category: 'unknown' };

/**
 * @returns {{prefix: string, type: string, label: string, category: 'high-speed'|'normal'|'unknown'}}
 */
function classifyTrain(trainNumber) {
  const value = String(trainNumber || '').trim().toUpperCase();
  if (!value) return { prefix: '', ...UNKNOWN };

  const prefix = value[0];

  if (/^\d/.test(value)) {
    return { prefix: '#', type: '普快', label: '普速', category: 'normal' };
  }
  if (HIGH_SPEED_PREFIXES[prefix]) {
    return { prefix, ...HIGH_SPEED_PREFIXES[prefix] };
  }
  if (NORMAL_PREFIXES[prefix]) {
    return { prefix, ...NORMAL_PREFIXES[prefix] };
  }
  return { prefix, ...UNKNOWN };
}

const isHighSpeed = (trainNumber) => classifyTrain(trainNumber).category === 'high-speed';

module.exports = { classifyTrain, isHighSpeed, HIGH_SPEED_PREFIXES, NORMAL_PREFIXES };
