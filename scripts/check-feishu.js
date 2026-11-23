'use strict';

/**
 * 飞书导出自检：一步一步跑，哪一步挂了一眼就能看出来。
 *
 * 用法：npm run check:feishu
 * 只读 .env，不会改动任何飞书数据（除了建一篇测试文档，标题里写了「可删除」）。
 */

require('dotenv').config();

const { loadConfig } = require('../src/config');
const { FeishuClient } = require('../src/feishu');

const pass = (label, detail = '') => console.log(`  PASS  ${label}${detail ? `  → ${detail}` : ''}`);
const fail = (label, detail = '') => console.log(`  FAIL  ${label}${detail ? `  → ${detail}` : ''}`);

(async () => {
  console.log('\n【飞书导出自检】');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    fail('读取配置', error.message);
    process.exit(1);
  }

  if (!config.feishuAppId) {
    fail('飞书配置', 'FEISHU_APP_ID 为空，没开通飞书导出');
    process.exit(1);
  }
  pass('飞书配置已加载', `appId=${config.feishuAppId.slice(0, 8)}***`);

  if (!config.feishuWebOrigin) {
    fail('FEISHU_WEB_ORIGIN', '没填，导出后拿不到可点链接');
  } else if (/yourname|xxx|example/i.test(config.feishuWebOrigin)) {
    fail('FEISHU_WEB_ORIGIN', `看起来还是示例值：${config.feishuWebOrigin}（应该是你自己的租户域名）`);
  } else {
    pass('FEISHU_WEB_ORIGIN', config.feishuWebOrigin);
  }

  const client = new FeishuClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    webOrigin: config.feishuWebOrigin,
    linkShare: config.feishuLinkShare,
    shareTo: config.feishuShareTo,
    shareMemberType: config.feishuShareMemberType,
  });

  // 1) 能不能拿到 tenant_access_token —— 21001 基本都挂在这一步
  let documentId = null;
  try {
    await client.tenantToken();
    pass('获取 tenant_access_token');
  } catch (error) {
    fail('获取 tenant_access_token', error.message);
    console.log('\n  这个错误发生在「拿令牌」阶段，还没碰到任何文档 API。');
    console.log('  按可能性从高到低查：');
    console.log('    1. 应用是不是建在旧租户下？应用不能跨企业迁移，新企业里要重新建一个应用，');
    console.log('       换掉 FEISHU_APP_ID / FEISHU_APP_SECRET（最常见）。');
    console.log('    2. 账号是不是「个人版」？个人版拿不到 tenant_access_token（平台策略，社区已有多起报告）。');
    console.log('    3. 企业版：「版本管理与发布」里版本是否已发布上线；管理员是否在 admin.feishu.cn 启用了应用。');
    console.log('    4. 应用「安全设置」里的 IP 白名单 / API 访问控制，是否漏了服务器出口 IP。');
    console.log('    5. 确认应用类型是「企业自建应用」，不是商店应用/网页应用。');
    console.log('\n  拿不准的话：把上面这行完整报错（含 log_id）贴给飞书客服，他们能直接定位租户策略。');
    process.exit(1);
  }

  // 2) 能建文档吗
  try {
    documentId = await client.createDocument('权限自检（可删除）');
    pass('创建文档', `document_id=${documentId}`);
  } catch (error) {
    fail('创建文档', error.message);
    process.exit(1);
  }

  // 3) Markdown 转 block
  let converted = null;
  try {
    converted = await client.convertMarkdown('# 自检\n\n- 第一条\n- 第二条\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
    pass('Markdown 转 blocks', `${converted.blocks.length} 个 block`);
  } catch (error) {
    fail('Markdown 转 blocks', error.message);
    if (/权限|forbidden|403/i.test(error.message)) {
      console.log('    提示：多半是没开「文本内容转换为云文档块」这个权限，或开了没重新发布版本。');
    }
    process.exit(1);
  }

  // 4) 插进文档
  try {
    const inserted = await client.insertBlocks(documentId, converted);
    pass('批量插入 blocks', `${inserted} 个`);
  } catch (error) {
    fail('批量插入 blocks', error.message);
    process.exit(1);
  }

  // 5) 分享
  if (client.linkShare) {
    try {
      await client.setLinkShare(documentId, client.linkShare);
      pass('设置链接分享', client.linkShare);
    } catch (error) {
      fail('设置链接分享', error.message);
      console.log('    提示：这步需要「云文档权限」相关权限（drive:permission），开了要重新发布版本。');
    }
  }
  if (client.shareTo) {
    try {
      await client.grantPermission(documentId);
      pass('授权给指定协作者', client.shareTo);
    } catch (error) {
      fail('授权给指定协作者', error.message);
    }
  }

  const url = client.documentUrl(documentId);
  console.log('');
  console.log(url ? `文档链接：${url}` : `文档已创建，但没配 FEISHU_WEB_ORIGIN，只能给 document_id：${documentId}`);
  console.log('打开看看，能正常显示就说明整条链路通了。这篇测试文档可以直接删。\n');
})().catch((error) => {
  console.error('自检异常：', error);
  process.exit(1);
});
