/**
 * 启动脚本：清除 ELECTRON_RUN_AS_NODE 等会干扰 Electron 的环境变量，
 * 然后直接 spawn electron.exe
 *
 * 解决 Git Bash / npm 环境里 ELECTRON_RUN_AS_NODE=1 导致 Electron 退化为 Node.js 的问题
 */
const path = require('path');
const { spawn } = require('child_process');

// 关键：清除会让 Electron 退化为普通 Node 的环境变量
delete process.env.ELECTRON_RUN_AS_NODE;
// 一些 npm/终端 会设置 ELECTRON_NO_ASAR，也清掉
delete process.env.ELECTRON_NO_ASAR;

const electronExe = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'electron.exe'
);

const args = [path.join(__dirname, '..'), ...process.argv.slice(2)];

console.log('Starting Electron:', electronExe);
console.log('Args:', args);

const child = spawn(electronExe, args, {
  stdio: 'inherit',
  windowsHide: false,
  env: process.env,
});

child.on('error', (err) => {
  // spawn 在可执行文件不存在（npm install 没跑 / 路径损坏）时只触发 'error'，
  // 不会触发 'exit'——不显式监听会让脚本静默挂起，用户只能强退。
  console.error(`启动 Electron 失败：${err.message}`);
  console.error(`请确认已运行 npm install，路径：${electronExe}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  // Electron 进程被信号杀掉时 code === null、signal 是 'SIGTERM' / 'SIGINT' 等，
  // 旧实现会静默吞掉、显示成「成功退出 0」，调试 SIGTERM 路径会很迷惑。
  if (signal) console.log(`Electron exited via signal: ${signal}`);
  process.exit(code ?? 0);
});