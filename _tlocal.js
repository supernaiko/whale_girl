const m = require('C:/dev/whale-girl/custom/plugins/yxn-chat/plugin.js');
(async () => {
  const t0 = Date.now();
  const reply = await m.generateLocalModelReply({
    localModel: { enabled: true, cmd: 'C:/dev/llama/llama-cli.exe', modelPath: 'C:/dev/models/qwen2.5-0.5b-instruct-q4_k_m.gguf', maxTokens: 64, minFreeRamMB: 512 },
    message: { text: '今天好累啊，不想上班' },
    deadline: Date.now() + 60000,
  });
  console.log('reply:', JSON.stringify(reply), 'ms:', Date.now() - t0);
})();