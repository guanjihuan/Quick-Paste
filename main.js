/**
 * 主进程：创建悬浮窗口、托盘、IPC 处理、用 Windows API 立即触发粘贴
 */
// 必须在 require('electron') 之前执行！
// 某些环境（如 npm bash）会把 ELECTRON_RUN_AS_NODE=1 设进环境，
// 这会让 Electron 退化成普通 Node.js，无法访问 electron API。
delete process.env.ELECTRON_RUN_AS_NODE;

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  clipboard,
  dialog,
  screen,
  nativeImage,
  shell,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// 必须发生在 app.whenReady 之前：通过开关抑制一些无害但刷屏的 Chromium 警告
// （GPU 进程退出、Network service 重启等）。
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ==================== 单实例锁 ====================
// 本应用「关闭窗口 = 隐藏到托盘」，用户很容易忘记它还在后台跑，
// 于是又去双击一次桌面快捷方式。没有这把锁的话会起第二个实例，后果是：
//   1. 托盘里出现两个图标，点哪个都只控制其中一半；
//   2. 两个实例各自持有整份数据的内存副本，都会往同一个 data.json 写 ——
//      后保存的那个会把先保存的改动整段覆盖掉，用户新加的短语凭空消失；
//   3. Ctrl+Shift+V 全局快捷键只有先启动的那个能注册成功。
// 拿不到锁就直接退出，并让已经在跑的那个实例把窗口亮出来。
//
// 注意：CommonJS 模块被包在函数里，这里的顶层 return 在 CJS 下也是合法的，
// 但 ESM 化（package.json 加 "type": "module" 或改 .mjs）后会立刻崩。
// 改用 process.exit 更稳，跨模块系统都安全。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  // 第二个实例启动了 → 把我们的悬浮窗唤出来，等价于用户点了托盘图标
  if (mainWindow && !mainWindow.isDestroyed()) {
    showFloating();
  }
});

// 必须发生在 app.whenReady 之前：把 Electron 的缓存目录显式指向用户数据里的子目录，
// 避免每次启动时它去尝试「迁移默认缓存到 userData」——Windows 上迁移失败会刷一堆
// cache_util_win.cc ERROR，虽然不影响功能但日志很难看。
try {
  app.setPath('cache', path.join(app.getPath('appData'), 'quick-paste-cache'));
} catch (e) {
  console.warn('set cache path failed:', e);
}

// 仅在 Windows 上引入 koffi 调用系统 DLL
let koffi = null;
let user32 = null;
let kernel32 = null;
let SetForegroundWindow = null;
let GetForegroundWindow = null;
let GetWindowThreadProcessId = null;
let AttachThreadInput = null;
let GetCurrentThreadId = null;
let IsWindow = null;
let keybd_event = null;

if (process.platform === 'win32') {
  try {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    kernel32 = koffi.load('kernel32.dll');

    SetForegroundWindow = user32.func('SetForegroundWindow', 'bool', ['void*']);
    GetForegroundWindow = user32.func('GetForegroundWindow', 'void*', []);
    GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['void*', 'void*']);
    AttachThreadInput = user32.func('AttachThreadInput', 'bool', ['uint32', 'uint32', 'bool']);
    IsWindow = user32.func('IsWindow', 'bool', ['void*']);
    keybd_event = user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'intptr']);

    // GetCurrentThreadId 在 kernel32.dll
    GetCurrentThreadId = kernel32.func('GetCurrentThreadId', 'uint32', []);
  } catch (e) {
    console.error('koffi load failed:', e);
  }
}

const VK_CONTROL = 0x11;
const VK_V = 0x56;
const KEYEVENTF_KEYUP = 0x02;

const isDev = !app.isPackaged;
// 注意：userData 路径依赖 app 初始化状态，在 whenReady 里再解析更稳妥
let userDataPath = null;

// 构建标记：用户跑应用时看到这个 banner 就知道是含本次「快捷键自定义」的最新代码。
// 调整 settings 面板里的快捷键录制 / 恢复默认相关问题时同步修改此字符串。
const BUILD_TAG = 'shortcut-customize-2026-09-16';
console.log(`[quick-paste] build: ${BUILD_TAG}`);

let mainWindow = null;
let tray = null;
let isQuitting = false;

// 始终置顶开关：默认开启（这是悬浮粘贴工具的核心体验）。
// 主进程持有「真相源」：窗口本身可能已被用户从 Windows 任务栏右键菜单里改过，
// 但渲染进程保存的偏好才是用户期望的，启动时用它覆盖回去。
let alwaysOnTop = true;

// 开机自启动触发的本次启动：默认 false。
// `app.whenReady` 里会调 app.getLoginItemSettings() 检测本次启动是否来自登录项，
// 如果是（wasOpenedAtLogin / wasOpenedAsHidden 任一为真），
// 窗口就不在 ready-to-show 自动弹出，保持隐藏在托盘里——
// 避免用户每次登录 Windows 都被迫看到一个悬浮窗跳出来。
let startedAtLogin = false;

// 上次前台窗口句柄（用于粘贴前主动切回）
let lastFgHwnd = null;
let ourThreadId = 0;
const ourPid = process.pid;
// 前台窗口轮询定时器
let fgTrackTimer = null;

/* ==================== 数据持久化 ==================== */
const DATA_SCHEMA_VERSION = 1;
// 短语内容上限：100KB，挡住手抖粘贴整个文件 / 滥用脚本导致剪贴板异常
const MAX_PHRASE_CONTENT_LENGTH = 100 * 1024;

// 只读窗口位置（不参与完整数据校验，启动早期就要拿到）
function readSavedBounds() {
  try {
    if (!userDataPath || !fs.existsSync(userDataPath)) return null;
    const raw = fs.readFileSync(userDataPath, 'utf-8');
    const data = JSON.parse(raw);
    const b = data && data.settings && data.settings.windowBounds;
    if (
      b && Number.isFinite(b.x) && Number.isFinite(b.y) &&
      Number.isFinite(b.width) && Number.isFinite(b.height)
    ) {
      // 多显示器：找到窗口中心点最近的显示器，把窗口整体夹回它的工作区。
      // 副屏拔了、分辨率改了导致窗口跑到屏幕外的情况都不会丢。
      const displays = screen.getAllDisplays();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const nearest = screen.getDisplayNearestPoint({ x: cx, y: cy }) || displays[0];
      const wa = nearest.workArea;
      const width = Math.max(280, Math.min(b.width, wa.width, 800));
      const height = Math.max(360, Math.min(b.height, wa.height, 900));
      // 关键：x/y 必须保证窗口完整落在 wa 内，否则用户找不到窗口
      const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - width));
      const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - height));
      return { x, y, width, height };
    }
  } catch {}
  return null;
}

function uid(prefix = 'id') {
  // 8 字节随机熵 ≈ 1.8e19 组合，比原来 4 字符 (~65K) 几乎不可能碰撞
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function getDefaultData() {
  return {
    version: DATA_SCHEMA_VERSION,
    groups: [
      {
        id: 'grp_default',
        name: '常用',
        phrases: [
          { id: 'phr_1', title: '你好', content: '你好，很高兴认识你！', fav: false, useCount: 0 },
          { id: 'phr_2', title: '收到', content: '收到，我会尽快处理。', fav: false, useCount: 0 },
        ],
      },
      {
        id: 'grp_work',
        name: '工作',
        phrases: [
          { id: 'phr_3', title: '开会通知', content: '各位同事，今天下午 3 点在会议室 A 开会，请准时参加。', fav: false, useCount: 0 },
        ],
      },
    ],
    activeGroupId: 'grp_default',
    recent: [],
    settings: {},
  };
}

function loadData() {
  try {
    if (fs.existsSync(userDataPath)) {
      const raw = fs.readFileSync(userDataPath, 'utf-8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.groups)) {
        // 容错：每条 group 必须有 id/name/phrases 数组，过滤掉畸形项
        const cleaned = data.groups
          .filter((g) => g && typeof g === 'object')
          .map((g) => ({
            id: typeof g.id === 'string' ? g.id : uid('grp'),
            name: typeof g.name === 'string' ? g.name : '未命名分组',
            phrases: Array.isArray(g.phrases)
              ? g.phrases
                  .filter((p) => p && typeof p === 'object' && typeof p.content === 'string')
                  .map((p) => ({
                    id: typeof p.id === 'string' ? p.id : uid('phr'),
                    title: typeof p.title === 'string' ? p.title : '',
                    // 截断异常大的内容（防手抖 / 防被外部脚本注入巨型数据）
                    content: p.content.slice(0, MAX_PHRASE_CONTENT_LENGTH),
                    // 收藏标志。旧数据只有 pinned，这里一次性迁移成 fav。
                    // 迁移后必须丢弃 pinned：否则 fav 已经被用户关掉、pinned 还留着 true 时，
                    // 下次启动这个 `p.fav || p.pinned` 会把收藏又打开 —— 取消收藏永远存不住。
                    fav: typeof p.fav === 'boolean' ? p.fav : !!p.pinned,
                    // 使用次数（被粘贴/复制过的次数，统计用）
                    useCount: typeof p.useCount === 'number' && p.useCount >= 0 ? p.useCount : 0,
                  }))
              : [],
          }));
        // 空分组必须保留！之前这里会把 phrases 为空的分组过滤掉，
        // 于是「新建分组」「清空短语」之后一重启，那个分组就凭空消失了。
        // 只有整份数据连一个分组都没有时才回落到默认数据。
        const groups = cleaned.length > 0 ? cleaned : getDefaultData().groups;
        // 最近使用列表：渲染进程维护的 [{id, ts}]
        const recent = Array.isArray(data.recent)
          ? data.recent
              .filter((r) => r && typeof r === 'object' && typeof r.id === 'string')
              .slice(0, 50)
          : [];
        return {
          version: DATA_SCHEMA_VERSION,
          groups,
          activeGroupId:
            typeof data.activeGroupId === 'string' &&
            groups.some((g) => g.id === data.activeGroupId)
              ? data.activeGroupId
              : groups[0].id,
          recent,
          // 透传 settings（如 windowBounds），让用户在主进程直接读写它
          settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
        };
      }
    }
  } catch (e) {
    console.error('load data error:', e);
  }
  return getDefaultData();
}

// 原子化写盘：先写临时文件再 rename，避免崩溃时留下损坏的 data.json
// 返回 { ok, error }：渲染端能区分成功 / 失败，把失败 toast 出来
function saveData(data) {
  try {
    fs.mkdirSync(path.dirname(userDataPath), { recursive: true });
    // 注入版本号；后续做迁移时按这个字段分支
    const payload = JSON.stringify({ ...data, version: DATA_SCHEMA_VERSION }, null, 2);
    const tmp = userDataPath + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf-8');
    fs.renameSync(tmp, userDataPath);
    return { ok: true };
  } catch (e) {
    console.error('save data error:', e);
    return { ok: false, error: e.message || String(e) };
  }
}

/* ==================== 窗口创建 ==================== */
// 把 alwaysOnTop 的「真相源」应用到窗口上：不存在时直接 return。
// 注意：必须保留旧的 setAlwaysOnTop(true, 'floating') 默认行为路径，
// showFloating / pasteByHiding 仍然依赖它把窗口拉回顶层。
function applyAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // 'floating' 是 Windows 上的「在最前面」层级，比 normal top 更高，
    // 大多数全屏应用都能压住它。
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
  } catch (e) {
    console.error('applyAlwaysOnTop error:', e);
  }
}

// 窗口位置记忆：用户拖到哪里下次就在哪里启动
// 写盘是 debounce 的（300ms）避免拖动过程刷文件
//
// Bug 修复：原实现 `loadData() → 修改 → saveData()` 会从盘上读全量数据再合并窗口位置。
// 如果渲染层在这 300ms 窗口内也调了 data:save 并完成落盘，主进程后续写盘会把磁盘
// 上那份更新过的数据（用户最新的短语改动）覆盖掉，造成数据丢失。
// 改为：缓存最近一次由 data:save 写入的完整数据快照，更新窗口位置时直接复用这份
// 快照，绝不再从盘读。
let cachedDataSnapshot = null;
// 启动期一次性读盘快照：createWindow 读 alwaysOnTop、whenReady 读 savedAcc
// 原本各调一次 loadData —— 整份 JSON 解析 + 字段容错走两遍，对几百条短语的小库
// 都能感知到。合到一处，createWindow/applyGlobalShortcut 直接读这里的字段。
let bootDataSnapshot = null;
let saveBoundsTimer = null;
function scheduleSaveBounds() {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const b = mainWindow.getBounds();
      // 优先用最近一次 data:save 传入的快照；快照不存在（应用刚启动、还没
      // 任何渲染层写入）时再退回到读盘路径。
      if (cachedDataSnapshot) {
        cachedDataSnapshot.settings = {
          ...(cachedDataSnapshot.settings || {}),
          windowBounds: b,
        };
        saveData(cachedDataSnapshot);
      } else {
        const data = loadData();
        data.settings = { ...(data.settings || {}), windowBounds: b };
        saveData(data);
        cachedDataSnapshot = data;
      }
    } catch (e) {
      console.error('save bounds error:', e);
    }
  }, 300);
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  // 优先用上次保存的位置/大小；首启动或位置跑到屏幕外时回落默认
  const saved = readSavedBounds();
  const bounds = saved || {
    width: 380,
    height: 560,
    x: Math.max(0, sw - 400),
    y: 80,
  };

  // 启动时把磁盘上的 alwaysOnTop 偏好读进来；
  // 复用 whenReady 里已经读过的 bootDataSnapshot，避免再 loadData 一遍（几百条短语
  // 时 JSON 解析走两遍会感知到；旧数据没这个字段时 loadData 已经容错，bootDataSnapshot
  // 至少有 settings = {}，取默认值 true 即可）。
  if (bootDataSnapshot) {
    const savedAlways = bootDataSnapshot.settings && bootDataSnapshot.settings.alwaysOnTop;
    alwaysOnTop = savedAlways === undefined ? true : !!savedAlways;
  } else {
    // 兜底：bootDataSnapshot 没拿到（loadData 抛错被吞）→ 默认开启
    alwaysOnTop = true;
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 280,
    minHeight: 360,
    // 上限：避免被拖成全屏把内容扯稀烂；长内容让用户自己加大字号或滚动
    maxWidth: 800,
    maxHeight: 900,
    // 任务栏 / Alt-Tab 缩略图显示的图标。ico 内置 16/32/48 等多尺寸，
    // Windows 会按场景自动挑合适的；Linux/macOS 下 Electron 也会自动转换。
    icon: path.join(__dirname, 'icon.ico'),
    frame: false,
    // 初始值用 alwaysOnTop 偏好的临时快照（之前的临时快照就是模块级变量本身，
    // 这里直接读取即可）；setAlwaysOnTop 由 applyAlwaysOnTop() 统一收口。
    alwaysOnTop,
    resizable: true,
    maximizable: false,
    minimizable: true,
    skipTaskbar: false,
    backgroundColor: '#08090A',
    title: '快速粘贴',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  applyAlwaysOnTop();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 窗口保持可聚焦（这样搜索框能直接接收键盘事件），但显示用 showInactive 不抢外部焦点。
  // 旧的 setNoActivate(true) 会让整窗口 setFocusable(false)，搜索框也跟着收不到按键，
  // 那是无法接受的硬 bug。点短语走 hide → paste → show 路径，不依赖 noActivate 模式。
  mainWindow.setFocusable(true);

  // 拖动 / 拉伸后记住位置
  mainWindow.on('move', scheduleSaveBounds);
  mainWindow.on('resize', scheduleSaveBounds);

  mainWindow.once('ready-to-show', () => {
    // 开机自启动触发的启动 → 窗口保持隐藏在托盘里，
    // 用户按 Ctrl+Shift+V 或点托盘图标才会显示，避免每次登录都跳出来。
    if (!startedAtLogin) showFloating();
  });

  // 关闭按钮 → 最小化到托盘，而不是退出
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// 显示悬浮窗：用 showInactive 避免把焦点从目标输入框抢走。
// 窗口本身保持 setFocusable(true)（见 createWindow），让搜索框能直接接收键盘事件。
// 弹窗（编辑短语/新建分组等）需要主动接管键盘，仍由 setTyping 调用 mainWindow.focus()。
function showFloating() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.showInactive();
  // showInactive 之后层级有时会被 Windows 重置；重新应用一次置顶偏好
  // 否则用户关掉置顶 → 隐藏 → 再唤起时窗口可能"复活"为置顶态。
  applyAlwaysOnTop();
}

/* ==================== 托盘 ==================== */
// 托盘图标使用项目根目录的 icon.ico：它内置了 16/32 等多种尺寸，
// Windows 任务栏托盘会自动挑选最合适的那一档显示。
// 原 fallback 路径（assets/tray.png）不再维护 —— 始终从 icon.ico 加载。
const TRAY_ICON_PATH = path.join(__dirname, 'icon.ico');

function createTray() {
  let trayIcon;
  if (fs.existsSync(TRAY_ICON_PATH)) {
    trayIcon = nativeImage.createFromPath(TRAY_ICON_PATH);
  } else {
    // 极端兜底：icon.ico 不在时给个透明占位，避免 Tray 构造抛错把托盘拉崩
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('快速粘贴');

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => toggleWindow() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleWindow());
}

function toggleWindow() {
  // isVisible()/hide()/show() 都会抛 "Object has been destroyed"
  // 在 quit 路径下（isQuitting=true、will-quit 还没反注册全局快捷键之前）可能撞上，
  // 这里显式拦一下,避免未捕获异常把渲染 / 托盘拉崩。
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showFloating();
  }
}

/* ==================== 窗口句柄工具 ==================== */
// koffi 返回的 HWND 是 External 指针对象，Electron 的 getNativeWindowHandle() 返回 Buffer，
// 两者直接用 !== 比较永远不相等 → 必须统一换算成数值地址再比。
function hwndAddr(hwnd) {
  if (!hwnd || !koffi) return 0n;
  try {
    return BigInt(koffi.address(hwnd));
  } catch {
    return 0n;
  }
}

// 本进程所有窗口的句柄地址（兜底用）
// 注意：用 process.arch 判断位数比看 Buffer.length 更稳——
// Electron 在不同版本上 getNativeWindowHandle 返回 Buffer 的长度有时不完全等于本机指针宽度
const IS_64BIT = process.arch === 'x64' || process.arch === 'arm64';
function ownWindowAddrs() {
  const set = new Set();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      const buf = win.getNativeWindowHandle();
      set.add(IS_64BIT ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0)));
    } catch {}
  }
  return set;
}

// 这个窗口是不是我们自己的（悬浮窗、弹窗等）
// 直接走 ownWindowAddrs —— BrowserWindow.getNativeWindowHandle() 是 Electron 自己的稳定 API，
// 比用 koffi `out()` 拿 PID 简单（koffi 在不同版本下 out 参数的回写行为不一致）。
// 120ms 一次的轮询 + 遍历 1~3 个 BrowserWindow 完全可以忽略不计。
function isOwnWindow(hwnd) {
  return ownWindowAddrs().has(hwndAddr(hwnd));
}

/* ==================== 前台窗口跟踪 ==================== */
function startForegroundTracking() {
  if (process.platform !== 'win32' || !GetForegroundWindow) return;
  ourThreadId = GetCurrentThreadId();

  // 每 120ms 记录一次前台窗口，只记「不属于本应用」的窗口。
  // 用户点悬浮窗时保持上一次的目标不变，这样连点多条短语都会粘到同一个输入框。
  fgTrackTimer = setInterval(() => {
    try {
      const hwnd = GetForegroundWindow();
      if (!hwnd || hwndAddr(hwnd) === 0n) return;
      if (isOwnWindow(hwnd)) return;
      lastFgHwnd = hwnd;
    } catch {}
  }, 120);
}

// 取当前可用的粘贴目标（窗口还在、且不是我们自己）
function getPasteTarget() {
  if (!lastFgHwnd || !IsWindow) return null;
  try {
    if (!IsWindow(lastFgHwnd)) return null;
    if (isOwnWindow(lastFgHwnd)) return null;
  } catch {
    return null;
  }
  return lastFgHwnd;
}

// 把目标窗口拉回前台，返回是否成功
function focusTarget(hwnd) {
  try {
    // 已经在前台（悬浮窗不抢焦点时的常态）→ 什么都不用做
    if (hwndAddr(GetForegroundWindow()) === hwndAddr(hwnd)) return true;

    const targetTid = GetWindowThreadProcessId(hwnd, null);
    if (!targetTid) return false;
    if (targetTid === ourThreadId) return true;

    // 临时附加输入线程，绕过前台窗口锁定
    AttachThreadInput(ourThreadId, targetTid, true);
    try {
      SetForegroundWindow(hwnd);
    } finally {
      AttachThreadInput(ourThreadId, targetTid, false);
    }
    return hwndAddr(GetForegroundWindow()) === hwndAddr(hwnd);
  } catch (e) {
    console.error('focusTarget error:', e);
    return false;
  }
}

/* ==================== 立即触发 Ctrl+V ==================== */
function sendCtrlV() {
  if (process.platform === 'win32' && keybd_event) {
    try {
      keybd_event(VK_CONTROL, 0, 0, 0);
      keybd_event(VK_V, 0, 0, 0);
      keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
      keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    } catch (e) {
      console.error('sendCtrlV error:', e);
    }
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  } else {
    spawn('xdotool', ['key', 'ctrl+v']);
  }
}

// 兜底方案：不知道该粘到哪 → 隐藏自己把焦点让给下面的窗口，粘完再无焦点显示回来
// 拆成两个有明确语义的常量：
//   PASTE_HIDE_DELAY_MS：hide → keybd_event 之间的离场时间，避免 Ctrl+V 误发给「正在
//                         隐藏中」的本窗口（hide 是异步的，立即 sendCtrlV 可能撞上）
//   PASTE_RESTORE_DELAY_MS：sendCtrlV → showInactive 之间让目标应用接收并真正把
//                           剪贴板内容落到输入框。覆盖多数应用从切前台 → 输入框就绪的时间
const PASTE_HIDE_DELAY_MS = 50;
const PASTE_RESTORE_DELAY_MS = 200;
// 用单 timer 取代「每次都 setTimeout」：连点多条短语时多个回显计时器会互相抢着触发，
// 最后一个回显完成之前其它都会执行 → 窗口一闪一闪。把后续请求合并到同一个 timer，
// 只回显一次即可。
let pasteHideTimer = null;
let pasteRestoreTimer = null;
function pasteByHiding() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  }
  // 清掉前一轮还没触发的回显任务（窗口已经隐藏，再回调一次也是同一个状态）
  if (pasteRestoreTimer) { clearTimeout(pasteRestoreTimer); pasteRestoreTimer = null; }
  if (pasteHideTimer) clearTimeout(pasteHideTimer);
  pasteHideTimer = setTimeout(() => {
    pasteHideTimer = null;
    sendCtrlV();
    pasteRestoreTimer = setTimeout(() => {
      pasteRestoreTimer = null;
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.showInactive();
        // 同 showFloating：showInactive 会重置层级，必须按当前偏好重新应用
        applyAlwaysOnTop();
      }
    }, PASTE_RESTORE_DELAY_MS - PASTE_HIDE_DELAY_MS);
  }, PASTE_HIDE_DELAY_MS);
}

/* ==================== 占位符展开 ==================== */
// 在粘贴/复制前把 {date} / {time} / {datetime} / {weekday} / {clipboard} 替换成实际值。
// 在主进程做是为了 `{clipboard}` 能可靠地读到系统剪贴板（避免渲染层权限差异）。
// 调用方需自己先快照原剪贴板内容（防止被自身的 writeText 覆盖）。
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function expandPlaceholders(text, clipboardSnapshot = '') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const replacements = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    weekday: WEEKDAY_CN[now.getDay()],
    clipboard: clipboardSnapshot,
  };
  replacements.datetime = `${replacements.date} ${replacements.time}`;
  // 单次正则遍历替代 5 次 replace。支持 \{xxx\} 反斜杠转义——
  // 想在短语里写「{date}」字面量教别人用占位符时，加一个反斜杠就行。
  return text.replace(
    /\\?\{(date|time|datetime|weekday|clipboard)\}/g,
    (m, key) => m.startsWith('\\') ? `{${key}}` : replacements[key]
  );
}

/* ==================== IPC ==================== */
// windowBounds 只由主进程维护（move/resize 事件）。渲染进程保存的是它启动时读到的
// 那份 settings 快照，里面的 windowBounds 已经过期——直接落盘会把用户刚拖好的窗口
// 位置回滚。所以每次写盘前都用「当前真实窗口位置」覆盖这个字段。
function withOwnedSettings(incoming) {
  const out = { ...(incoming || {}) };
  const settings = { ...(out.settings || {}) };
  let bounds = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      bounds = mainWindow.getBounds();
    } catch {}
  }
  // 窗口不可用（退出过程中）时回落到磁盘上已有的值，避免把字段清掉
  if (!bounds) {
    try {
      const disk = loadData();
      bounds = disk && disk.settings ? disk.settings.windowBounds : null;
    } catch {}
  }
  if (bounds) settings.windowBounds = bounds;
  out.settings = settings;
  return out;
}

ipcMain.handle('data:load', () => loadData());
ipcMain.handle('data:save', (_, data) => {
  const enriched = withOwnedSettings(data);
  const res = saveData(enriched);
  // 关键：先 saveData 再决定是否更新快照。saveData 失败时保持上一次成功状态，
  // 否则 scheduleSaveBounds 会把磁盘上本不该存在的那份失败数据当成「真实状态」写盘。
  if (res && res.ok) {
    // 维护一份最近一次写入的全量数据快照。scheduleSaveBounds 用它来同步窗口位置，
    // 不再从盘读 —— 避免和渲染层的并发保存产生覆盖。
    // enriched 是 withOwnedSettings 返回的新对象（顶层 + settings 都已是新对象），
    // 直接复用即可；后续 scheduleSaveBounds 会改写 cachedDataSnapshot.settings.windowBounds
    // 为新对象，不会影响 enriched。
    cachedDataSnapshot = enriched;
    // data:save 刚刚成功落盘，待处理的窗口位置合并任务无意义了 —— 下一次
    // move/resize 会重新 schedule。提前清掉避免它再用一份过期快照覆盖磁盘。
    if (saveBoundsTimer) { clearTimeout(saveBoundsTimer); saveBoundsTimer = null; }
  }
  return res;
});
// 同步版本：用于 beforeunload 场景，sendSync 会阻塞渲染进程直到写盘完成
ipcMain.on('data:saveSync', (e, data) => {
  const enriched = withOwnedSettings(data);
  const res = saveData(enriched);
  if (res && res.ok) {
    cachedDataSnapshot = enriched;
    if (saveBoundsTimer) { clearTimeout(saveBoundsTimer); saveBoundsTimer = null; }
  }
  e.returnValue = res;
});

// 仅复制到剪贴板，不触发粘贴；和 `paste` 共用同一套占位符展开，保持一致性
ipcMain.handle('clipboard:copy', (_, text) => {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: '内容为空' };
  }
  // 同样的 100KB 上限挡住滥用：和 paste 对齐
  if (text.length > MAX_PHRASE_CONTENT_LENGTH) {
    return { ok: false, error: `内容过长（${text.length} > ${MAX_PHRASE_CONTENT_LENGTH}）` };
  }
  try {
    // 含 {clipboard} 时，先快照原剪贴板再覆盖，避免读到自身写出去的内容
    const snapshot = text.includes('{clipboard}') ? clipboard.readText() : '';
    const expanded = expandPlaceholders(text, snapshot);
    clipboard.writeText(expanded);
    return { ok: true };
  } catch (e) {
    console.error('clipboard:copy error:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('paste', (_, text, opts) => {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: '内容为空' };
  }
  // 剪贴板巨型写入会卡顿甚至触发系统限制：超过 100KB 就拒绝
  if (text.length > MAX_PHRASE_CONTENT_LENGTH) {
    return { ok: false, error: `内容过长（${text.length} > ${MAX_PHRASE_CONTENT_LENGTH}）` };
  }

  // 1. 含 {clipboard} 时必须先快照原剪贴板，否则下一步 writeText 会覆盖掉要读的内容
  const clipboardSnapshot = text.includes('{clipboard}') ? clipboard.readText() : '';
  const expanded = expandPlaceholders(text, clipboardSnapshot);

  // 2. 写入剪贴板
  try {
    clipboard.writeText(expanded);
  } catch (e) {
    console.error('clipboard.writeText error:', e);
    return { ok: false, error: '剪贴板写入失败' };
  }

  // 2.5 用户在设置里开了「粘贴时隐藏悬浮窗」→ 必须走 pasteByHiding，
  //     因为只有它会在 PASTE_RESTORE_DELAY_MS 后把窗口重新显示出来。
  //     （之前由渲染进程先调 window:hide 再走下面的「有目标」分支，
  //       那条分支不负责重显，窗口就一直留在隐藏状态回不来了。）
  if (opts && opts.hideFirst) {
    pasteByHiding();
    return { ok: true, hasTarget: !!getPasteTarget() };
  }

  // 3. 取目标窗口（非 Windows 平台没有句柄跟踪，一律走兜底）
  const target = process.platform === 'win32' && keybd_event ? getPasteTarget() : null;

  // 4. 没有已知目标 → 兜底：隐藏自己让焦点回落，粘完再无焦点显示回来
  if (!target) {
    pasteByHiding();
    // 告诉渲染端：剪贴板已写入，但目标窗口未知，需要用户手动点一下输入框
    return { ok: true, hasTarget: false };
  }

  // 5. 有明确目标：拉回前台后直接注入 Ctrl+V。
  //    这里刻意不隐藏 / 重显悬浮窗 —— 连点多条短语时窗口一直在原地不闪，
  //    目标输入框也始终是同一个，不用再回去点一次输入框。
  //    如果拉前台失败（被系统拒绝、目标在切换中等），退回兜底走隐藏-粘贴-回显流程，
  //    避免把 Ctrl+V 误发到自己窗口里。
  if (!focusTarget(target)) {
    pasteByHiding();
    return { ok: true, hasTarget: false };
  }
  sendCtrlV();

  return { ok: true, hasTarget: true };
});

ipcMain.handle('window:hide', () => { if (mainWindow) mainWindow.hide(); });
// 切换「始终置顶」。渲染进程负责把偏好写进 data.settings（持久化），
// 主进程只负责：1) 立即应用；2) 后续 showFloating / pasteByHiding 路径拿这个状态。
ipcMain.handle('window:setAlwaysOnTop', (_, on) => {
  alwaysOnTop = !!on;
  applyAlwaysOnTop();
  return alwaysOnTop;
});
// 调整窗口透明度（用户设置里 60~100）
ipcMain.handle('window:setOpacity', (_, value) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // 注意：不能用 `Number(value) || 1`——0 || 1 === 1 把 0 当成 falsy 落到默认值了。
  // 用 Number.isFinite 显式判 NaN/Infinity/非数字字符串。
  const v = Math.max(0.6, Math.min(1, Number(value)));
  if (!Number.isFinite(v)) return false;
  try {
    mainWindow.setOpacity(v);
    return true;
  } catch (e) {
    console.error('setOpacity error:', e);
    return false;
  }
});
ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });

// 开机自启动：读写由 app.setLoginItemSettings / getLoginItemSettings 代理。
//   Windows：写到 HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run，
//            openAsHidden=true 时执行参数追加 --hidden；
//   macOS：注册到「系统设置 → 通用 → 登录项」；
//   Linux：在 ~/.config/autostart/ 下放 .desktop 文件（仅支持 openAtLogin）。
//
// 启动后用 getLoginItemSettings().wasOpenedAsHidden / wasOpenedAtLogin 判断本次是否被登录项拉起，
// 是的话窗口留在托盘里不弹（见 ready-to-show 分支）。
ipcMain.handle('app:getAutoLaunch', () => {
  try {
    const ls = app.getLoginItemSettings();
    return { ok: true, enabled: !!(ls && ls.openAtLogin) };
  } catch (e) {
    // 拿不到 OS 状态时回退到 false，渲染层展示关闭态；用户点过开关后下次刷新就会以 OS 为准。
    console.error('getAutoLaunch error:', e);
    return { ok: false, enabled: false, error: e.message || String(e) };
  }
});

ipcMain.handle('app:setAutoLaunch', (_, enabled) => {
  const want = !!enabled;
  try {
    app.setLoginItemSettings({
      openAtLogin: want,
      // Windows 会把这个值翻译成执行参数里的 --hidden，启动时被 getLoginItemSettings 读到；
      // macOS 会让应用在登录时以隐藏状态启动。
      // Linux 忽略此字段，但写一个稳定的值对 API 一致性无害。
      openAsHidden: true,
    });
    return { ok: true, enabled: want };
  } catch (e) {
    // dev 模式下（isPackaged=false）调用此 API 经常失败：electron.exe 路径在不同机器上不一致，
    // 注册表项会写到错位置；不过 `npm start` 启动的用户本来也不会真的想开机自启。
    // 把异常吞掉 + 返回错误，让渲染层弹 toast 提示。
    console.error('setAutoLaunch error:', e);
    return { ok: false, enabled: false, error: e.message || String(e) };
  }
});

// 渲染进程要打字了（打开编辑弹窗）→ 临时让窗口获得焦点；
// 关掉弹窗后只把焦点还给原来的目标窗口，窗口本身仍保持可聚焦
// （搜索框需要持续可用；如果这里 setNoActivate(true) 会让搜索框跟着失能）。
ipcMain.handle('window:setTyping', (_, typing) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (process.platform !== 'win32') return true;

  try {
    if (typing) {
      mainWindow.focus();
    } else {
      const target = getPasteTarget();
      // 没有目标（比如刚启动、还没有任何前台窗口轮询过）→ 啥也不做，让窗口自然失焦
      if (target) focusTarget(target);
    }
    return true;
  } catch (e) {
    console.error('setTyping error:', e);
    return false;
  }
});

// 返回数据文件路径（绝对路径）
ipcMain.handle('app:getDataPath', () => userDataPath);

// 在文件管理器中定位数据文件
ipcMain.handle('app:revealDataFile', () => {
  try {
    if (fs.existsSync(userDataPath)) {
      shell.showItemInFolder(userDataPath);
    } else {
      // 文件还不存在（首次启动未保存）→ 打开所在目录
      shell.openPath(path.dirname(userDataPath));
    }
    return true;
  } catch (e) {
    console.error('reveal data file error:', e);
    return false;
  }
});

// 在系统默认浏览器中打开外部链接
// 渲染进程走的是 file:// + contextIsolation，直接 <a target="_blank"> 在 Electron 里
// 不会自动跳出当前窗口。让渲染进程通过 IPC 把 URL 交给主进程，由 shell.openExternal
// 调用系统浏览器打开 —— 这样也顺便强制校验协议头，避免被劫持去打开 file:// 之类。
ipcMain.handle('app:openExternal', (_evt, url) => {
  try {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) {
      console.warn('openExternal rejected non-http(s) url:', u);
      return false;
    }
    shell.openExternal(u);
    return true;
  } catch (e) {
    console.error('openExternal error:', e);
    return false;
  }
});

// 导出数据：弹保存对话框，把当前数据写到用户选的 .json 文件
ipcMain.handle('data:export', async () => {
  try {
    const current = loadData();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `quick-paste-${stamp}.json`;
    const res = await dialog.showSaveDialog(mainWindow || undefined, {
      title: '导出短语',
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, JSON.stringify(current, null, 2), 'utf-8');
    return { ok: true, filePath: res.filePath };
  } catch (e) {
    console.error('export error:', e);
    return { ok: false, error: e.message };
  }
});

// 渲染层获取当前已注册的全局快捷键（设置面板首次打开时显示）
ipcMain.handle('shortcuts:getGlobalToggle', () => currentGlobalShortcut);

// 修改全局快捷键：渲染层在设置面板里点「录制」拿到新组合键后调用。
//   1. 校验格式：必须是非空字符串且至少有一个 `+`（modifier + key 的最小形态）
//   2. 落盘：复用 withOwnedSettings → saveData 链路，确保 windowBounds 跟着更新；
//      settings.shortcuts 是新字段，withOwnedSettings 只改 windowBounds、不动其它字段，
//      所以 spread 后透传即可。
//   3. 注册新值到系统：失败时回滚旧值；注册成功才更新 currentGlobalShortcut。
ipcMain.handle('shortcuts:setGlobalToggle', (_, accelerator) => {
  if (typeof accelerator !== 'string' || !accelerator.trim() || !accelerator.includes('+')) {
    return { ok: false, error: '快捷键格式无效' };
  }
  const acc = accelerator.trim();
  // 与当前一致：直接返回成功，避免无意义的 unregister/register 抖动
  if (acc === currentGlobalShortcut) return { ok: true, accelerator: acc, unchanged: true };

  // 落盘先于 register：注册失败时数据已存，但当前快捷键仍是旧值。
  // 用户重启后会从 settings.shortcuts.globalToggle 再尝试一次（虽然大概率仍失败）。
  // 如果反过来：register 成功但落盘失败，重启后快捷键回到旧值——这条更糟糕，
  // 用户明明看到界面变了，重启又被回滚。所以先写盘、再注册。
  try {
    const current = loadData();
    const newSettings = {
      ...(current.settings || {}),
      shortcuts: { ...((current.settings && current.settings.shortcuts) || {}), globalToggle: acc },
    };
    const enriched = withOwnedSettings({ ...current, settings: newSettings });
    const res = saveData(enriched);
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || '保存失败' };
    cachedDataSnapshot = enriched;
    if (saveBoundsTimer) { clearTimeout(saveBoundsTimer); saveBoundsTimer = null; }
  } catch (e) {
    console.error('save shortcut error:', e);
    return { ok: false, error: e.message || String(e) };
  }

  // 尝试注册到系统。失败 → 数据已写盘但快捷键未切换；返回失败让 UI 提示用户，
  // 但用户重启时会再次尝试（此时如果那个占用程序退了就成功了）。
  const ok = applyGlobalShortcut(acc);
  if (!ok) {
    return { ok: false, error: '快捷键已被其它应用占用，请换一个', accelerator: acc };
  }
  return { ok: true, accelerator: acc };
});

/* ==================== 全局快捷键 ==================== */
// 默认唤出 / 收起快捷键。注册来源不再写死：读 data.settings.shortcuts.globalToggle，
// 没有或格式异常时回落到这里。用户在设置面板改了之后通过 IPC 重注册。
const DEFAULT_GLOBAL_TOGGLE = 'CommandOrControl+Shift+V';
// 跟踪「当前已注册到系统」的那一个。change 时需要先 unregister 掉旧的再 register 新的，
// 否则旧组合会一直占着直到进程退出。启动时会被真实注册值覆盖。
let currentGlobalShortcut = DEFAULT_GLOBAL_TOGGLE;

// 重新注册全局快捷键：
//   1. 注销旧的（可能是默认值，也可能是用户改过的），避免旧组合一直占着系统
//   2. register 新值；失败（被其它程序占用）时回滚到旧值，保证至少有一个组合能用
//   3. 整个流程不抛错——注册失败时主进程只 warn，应用照常运行（README 86 行约定）
function applyGlobalShortcut(accelerator) {
  // 注销旧值：可能从来没注册成功过，catch 兜底
  if (currentGlobalShortcut && currentGlobalShortcut !== accelerator) {
    try { globalShortcut.unregister(currentGlobalShortcut); } catch {}
  }
  // 兜底：unregisterAll 清场，避免旧注册残留；本应用目前只有这一条全局快捷键，安全
  try { globalShortcut.unregisterAll(); } catch {}

  try {
    const ok = globalShortcut.register(accelerator, () => toggleWindow());
    if (!ok) {
      console.warn('全局快捷键注册失败，可能被其它应用占用:', accelerator);
      // 回滚：旧值能注册就还原
      try { globalShortcut.register(currentGlobalShortcut, () => toggleWindow()); } catch {}
      return false;
    }
    currentGlobalShortcut = accelerator;
    return true;
  } catch (e) {
    console.warn('globalShortcut.register error:', e);
    try { globalShortcut.register(currentGlobalShortcut, () => toggleWindow()); } catch {}
    return false;
  }
}

/* ==================== 生命周期 ==================== */

app.whenReady().then(() => {
  userDataPath = path.join(app.getPath('userData'), 'data.json');

  // 启动期一次性读盘：createWindow 读 alwaysOnTop、applyGlobalShortcut 读 savedAcc，
  // 共用这一份解析过的数据，避免 JSON 解析 + 字段容错走两遍。
  try {
    bootDataSnapshot = loadData();
  } catch {
    bootDataSnapshot = null;
  }

  // 检测本次启动是否由「开机自启动」触发：
  // wasOpenedAsHidden 表示 setLoginItemSettings({openAsHidden:true}) 给执行参数加了 --hidden；
  // wasOpenedAtLogin 是更广义的判断（macOS 等）。
  // 二者任一为真都说明我们是被登录项拉起来的，此时不要自动弹出悬浮窗。
  try {
    const ls = app.getLoginItemSettings();
    startedAtLogin = !!(ls && (ls.wasOpenedAtLogin || ls.wasOpenedAsHidden));
  } catch {}

  createWindow();
  createTray();

  // 启动前台窗口跟踪
  startForegroundTracking();

  // 注册全局唤出快捷键：优先用用户改过的值，没有或格式异常时用默认值。
  // 复用 bootDataSnapshot，省一次 loadData。
  let savedAcc = DEFAULT_GLOBAL_TOGGLE;
  if (bootDataSnapshot) {
    const fromSettings = bootDataSnapshot.settings
      && bootDataSnapshot.settings.shortcuts
      && bootDataSnapshot.settings.shortcuts.globalToggle;
    if (typeof fromSettings === 'string' && fromSettings.trim() && fromSettings.includes('+')) {
      savedAcc = fromSettings;
    }
  }
  applyGlobalShortcut(savedAcc);
});

app.on('will-quit', () => {
  // 退出时反注册所有全局快捷键，避免下次的注册失败
  try { globalShortcut.unregisterAll(); } catch {}
});

app.on('before-quit', () => {
  isQuitting = true;
  // 清理窗口位置合并任务：避免退出后定时器回调访问已销毁的 mainWindow
  // （回调里有 isDestroyed 检查不会崩，但清理掉更对称、也省一次空写盘）
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = null;
  }
  // 清理前台窗口轮询定时器，避免退出后仍在访问主窗口
  if (fgTrackTimer) {
    clearInterval(fgTrackTimer);
    fgTrackTimer = null;
  }
  // 清理回显 timer，避免退出后还会触发 mainWindow.showInactive 撞到销毁态
  if (pasteRestoreTimer) {
    clearTimeout(pasteRestoreTimer);
    pasteRestoreTimer = null;
  }
  // 清理 hide→paste 延迟 timer，同上理由（回调里 sendCtrlV 会在已销毁进程上下文里跑）
  if (pasteHideTimer) {
    clearTimeout(pasteHideTimer);
    pasteHideTimer = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (mainWindow) showFloating();
});