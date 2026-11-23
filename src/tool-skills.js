'use strict';

/**
 * 工具 skill 包（渐进式加载）。
 *
 * 问题：14 个工具的 JSON Schema 每轮都要塞进 prompt，光 tripmatch 那 8 个的描述
 * 就占掉相当一部分 token，而绝大多数对话根本用不到火车票/航班。
 *
 * 做法：把一组工具收进一个「skill」，基线只暴露核心工具 + 一个 use_skill。
 * 模型真需要时才调 use_skill 把整包 schema 注入**本会话后续轮次**，
 * 用不上的对话永远不会付这部分成本。
 *
 * 这和"少写点工具描述"是两个层次的事：描述该写清楚就写清楚，
 * 关键是让不相关的工具不出现在 prompt 里。
 */

class SkillCatalog {
  constructor(registry, packs = []) {
    this.registry = registry;
    const allNames = registry.names();

    this.packs = packs
      .map((pack) => {
        const tools = allNames.filter((name) => pack.match(name));
        return { ...pack, tools };
      })
      .filter((pack) => pack.tools.length > 0);
  }

  /** 被某个 skill 收起来的工具名（这些默认不注入 prompt）。 */
  get hiddenToolNames() {
    return [...new Set(this.packs.flatMap((pack) => pack.tools))];
  }

  names() {
    return this.packs.map((pack) => pack.name);
  }

  find(name) {
    return this.packs.find((pack) => pack.name === name) || null;
  }

  /** 给模型看的清单：只写"有什么、能干什么"，不写 schema。 */
  summaryText() {
    if (!this.packs.length) return '当前没有可加载的技能包。';
    const lines = this.packs.map(
      (pack) => `- ${pack.name}：${pack.title}（${pack.tools.length} 个工具）—— ${pack.description}`
    );
    return ['按需加载的工具包。需要用到其中能力时，先调用 use_skill 再调用具体工具。', ...lines].join('\n');
  }
}

/** 交给模型的 use_skill 工具定义。 */
function buildUseSkillSchema(catalog) {
  return {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        '按需加载一组工具。基线工具里没有火车票/航班能力，需要查这些时**先调用本工具**，' +
        '加载成功后下一轮就能直接调用具体工具。\n' +
        catalog.summaryText(),
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: `要加载的技能包：${catalog.names().join(' / ')}`,
            enum: catalog.names(),
          },
        },
        required: ['skill'],
      },
    },
  };
}

/**
 * 生成 use_skill 的 handler：
 * 把整包工具名记进当前会话，Agent 每轮按会话状态重建 tools 列表。
 */
function createUseSkillHandler({ catalog, sessions }) {
  return function useSkill(args, options = {}) {
    const name = String((args && args.skill) || '').trim();
    const pack = catalog.find(name);
    if (!pack) {
      return { error: `未知技能包：${name}`, available: catalog.names() };
    }
    if (!options.sessionId) {
      return { error: '缺少会话上下文，无法加载技能包' };
    }

    const session = sessions.touch(options.sessionId);
    if (!session.activeSkills) session.activeSkills = new Set();
    for (const toolName of pack.tools) session.activeSkills.add(toolName);

    return {
      activated: pack.name,
      tools: pack.tools,
      tip: '这些工具现在可以直接调用，本轮就可以用',
    };
  };
}

/**
 * 每轮重建 tools 列表：基线 + use_skill + 本会话已加载的 skill 工具。
 * 注意每次都重算，模型刚调完 use_skill，下一轮就能看到新工具。
 */
function createToolsResolver({ registry, catalog, sessions, baseNames }) {
  const base = [...baseNames];

  return function resolveTools(sessionId) {
    const session = sessionId ? sessions.peek(sessionId) : null;
    const names = new Set(base);

    if (session && session.activeSkills) {
      for (const toolName of session.activeSkills) {
        if (registry.has(toolName)) names.add(toolName);
      }
    }

    return registry.schemasFor(names);
  };
}

module.exports = { SkillCatalog, buildUseSkillSchema, createUseSkillHandler, createToolsResolver };
