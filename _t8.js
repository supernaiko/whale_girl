const fs=require('fs');const path=require('path');
const cfg=JSON.parse(fs.readFileSync('C:/dev/whale-girl/app/data/plugins/yxn-chat.data/local-model.json','utf8'));
const lr=require('C:/dev/whale-girl/src/services/localReply');
(async()=>{const r=await lr.generate({text:'今天好累啊，不想上班',config:cfg,timeoutMs:60000});console.log(JSON.stringify(r));})();
