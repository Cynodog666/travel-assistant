'use strict';

/**
 * 解析 Python 字面量（dict / list / str / int / float / True / False / None）。
 *
 * 为什么需要：飞常准 MCP 的 tools/call 结果是 Python `repr()` 字符串，不是 JSON：
 *   {'code': 200, 'data': [{'trainNumber': 'G52', ...}]}
 * 直接 JSON.parse 会炸。用一个确定性的小解析器，比拿正则替换引号可靠得多
 * （后者遇到文本里的撇号就会把结构改坏）。
 */

class PythonLiteralError extends Error {}

function parsePythonLiteral(input) {
  const text = String(input || '');
  let index = 0;

  const fail = (message) => {
    throw new PythonLiteralError(`${message}（位置 ${index}）`);
  };

  const skipWhitespace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };

  const parseString = () => {
    const quote = text[index];
    if (quote !== "'" && quote !== '"') fail('不是字符串起始');
    index += 1;
    let result = '';
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        const next = text[index + 1];
        index += 2;
        if (next === 'n') result += '\n';
        else if (next === 't') result += '\t';
        else if (next === 'r') result += '\r';
        else if (next === 'u') {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u 转义非法');
          result += String.fromCharCode(parseInt(hex, 16));
          index += 4;
        } else if (next === undefined) {
          fail('字符串未闭合');
        } else {
          result += next;
        }
        continue;
      }
      if (char === quote) {
        index += 1;
        return result;
      }
      result += char;
      index += 1;
    }
    return fail('字符串未闭合');
  };

  const parseNumber = () => {
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!match) fail('不是数字');
    index += match[0].length;
    return Number(match[0]);
  };

  const parseValue = () => {
    skipWhitespace();
    const char = text[index];
    if (char === undefined) fail('内容提前结束');

    if (char === '{') return parseDict();
    if (char === '[') return parseList();
    if (char === "'" || char === '"') return parseString();

    for (const [word, value] of [['True', true], ['False', false], ['None', null]]) {
      if (text.startsWith(word, index)) {
        index += word.length;
        return value;
      }
    }

    if (/[-0-9]/.test(char)) return parseNumber();
    return fail(`无法识别的字符 "${char}"`);
  };

  const parseDict = () => {
    index += 1; // {
    const object = {};
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return object;
    }

    while (index < text.length) {
      skipWhitespace();
      const key = parseValue();
      skipWhitespace();
      if (text[index] !== ':') fail('对象缺少冒号');
      index += 1;
      object[String(key)] = parseValue();
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return object;
        }
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return object;
      }
      return fail('对象缺少逗号或右花括号');
    }
    return fail('对象未闭合');
  };

  const parseList = () => {
    index += 1; // [
    const list = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return list;
    }

    while (index < text.length) {
      list.push(parseValue());
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return list;
        }
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return list;
      }
      return fail('列表缺少逗号或右方括号');
    }
    return fail('列表未闭合');
  };

  const value = parseValue();
  skipWhitespace();
  return value;
}

module.exports = { parsePythonLiteral, PythonLiteralError };
