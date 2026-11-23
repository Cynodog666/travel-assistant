'use strict';

/**
 * 工具结果 → 前端卡片。
 *
 * 目的不是"更好看"，而是**别让模型用文字复述结构化数据**：车次、票价、余票这些
 * 一旦让模型重新排版，就会漏字段、算错时长、甚至把已售罄的写成有票。
 * 所以这里直接从原始结果生成卡片，前端原样渲染，模型只负责给结论。
 *
 * 只对"一看就是列表"的结果生成卡片，其它（坐标、天气对象等）返回 null，
 * 交给模型用文字表达。
 */

const { parsePythonLiteral } = require('./py-literal');

// 飞常准各种结果的开头前缀，解析前先去掉
const PREFIXES = [
  'Train tickets:',
  'Train stations:',
  'Flight search results:',
  'Flight prices:',
  'Flight and train transfer info:',
  'Transfer info:',
  'Today\'s date:',
];

const MAX_ROWS = 12;

/** 把工具返回值归一化成 JS 对象；失败返回 null。 */
function parseToolPayload(result) {
  if (result && typeof result === 'object') return result;
  if (typeof result !== 'string') return null;

  let text = result.trim();
  for (const prefix of PREFIXES) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    /* 继续试 Python 字面量 */
  }
  try {
    return parsePythonLiteral(text);
  } catch {
    return null;
  }
}

/** 找出真正的数据数组：飞常准有的在 data、有的在 data.data。 */
function pickRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const direct = payload.data;
  if (Array.isArray(direct)) return direct;
  if (direct && Array.isArray(direct.data)) return direct.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function minutesToText(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const h = Math.floor(value / 60);
  const m = Math.round(value % 60);
  return h ? `${h}h${m ? `${m}m` : ''}` : `${m}m`;
}

function hhmm(datetime) {
  const match = /(\d{2}:\d{2})/.exec(String(datetime || ''));
  return match ? match[1] : '';
}

/** 座位信息：取二等座，没有就取最便宜的有票座位。 */
function pickSeat(seatLists) {
  if (!Array.isArray(seatLists) || !seatLists.length) return null;
  const seats = seatLists.map((seat) => ({
    name: seat.seatName || '',
    price: Number(seat.seatPrice),
    left: Number(seat.ticketLeft),
  }));

  const second = seats.find((seat) => seat.name.includes('二等'));
  const pool = second ? [second] : seats.slice().sort((a, b) => a.price - b.price);
  const chosen = pool[0];
  if (!chosen) return null;

  return {
    name: chosen.name,
    price: Number.isFinite(chosen.price) ? chosen.price : null,
    left: Number.isFinite(chosen.left) ? chosen.left : null,
    soldOut: chosen.left === 0,
  };
}

function buildTrainCard(rows) {
  const trains = rows.filter((row) => row && row.trainNumber).slice(0, MAX_ROWS).map((row) => ({
    trainNumber: row.trainNumber,
    fromStation: row.fromStation || '',
    toStation: row.toStation || '',
    fromTime: row.fromTime || '',
    toTime: row.toTime || '',
    duration: minutesToText(row.useTime),
    seat: pickSeat(row.seatLists),
  }));
  if (!trains.length) return null;

  return {
    type: 'train-list',
    title: '火车票',
    subtitle: `${trains[0].fromStation} → ${trains[0].toStation}`.replace(/^ → | → $/g, ''),
    rows: trains,
    footer: '数据来自飞常准，余票为查询时刻快照',
  };
}

function buildFlightCard(rows) {
  const flights = rows
    .filter((row) => row && (row.FlightNo || row.flightNo))
    .slice(0, MAX_ROWS)
    .map((row) => ({
      flightNo: row.FlightNo || row.flightNo,
      airline: (row.FlightCompany || row.airlineName || '').replace(/股份有限公司|有限公司/g, ''),
      from: row.FlightDep || '',
      to: row.FlightArr || '',
      depTime: hhmm(row.FlightDeptimePlanDate || row.FlightDeptimeDate),
      arrTime: hhmm(row.FlightArrtimePlanDate || row.FlightArrtimeDate),
      duration: minutesToText(row.FlightDuration),
      fromAirport: (row.FlightDepAirport || '').replace(/机场$/, ''),
      toAirport: (row.FlightArrAirport || '').replace(/机场$/, ''),
      terminal: row.FlightTerminal || '',
      ontimeRate: row.OntimeRate || row.ArrOntimeRate || '',
      price: Number(row.BestPrice || row.Price || row.price || 0) || null,
      stopped: row.StopFlag === '1',
    }));
  if (!flights.length) return null;

  return {
    type: 'flight-list',
    title: '航班',
    subtitle: `${flights[0].from} → ${flights[0].to}`.replace(/^ → | → $/g, ''),
    rows: flights,
    footer: '数据来自飞常准；价格未含机建与燃油费',
  };
}

function buildStationCard(rows) {
  const stations = rows
    .filter((row) => row && row.station_name)
    .slice(0, MAX_ROWS)
    .map((row) => ({ name: row.station_name, code: row.station_code, city: row.city_name }));
  if (!stations.length) return null;
  return { type: 'station-list', title: '车站', rows: stations };
}

/**
 * 主入口：工具名 + 原始结果 → 卡片对象；不适合展示时返回 null。
 * 注意：返回 null 是正常情况，调用方不要当错误处理。
 */
function buildUiCard(toolName, result) {
  const payload = parseToolPayload(result);
  if (!payload) return null;

  // 服务端有时用 error_code 表达"查到了但没有数据"
  const data = payload.data;
  if (data && !Array.isArray(data) && data.error) return null;

  const rows = pickRows(payload);
  if (!rows.length) return null;

  const card =
    buildTrainCard(rows) ||
    buildFlightCard(rows) ||
    buildStationCard(rows);

  if (!card) return null;
  return { ...card, source: String(toolName || ''), count: card.rows.length };
}

module.exports = {
  buildUiCard,
  parseToolPayload,
  pickRows,
  buildTrainCard,
  buildFlightCard,
  buildStationCard,
  minutesToText,
  MAX_ROWS,
};
