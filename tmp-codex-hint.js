'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stub = path.join(os.tmpdir(), 'stub-codex-dbg.js');
fs.writeFileSync(stub, [
  "'use strict';",
  "const fs=require('fs');",
  "const a=process.argv.slice(2);",
  "const i=a.indexOf('--output-last-message');",
  "if(process.env.STUB_TASK_FILE)fs.writeFileSync(process.env.STUB_TASK_FILE,a[a.length-1]||'','utf8');",
  "if(i>=0)fs.writeFileSync(a[i+1],'STUB 结果','utf8');",
  "process.exit(0);",
].join('\n'), 'utf8');
process.env.WHALE_CODEX_BIN = stub;
process.env.STUB_TASK_FILE = path.join(os.tmpdir(), 'dbg-task.txt');
const plugin = require('./custom/plugins/whale-ops/plugin.js');
const OWNER = 'wxid_owner_test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wdbg-'));
const c = {
  message: { platform: 'wechat', chatId: OWNER, chatType: 'private', senderId: OWNER, text: '用 codex 找《假烟假酒假朋友》毛家超版歌词', atMe: true },
  settings: JSON.stringify({ prefix: '', owners: [OWNER], roots: [tmp], dsh: { workspace: tmp, timeoutSeconds: 120, syncWaitSeconds: 5 } }),
  state: {},
  whale: { sendText: async () => ({ id: 'm' }), paths: { pluginData: path.join(tmp, 'pd'), appData: tmp, appRoot: path.resolve('.') } },
};
(async () => {
  const plan = JSON.stringify({ action: 'codex', task: '找《假烟假酒假朋友》毛家超版歌词' });
  c.whale.model = async () => plan;
  const out = await plugin.hooks['chat.generate'](c);
  console.log('OUT=', JSON.stringify(out).slice(0, 400));
  try { console.log('TASK=', fs.readFileSync(process.env.STUB_TASK_FILE, 'utf8').slice(0, 200)); } catch (e) { console.log('no task file'); }
})();
