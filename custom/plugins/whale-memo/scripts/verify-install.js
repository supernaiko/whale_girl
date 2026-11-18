'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const dir = 'C:\\Users\\1\\AppData\\Local\\Programs\\WhaleGirl\\data\\plugins';
const HOOKS = ['chat.received','chat.pre_reply','chat.search','chat.search_result','chat.prompt','chat.generate','chat.reply','chat.before_send','chat.dispatched','app.start','app.stop','timer.tick','tool.run'];
for (const id of ['whale-ops', 'whale-memo']) {
  const flowFile = dir + '\\' + id + '.flow.json';
  const grantFile = dir + '\\' + id + '.flow-grant.json';
  const bytes = fs.readFileSync(flowFile);
  const flow = JSON.parse(bytes.toString('utf8'));
  const grant = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const bad = (flow.hooks || []).filter(h => !HOOKS.includes(h));
  console.log(id, '| hooks:', (flow.hooks || []).join(','), bad.length ? 'BAD:' + bad : 'ok');
  console.log('   hash match:', sha === grant.hash, '| enabled:', grant.enabled, '| fullAccess:', grant.fullAccess, '| interval:', flow.intervalSeconds || '-', '| js bytes:', flow.javascript.length);
}
