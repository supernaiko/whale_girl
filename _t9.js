const fs=require('fs');
const cfg=JSON.parse(fs.readFileSync('C:/dev/whale-girl/app/data/plugins/yxn-chat.data/local-model.json','utf8'));
const sys = '你叫雅小奈，微信私聊里随口回一句。口语、短，别重复对方的话，别解释，别自称AI，不超过20字。';
const text = '今天好累啊，不想上班';
const variants = [
  sys + '\n\n对方说：下雨了\n你回：懒得带伞\n\n对方说：' + text + '\n你回：',
  sys + '\n\n对方：' + text + '\n你：',
];
const lr = require('C:/dev/whale-girl/src/services/localReply');
(async()=>{
  for (const [i,v] of variants.entries()) {
    const r = await lr.generate({ text, instruction: sys + (i===0 ? '\n\n示例：\n对方说：下雨了\n你回：懒得带伞' : ''), config: cfg, timeoutMs: 60000 });
    console.log(i, JSON.stringify(r.text || r.error));
  }
})();
