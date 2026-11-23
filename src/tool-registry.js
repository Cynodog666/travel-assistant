'use strict';

/**
 * 工具注册表：把「给模型看的 schema」和「真正干活的 handler」收在一处。
 *
 * 这样做的好处是天气这种可替换的能力可以按配置换实现——
 * 有和风 key 就用和风（实时 + 预报 + 预警），没有就退回高德的实时天气，
 * 但对模型来说永远只有一个叫 weather 的工具，不会出现两个天气工具抢着被选中的情况。
 */

class ToolRegistry {
  constructor() {
    this.handlers = new Map();
    this.schemas = [];
  }

  register({ schema, handler, name }) {
    const toolName = name || (schema && schema.function && schema.function.name);
    if (!toolName) throw new Error('注册工具时必须提供名字');
    if (typeof handler !== 'function') throw new Error(`工具 ${toolName} 缺少 handler`);
    if (this.handlers.has(toolName)) throw new Error(`工具重名：${toolName}`);

    this.handlers.set(toolName, handler);
    this.schemas.push(schema);
    return this;
  }

  has(name) {
    return this.handlers.has(name);
  }

  /** 直接喂给 chat/completions 的 tools 字段。 */
  get tools() {
    return this.schemas;
  }

  /** 只取指定名字的 schema（按名字集合顺序稳定），用于按需加载工具。 */
  schemasFor(names) {
    const wanted = names instanceof Set ? names : new Set(names || []);
    return this.schemas.filter((schema) => wanted.has(schema.function.name));
  }

  names() {
    return this.schemas.map((schema) => schema.function.name);
  }

  get size() {
    return this.schemas.length;
  }

  /** 调用工具；未知工具返回结构化错误，而不是抛异常。 */
  async run(name, args, options) {
    const handler = this.handlers.get(name);
    if (!handler) return { error: `未知工具：${name}` };
    return handler(args || {}, options || {});
  }
}

module.exports = { ToolRegistry };
