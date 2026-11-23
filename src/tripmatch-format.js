'use strict';

/**
 * 把飞常准的火车票结果「规范化」后再交给模型。
 *
 * 两个目的：
 *   1. 补上类型（高铁/动车/普速）——原始数据里没有这个字段，模型只能靠前缀猜，会猜错；
 *   2. 去掉一堆用不上的字段（时间戳、车站电报码、经纬度），原始 repr 又长又乱。
 *
 * 其它工具的结果原样透传，不做加工。
 */

const { parseToolPayload, pickRows, minutesToText } = require('./ui-cards');
const { classifyTrain } = require('./train-types');

const TRAIN_TOOL_PATTERN = /train/i;

function normalizeSeat(seat) {
  return {
    name: seat.seatName || '',
    price: Number(seat.seatPrice),
    left: Number(seat.ticketLeft),
  };
}

function normalizeTrainRow(row) {
  const type = classifyTrain(row.trainNumber);
  const seats = Array.isArray(row.seatLists) ? row.seatLists.map(normalizeSeat) : [];

  return {
    trainNumber: row.trainNumber,
    trainType: type.type,
    highSpeed: type.category === 'high-speed',
    from: row.fromStation || '',
    to: row.toStation || '',
    depart: row.fromTime || '',
    arrive: row.toTime || '',
    durationMin: Number(row.useTime) || null,
    // 直接给成品时长，省得模型自己用到达减出发算错
    duration: minutesToText(row.useTime),
    seats: seats.slice(0, 6),
  };
}

/**
 * @param {string} toolName  工具名（用来判断是不是火车票类）
 * @param {*} result         工具的原始返回
 * @returns {*} 规范化后的结果；不适用时原样返回
 */
function normalizeMcpResult(toolName, result) {
  if (!TRAIN_TOOL_PATTERN.test(String(toolName || ''))) return result;
  if (!result || typeof result !== 'string') return result;

  const payload = parseToolPayload(result);
  if (!payload) return result;

  const rows = pickRows(payload);
  const trains = rows.filter((row) => row && row.trainNumber);
  if (!trains.length) return result;

  return {
    tool: 'train_search',
    count: trains.length,
    note: 'trainType / highSpeed 已由系统按车次号判定，请直接使用，不要自行推测',
    trains: trains.map(normalizeTrainRow),
  };
}

module.exports = { normalizeMcpResult, normalizeTrainRow, normalizeSeat };
