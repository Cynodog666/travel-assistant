'use strict';

require('dotenv').config({ path: __dirname + '/../.env' });

const { loadConfig } = require('../src/config');
const { FeishuClient } = require('../src/feishu');

const docId = process.argv[2];
const T = { 2: 'text', 3: 'h1', 4: 'h2', 12: 'bullet', 13: 'ordered', 15: 'quote', 19: 'callout', 22: 'divider', 31: 'table' };

(async () => {
  const config = loadConfig();
  const client = new FeishuClient({ appId: config.feishuAppId, appSecret: config.feishuAppSecret });
  const path = '/open-apis/docx/v1/documents/' + docId + '/blocks';
  const data = await client.request('GET', path, { query: { page_size: 500 } });
  const roots = (data.items || []).filter((b) => b.parent_id === docId);

  let prev = null;
  let adjacent = 0;
  roots.forEach((b) => {
    if (b.block_type === 22 && prev === 22) adjacent += 1;
    prev = b.block_type;
  });

  const count = (t) => roots.filter((b) => b.block_type === t).length;

  console.log('根级子块:', roots.length);
  console.log('高亮块:', count(19), ' 分割线:', count(22), ' 相邻重复分割线:', adjacent);
  console.log('标题:', count(3) + count(4), ' 列表项:', count(12) + count(13), ' 表格:', count(31));

  console.log('\n结构预览:');
  roots.slice(0, 14).forEach((b, i) => {
    const holder = b.text || b.heading1 || b.heading2 || b.heading3 || b.quote || b.callout;
    let text = '';
    if (holder && holder.elements) {
      text = holder.elements.map((e) => (e.text_run && e.text_run.content) || '').join('');
    }
    if (b.block_type === 22) text = '────────';
    console.log('  ' + String(i).padStart(2) + ' ' + String(T[b.block_type] || b.block_type).padEnd(8) + text.slice(0, 44));
  });
})();
