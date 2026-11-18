'use strict';

// 假 DSH：验证 plugin.js 的 headless 调用参数与事件解析（不连真模型）。
// 用法：node tests/fake-dsh.js --json ... "任务"
const task = process.argv[process.argv.length - 1];
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'fake-session-1' }) + '\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'final', text: '假 DSH 收到了：' + task }) + '\n');
}, 200);
