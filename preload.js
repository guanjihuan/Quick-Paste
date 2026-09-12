/**
 * 预加载脚本：通过 contextBridge 把主进程能力安全地暴露给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 数据
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  // 同步写盘：仅用于 beforeunload 等不能 await 的场景，调用会阻塞渲染进程直到主进程写完
  saveDataSync: (data) => ipcRenderer.sendSync('data:saveSync', data),

  // 核心：把文本粘贴到当前焦点窗口
  // opts.hideFirst = true 时主进程走「隐藏 → Ctrl+V → 重新显示」流程
  paste: (text, opts) => ipcRenderer.invoke('paste', text, opts || {}),

  // 仅复制到剪贴板，不触发粘贴（用于「复制」按钮）
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),

  // 窗口控制
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  // 切换「始终置顶」，返回应用后的实际状态
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:setAlwaysOnTop', !!on),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // 要打字了（打开/关闭编辑弹窗）→ 临时允许窗口获得键盘焦点
  setTyping: (typing) => ipcRenderer.invoke('window:setTyping', typing),

  // 调整窗口透明度（设置面板里的滑块）
  setOpacity: (value) => ipcRenderer.invoke('window:setOpacity', value),

  // 数据文件路径
  getDataPath: () => ipcRenderer.invoke('app:getDataPath'),
  revealDataFile: () => ipcRenderer.invoke('app:revealDataFile'),

  // 在系统默认浏览器中打开外部链接（设置面板「关于」区使用）
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // 导出（保存对话框需要主进程；导入走隐藏 file input，无需 IPC）
  exportData: () => ipcRenderer.invoke('data:export'),
});