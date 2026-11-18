const fs=require('fs');
const cfg=JSON.parse(fs.readFileSync('C:/dev/whale-girl/app/data/plugins/yxn-chat.data/local-model.json','utf8'));
const lr=require('C:/dev/whale-girl/src/services/localReply');
(async()=>{ for (const t of ['今天好累啊，不想上班','在干嘛呢','我饿了']) { const r=await lr.generate({text:t,config:cfg,timeoutMs:60000}); console.log(t,'->',JSON.stringify(r.text||r.error),r.via||'',(r.ms||0)+'ms'); } })();
