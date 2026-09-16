/**
 * 渲染进程：UI 交互、数据读写、点击触发粘贴
 */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

let data = null;
let editingPhraseId = null;
let searchQuery = '';
let selectedPhraseIndex = -1;
let currentFilter = 'all';
let dragSrcId = null;
let dragSrcKind = null;
// 全局快捷键录制态：setupKeyboardShortcuts 顶部优先检查 isRecordingShortcut，
// 是的话所有 keydown 都走录制流程，不再处理其它快捷键。recordInvalidShown 保证
// 「需要修饰键」提示每个录制会话只弹一次，按 5 个字母只看到 1 条 toast。
let isRecordingShortcut = false;
let recordInvalidShown = false;
// 拖拽过程中的 rect 缓存：dragstart 时一次性算出所有 li 的 bounding rect，
// 避免 dragover 每像素 mousemove 都调 getBoundingClientRect 强制 reflow。
let dragRectCache = null;
// dragover 的 drop-above/below class 切换用 rAF 节流：
// 同一帧内多次 mousemove 只切换 class 一次。
let dropRafPending = false;
let lastDropTarget = null;
let lastDropAbove = null;
// 上一帧高亮的 li：dragover 从 A 切到 B 时，A 上的 class 要清掉否则留下残影。
let prevDropTarget = null;
// 拖拽短语时悬停的目标分组：拖到分组上 ≠ 拖到短语间的缝隙，
// 用 phraseDropTargetGroup 单独追踪，避免与 drop-above/below 互相打架。
let phraseDropTargetGroup = null;

function cacheDragRects(selector) {
  dragRectCache = new Map();
  const list = document.querySelectorAll(selector);
  for (const el of list) {
    dragRectCache.set(el, el.getBoundingClientRect());
  }
}

function scheduleDropIndicator(target, above) {
  // 目标 / 朝向都没变 → 不再排队（避免同帧内重复 toggle class）
  if (lastDropTarget === target && lastDropAbove === above && !dropRafPending) return;
  prevDropTarget = lastDropTarget;
  lastDropTarget = target;
  lastDropAbove = above;
  if (dropRafPending) return;
  dropRafPending = true;
  requestAnimationFrame(() => {
    dropRafPending = false;
    // 旧 li 上的 drop 标记要清掉（拖到隔壁 li 时，旧 li 仍可能挂着 drop-above/below）
    if (prevDropTarget && prevDropTarget !== lastDropTarget) {
      prevDropTarget.classList.remove('drop-above', 'drop-below');
    }
    if (lastDropTarget) {
      lastDropTarget.classList.toggle('drop-above', lastDropAbove);
      lastDropTarget.classList.toggle('drop-below', !lastDropAbove);
    }
  });
}

function clearDropIndicators() {
  // 清掉所有 li 上的 drop 状态：拖拽结束时统一收尾，避免拖出缝隙留下残影
  const sel = dragSrcKind === 'group' ? '.group-item' : '.phrase-item';
  document.querySelectorAll(sel).forEach((el) => {
    el.classList.remove('drop-above', 'drop-below');
  });
  lastDropTarget = null;
  lastDropAbove = null;
  prevDropTarget = null;
  dropRafPending = false;
  // 同步把「拖到分组」的悬停高亮也清掉，避免上一轮 dragend 没走到清理分支
  clearPhraseDropTarget();
}

// 拖短语到分组栏时给目标分组挂一个高亮 class，区别于上下插入线（drop-above/below）。
// 用 dragover 持续刷新目标，而不是依赖 dragleave —— dragover 每像素 mousemove 都会触发，
// 跨过 li 边界时新 dragover 自然会清掉旧的高亮，不需要单独的 dragleave 处理。
function schedulePhraseDropTarget(groupItem) {
  if (phraseDropTargetGroup === groupItem) return;
  if (phraseDropTargetGroup) phraseDropTargetGroup.classList.remove('phrase-drop-target');
  phraseDropTargetGroup = groupItem;
  if (phraseDropTargetGroup) phraseDropTargetGroup.classList.add('phrase-drop-target');
}

function clearPhraseDropTarget() {
  if (phraseDropTargetGroup) phraseDropTargetGroup.classList.remove('phrase-drop-target');
  phraseDropTargetGroup = null;
}

function uid(prefix = 'id') {
  const bytes = new Uint8Array(8);
  // 优先用 Web Crypto；某些极端环境（极旧 Electron / sandbox 受限）下不可用
  // 就退回到 Math.random——碰撞概率仍极低，且只在异常路径触发。
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${prefix}_${Date.now().toString(36)}_${hex}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 把 Electron accelerator 字符串转成展示用的「人类可读」形式：
//   CommandOrControl → Ctrl（Windows 永远显示 Ctrl）
//   Cmd / Command   → Ctrl（同上；本应用只在 Windows 上跑，留 Cmd 也无妨）
// 其余（Shift / Alt / F1 / Up 等）原样保留。
function formatAcceleratorForDisplay(acc) {
  if (!acc) return '';
  return String(acc).replace(/CommandOrControl|Cmd|Command/g, 'Ctrl');
}

// 把 keydown 事件转成 Electron accelerator 字符串：
//   - 必须含至少一个修饰键（Ctrl/Alt/Shift/Meta 任一）；单独字母返回 ''（让 UI 提示）
//   - 修饰键单独按下时 key 是 'Control'/'Shift' 等，返回 null（让用户继续按主键）
//   - 字母统一大写；方向键 / 空格 / Enter / Esc 映射成 Electron 名字（F1~F24 同名不用映射）
function keyEventToAccelerator(e) {
  const modifiers = [];
  if (e.ctrlKey || e.metaKey) modifiers.push('CommandOrControl');
  if (e.altKey) modifiers.push('Alt');
  if (e.shiftKey) modifiers.push('Shift');
  if (modifiers.length === 0) return '';

  let key = e.key;
  // Electron 的键名与 DOM key 略有差异，统一映射
  const map = {
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Enter': 'Return', 'Escape': 'Esc',
    ' ': 'Space',
  };
  if (map[key]) key = map[key];
  else if (key.length === 1) key = key.toUpperCase();
  // 功能键（F1~F24）DOM 直接给 'F1' 这种，Electron 接受同名，无需转换
  return [...modifiers, key].join('+');
}

function debounce(fn, wait) {
  let timer = null;
  let lastArgs = null;
  return function debounced(...args) {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, lastArgs);
    }, wait);
  };
}

function highlightText(str, q) {
  if (!q || !str) return escapeHtml(str);
  // 先 escape 再 regex-escape：避免把未转义的 HTML 字符塞进 <mark>$1</mark>。
  // 旧版本只 regex-escape，特殊情况下会把用户输入的原始字符当 HTML 注入。
  const safe = escapeHtml(str);
  const safeQ = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(`(${safeQ})`, 'gi'), '<mark>$1</mark>');
  } catch {
    return safe;
  }
}

const TOAST_ICONS = { success: 'i-check', error: 'i-alert', info: 'i-info', '': 'i-info' };

function showToast(msg, type = '') {
  const stack = $('toast-stack');
  if (!stack) return console.log(`[toast:${type}] ${msg}`);
  while (stack.children.length >= 4) stack.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const iconId = TOAST_ICONS[type] || 'i-info';
  el.innerHTML = `
    <span class="toast-icon"><svg class="icon"><use href="#${iconId}"/></svg></span>
    <span class="toast-text">${escapeHtml(msg)}</span>
    <button class="toast-close" title="关闭"><svg class="icon"><use href="#i-x"/></svg></button>
  `;
  el.querySelector('.toast-close').addEventListener('click', () => removeToast(el));
  stack.appendChild(el);
  el._timer = setTimeout(() => removeToast(el), 2600);
}

function removeToast(el) {
  if (!el || !el.parentNode) return;
  if (el._removing) return;
  el._removing = true;
  if (el._timer) clearTimeout(el._timer);
  el.classList.add('fade-out');
  // 用 _removing 标记保证只走一条路径：动画结束优先；超时兜底只清理未被动画触发的元素
  let done = false;
  const finalize = () => {
    if (done) return;
    done = true;
    el.remove();
  };
  el.addEventListener('animationend', finalize, { once: true });
  setTimeout(finalize, 400);
}

function openContextMenu(x, y, items) {
  const menu = $('context-menu');
  if (!menu) return;
  menu.innerHTML = '';
  for (const it of items) {
    if (it.type === 'divider') {
      const div = document.createElement('div');
      div.className = 'ctx-divider';
      menu.appendChild(div);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.danger ? ' danger' : '');
    el.innerHTML = `<svg class="icon"><use href="#${it.icon || 'i-info'}"/></svg><span>${escapeHtml(it.label)}</span>`;
    el.addEventListener('click', () => {
      closeContextMenu();
      if (typeof it.onClick === 'function') it.onClick();
    });
    menu.appendChild(el);
  }
  menu.classList.remove('hidden');
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    menu.style.left = Math.max(4, Math.min(x, winW - rect.width - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, winH - rect.height - 8)) + 'px';
  });
  setTimeout(() => {
    document.addEventListener('mousedown', onClickOutsideMenu, { once: true });
  }, 0);
}

function onClickOutsideMenu(e) {
  const menu = $('context-menu');
  if (menu && !menu.contains(e.target)) closeContextMenu();
}

function closeContextMenu() {
  const menu = $('context-menu');
  if (menu) menu.classList.add('hidden');
}

function openPromptModal({
  title = '提示', message = '', defaultValue = '',
  okLabel = '确定', cancelLabel = '取消', placeholder = '',
  danger = false, icon = 'info', showInput = true,
}) {
  return new Promise((resolve) => {
    const modal = $('prompt-modal');
    $('prompt-title').textContent = title;
    $('prompt-message').textContent = message;
    const input = $('prompt-input');
    input.value = defaultValue;
    input.placeholder = placeholder;
    $('prompt-message').classList.toggle('hidden', !message);
    input.classList.toggle('hidden', !showInput);
    $('prompt-ok').textContent = okLabel;
    $('prompt-cancel').textContent = cancelLabel;
    const iconEl = $('prompt-icon');
    const iconKind = icon === 'check' ? 'check' : icon === 'alert' ? 'alert' : icon === 'edit' ? 'edit' : 'info';
    iconEl.innerHTML = `<svg class="icon"><use href="#i-${iconKind}"/></svg>`;
    iconEl.className = 'prompt-icon ' + (danger ? 'danger' : icon === 'check' ? 'success' : '');
    modal.classList.remove('hidden');
    if (window.api.setTyping) window.api.setTyping(true);
    setTimeout(() => {
      if (!input.classList.contains('hidden')) {
        input.focus();
        input.select();
      } else {
        $('prompt-ok').focus();
      }
    }, 30);

    const cleanup = (val) => {
      modal.classList.add('hidden');
      $('prompt-cancel').removeEventListener('click', onCancel);
      $('prompt-ok').removeEventListener('click', onOk);
      modal.removeEventListener('click', onBackdrop);
      // 关掉 prompt 后若还有其它面板（设置 / 短语编辑弹窗）打开，
      // 就不要再 setTyping(false)，否则会把它们的打字态一起关掉，
      // 导致设置面板里的输入框瞬间收不到键盘事件。
      if (!isAnyPanelOpen() && window.api.setTyping) window.api.setTyping(false);
      resolve(val);
    };
    const onOk = () => cleanup(showInput ? input.value : true);
    const onCancel = () => cleanup(null);
    const onBackdrop = (e) => { if (e.target.id === 'prompt-modal') onCancel(); };

    $('prompt-cancel').addEventListener('click', onCancel);
    $('prompt-ok').addEventListener('click', onOk);
    modal.addEventListener('click', onBackdrop);
  });
}

async function promptUser(message, defaultValue = '', opts = {}) {
  const v = await openPromptModal({
    title: opts.title || '请输入', message, defaultValue,
    placeholder: opts.placeholder || '', okLabel: opts.okLabel || '确定',
    danger: !!opts.danger, icon: 'edit', showInput: true,
  });
  return v == null ? null : v;
}

async function confirmUser(message, opts = {}) {
  const v = await openPromptModal({
    title: opts.title || '确认操作', message,
    okLabel: opts.okLabel || '确定', cancelLabel: opts.cancelLabel || '取消',
    danger: opts.danger !== false, icon: 'alert', showInput: false,
  });
  return v === true;
}

function updateTotals() {
  const favCount = data.groups.reduce((n, g) => n + g.phrases.filter((p) => p.fav).length, 0);
  const recCount = (data.recent || []).length;
  // 侧栏顶部快捷区（收藏 / 最近）的角标
  const qFav = $('quick-count-fav'); if (qFav) qFav.textContent = String(favCount);
  const qRec = $('quick-count-recent'); if (qRec) qRec.textContent = String(recCount);
}

function isSidebarCollapsed() {
  return !!(data && data.settings && data.settings.sidebarCollapsed);
}

// 同步 DOM 到当前折叠状态。
// 图标始终表示「点击后会做什么」：展开态显示「折叠」图标，折叠态显示「展开」图标。
// 按钮有两份，分别挂在 .sidebar-footer（展开时可见）和 .add-bar（折叠时可见），
// 互斥显示由 #main.sidebar-collapsed 这个 class 控制；两份按钮的 icon/title/aria 同步刷新。
function applySidebarState() {
  const collapsed = isSidebarCollapsed();
  const main = $('main');
  if (main) main.classList.toggle('sidebar-collapsed', collapsed);
  // 两份按钮：sidebar-footer 内的折叠按钮 + add-bar 内的展开按钮
  const buttons = [
    { el: $('btn-toggle-sidebar'), next: 'i-sidebar-collapse' },
    { el: $('btn-expand-sidebar'), next: 'i-sidebar-expand' },
  ];
  for (const { el, next } of buttons) {
    if (!el) continue;
    // 折叠按钮（侧栏展开时显示）图标 = 当前是展开态 → 点击会折叠 → 显示折叠图标
    // 展开按钮（侧栏折叠时显示）图标 = 当前是折叠态 → 点击会展开 → 显示展开图标
    // 所以两份按钮的图标固定不变（各自代表「下一步动作」），不需要 innerHTML 改写。
    el.title = collapsed ? '展开分组栏' : '折叠分组栏';
    el.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
    el.setAttribute('aria-label', collapsed ? '展开分组栏' : '折叠分组栏');
    // next 留作未来扩展（万一以后想让按钮图标随状态微调）；当前两份按钮的图标在 HTML 里已固定
    void next;
  }
}

function toggleSidebar() {
  if (!data) return;
  if (!data.settings) data.settings = {};
  data.settings.sidebarCollapsed = !isSidebarCollapsed();
  applySidebarState();
  persist();
}

// 把置顶按钮的视觉态（激活态、tooltip、aria）同步到 on。
// 图标本身不切换，靠 .toggle-on 的高亮色区分开/关。
function applyPinButtonUI(on) {
  const btn = $('btn-pin-top');
  if (!btn) return;
  btn.classList.toggle('toggle-on', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? '始终置顶（已开启，点击关闭）' : '始终置顶（已关闭，点击开启）';
}

function renderGroups() {
  const list = $('group-list');
  list.innerHTML = '';
  for (const g of data.groups) {
    const li = document.createElement('li');
    li.className = 'group-item' + (g.id === data.activeGroupId ? ' active' : '');
    li.dataset.id = g.id;
    li.draggable = true;
    li.innerHTML = `<span class="name">${escapeHtml(g.name)}</span><span class="count">${g.phrases.length}</span>`;
    li.addEventListener('click', () => {
      if (g.id === data.activeGroupId) return;
      data.activeGroupId = g.id;
      currentFilter = 'all';
      selectedPhraseIndex = -1;
      // 切分组时清空搜索：先清 input.value 再走 setSearchQuery,
      // 让 syncSearchClearVisibility 读到空值,清空按钮正确隐藏。
      const sInput = $('search-input');
      if (sInput) sInput.value = '';
      setSearchQuery('');
      persist();
      renderAll();
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, [
        { label: '重命名分组', icon: 'i-edit', onClick: () => renameGroup(g) },
        { label: '清空短语', icon: 'i-trash', onClick: () => clearGroupPhrases(g) },
        { type: 'divider' },
        { label: '删除分组', icon: 'i-trash', danger: true, onClick: () => deleteGroup(g) },
      ]);
    });

    li.addEventListener('dragstart', (e) => {
      dragSrcId = g.id;
      dragSrcKind = 'group';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', g.id);
      // 拖拽过程中 list 不会重排，rect 在整个拖拽期间稳定。
      // 在 dragstart 一次性算好所有 li 的 rect，dragover 直接读缓存，
      // 避免每个 mousemove 都触发 getBoundingClientRect 强制 layout。
      cacheDragRects('.group-item');
      requestAnimationFrame(() => li.classList.add('dragging'));
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      clearDropIndicators();
      dragSrcId = null; dragSrcKind = null;
      dragRectCache = null;
    });
    li.addEventListener('dragover', (e) => {
      // 拖短语到分组：把当前分组高亮成「落点」，drop 时整条移过去。
      // dragSrcKind 是 phrase 时也要 preventDefault + dropEffect=move，否则浏览器会显示
      // 「禁止落下」光标且 drop 不触发。
      if (dragSrcKind === 'phrase') {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // 拖回原分组没有意义（movePhraseToGroup 内部会 no-op），不要亮起来骗用户。
        // 通过 phraseIndex 反查源分组，避免每帧都遍历全库。
        const owner = phraseIndex.get(dragSrcId);
        if (!owner || owner.group.id !== g.id) {
          schedulePhraseDropTarget(li);
        } else {
          schedulePhraseDropTarget(null);
        }
        return;
      }
      if (dragSrcKind !== 'group' || dragSrcId === g.id) return;
      e.preventDefault();
      const rect = dragRectCache && dragRectCache.get(li);
      if (!rect) return;
      const above = (e.clientY - rect.top) < rect.height / 2;
      scheduleDropIndicator(li, above);
    });
    // drop-indicator 的清理统一在 dragend / dragleave 一起做（避免拖到 li 之间的缝隙时
    // 残留半边 drop-above/drop-below 状态）。这里只清自己——dragend 会兜底。
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      // 拖短语到分组：把该短语移动到目标分组（顶部插入，与新建短语行为一致）。
      if (dragSrcKind === 'phrase' && dragSrcId) {
        movePhraseToGroup(dragSrcId, g.id);
        return;
      }
      const rect = li.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      reorderGroups(dragSrcId, g.id, above);
    });

    list.appendChild(li);
  }
  updateTotals();
}

function reorderGroups(srcId, targetId, above) {
  if (srcId === targetId) return;
  const srcIdx = data.groups.findIndex((g) => g.id === srcId);
  const tgtIdx = data.groups.findIndex((g) => g.id === targetId);
  if (srcIdx < 0 || tgtIdx < 0) return;
  const [moved] = data.groups.splice(srcIdx, 1);
  let insertAt = data.groups.findIndex((g) => g.id === targetId);
  if (!above) insertAt += 1;
  data.groups.splice(insertAt, 0, moved);
  persist();
  renderGroups();
  renderPhrases();
}

// 搜索过滤：三个视图（全部 / 收藏 / 最近）共用同一套匹配规则。
// 抽出来是因为「最近」视图之前根本没接搜索——搜索框在该视图下可见却完全不生效。
function applySearchFilter(list) {
  if (!searchQuery) return list;
  const q = searchQuery.toLowerCase();
  return list.filter(
    (p) => (p.title || '').toLowerCase().includes(q) ||
           (p.content || '').toLowerCase().includes(q)
  );
}

function visiblePhrases() {
  if (currentFilter === 'recent') {
    const out = [];
    for (const r of data.recent || []) {
      for (const g of data.groups) {
        const p = g.phrases.find((x) => x.id === r.id);
        if (p) {
          out.push(Object.assign({}, p, { _groupId: g.id, _groupName: g.name, _ts: r.ts }));
          break;
        }
      }
    }
    return applySearchFilter(out);
  }
  if (currentFilter === 'fav') {
    // 跨分组聚合：与侧栏顶部「收藏」角标的统计口径一致，
    // 也匹配 README 第 10 行「跨分组查看」的产品承诺。
    const out = [];
    for (const g of data.groups) {
      for (const p of g.phrases) {
        if (!p.fav) continue;
        out.push(Object.assign({}, p, { _groupId: g.id, _groupName: g.name }));
      }
    }
    return applySearchFilter(out);
  }
  const group = data.groups.find((g) => g.id === data.activeGroupId);
  if (!group) return [];
  return applySearchFilter(group.phrases.slice());
}

function renderPhrases() {
  const group = data.groups.find((g) => g.id === data.activeGroupId);
  const list = $('phrase-list');
  const empty = $('phrase-empty');
  list.innerHTML = '';

  const phrases = visiblePhrases();

  let headerName = group ? group.name : '（未选择）';
  if (currentFilter === 'fav') headerName = '收藏';
  else if (currentFilter === 'recent') headerName = '最近使用';
  $('current-group-name').textContent = headerName;

  const countEl = $('phrase-count');
  const totalInGroup = group ? group.phrases.length : 0;
  // 三个视图统一口径：有搜索时显示「命中 / 总数」，没搜索时只显示总数。
  if (currentFilter === 'recent') {
    const totalRecent = (data.recent || []).length;
    countEl.textContent = `${phrases.length}` + (searchQuery ? ` / ${totalRecent}` : '');
    countEl.classList.remove('hidden');
  } else if (currentFilter === 'fav') {
    // 跨分组统计（与 visiblePhrases 的口径一致），不要再限定 group
    const favCount = data.groups.reduce((n, g) => n + g.phrases.filter((p) => p.fav).length, 0);
    countEl.textContent = `${phrases.length}` + (searchQuery ? ` / ${favCount}` : '');
    countEl.classList.remove('hidden');
  } else if (searchQuery && group) {
    countEl.textContent = `${phrases.length} / ${totalInGroup}`;
    countEl.classList.remove('hidden');
  } else {
    countEl.textContent = '';
    countEl.classList.add('hidden');
  }

  if (phrases.length === 0) {
    const titleEl = empty.querySelector('.empty-title');
    const descEl = empty.querySelector('.empty-desc');
    const actionEl = empty.querySelector('.empty-action');
    const illu = empty.querySelector('.empty-illustration');
    let showAction = false;
    // 搜索必须排在最前面判断：搜索无结果时不论处在哪个视图，
    // 用户要看到的都是「没有匹配」，而不是「还没有收藏 / 还没有最近使用」
    // （后者会让人以为收藏被清空了）。
    if (searchQuery) {
      titleEl.textContent = '没有匹配的短语';
      descEl.textContent = '换个关键词试试';
    } else if (currentFilter === 'recent') {
      titleEl.textContent = '还没有最近使用';
      descEl.textContent = '粘贴短语后会显示在这里';
    } else if (currentFilter === 'fav') {
      titleEl.textContent = '还没有收藏';
      descEl.textContent = '点击短语前的星标来收藏';
    } else {
      titleEl.textContent = '这个分组还是空的';
      descEl.textContent = '点下方按钮添加你的第一条常用语';
      showAction = true;
    }
    if (actionEl) actionEl.classList.toggle('hidden', !showAction);
    // 重新触发入场效果：先拿掉再 reflow 再加回去,保证动画每次重置
    if (illu) {
      illu.classList.remove('run-in');
      // 读取 offsetWidth 强制浏览器做一次 reflow，让下面的 add 触发动画而不是被合并掉
      void illu.offsetWidth;
      illu.classList.add('run-in');
    }
    empty.classList.remove('hidden');
    selectedPhraseIndex = -1;
    return;
  }
  empty.classList.add('hidden');

  if (selectedPhraseIndex >= phrases.length) selectedPhraseIndex = phrases.length - 1;

  const frag = document.createDocumentFragment();
  for (let idx = 0; idx < phrases.length; idx++) {
    const p = phrases[idx];
    const li = document.createElement('li');
    li.className = 'phrase-item' + (idx === selectedPhraseIndex ? ' selected' : '');
    li.dataset.id = p.id;
    li.dataset.idx = String(idx);
    li.draggable = currentFilter === 'all' && !searchQuery;
    const isFav = !!p.fav;
    const useCount = p.useCount || 0;
    // 「最近」/「收藏」是跨分组视图，需要标注来源分组；
    // 「全部」视图下当前分组已经在标题栏显示，就不再重复。
    const showGroup = (currentFilter === 'recent' || currentFilter === 'fav') && p._groupName;
    const title = (p.title || p.content || '').slice(0, 40);
    const preview = (p.content || '').replace(/\s+/g, ' ').slice(0, 200);
    li.innerHTML = `
      <div class="phrase-top">
        <button class="phrase-fav ${isFav ? 'on' : ''}" data-act="fav" title="${isFav ? '取消收藏' : '收藏'}">
          <svg class="icon"><use href="#${isFav ? 'i-star-fill' : 'i-star'}"/></svg>
        </button>
        <span class="phrase-title">${highlightText(title, searchQuery)}</span>
        <div class="phrase-actions">
          <button class="action-btn" data-act="copy" title="仅复制（不粘贴）"><svg class="icon"><use href="#i-copy"/></svg></button>
          <button class="action-btn" data-act="edit" title="编辑"><svg class="icon"><use href="#i-edit"/></svg></button>
          <button class="action-btn danger" data-act="del" title="删除"><svg class="icon"><use href="#i-trash"/></svg></button>
        </div>
      </div>
      <div class="phrase-preview">${highlightText(preview, searchQuery)}</div>
      ${(useCount > 0 || showGroup) ? `
      <div class="phrase-meta">
        ${showGroup ? `<span class="dim">${escapeHtml(p._groupName)}</span>` : ''}
        ${useCount > 0 ? `<span class="use-count">已用 ${useCount} 次</span>` : ''}
      </div>` : ''}
    `;

    if (li.draggable) {
      li.addEventListener('dragstart', (e) => {
        dragSrcId = p.id;
        dragSrcKind = 'phrase';
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', p.id);
        // 与分组拖拽共用 rect 缓存：避免每个 mousemove 都触发 layout
        cacheDragRects('.phrase-item');
        requestAnimationFrame(() => li.classList.add('dragging'));
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        clearDropIndicators();
        dragSrcId = null; dragSrcKind = null;
        dragRectCache = null;
      });
      li.addEventListener('dragover', (e) => {
        if (dragSrcKind !== 'phrase' || dragSrcId === p.id) return;
        e.preventDefault();
        const rect = dragRectCache && dragRectCache.get(li);
        if (!rect) return;
        const above = (e.clientY - rect.top) < rect.height / 2;
        scheduleDropIndicator(li, above);
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const rect = li.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        reorderPhrases(dragSrcId, p.id, above);
      });
    }

    // 右键菜单：复用 openContextMenu(x, y, items)，与分组右键一致
    // 「收藏/取消收藏」按当前状态动态切换文案
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [
        { label: '粘贴', icon: 'i-paste-icon', onClick: () => pastePhrase(p) },
        { label: '仅复制', icon: 'i-copy', onClick: () => copyPhrase(p) },
        { type: 'divider' },
        { label: p.fav ? '取消收藏' : '收藏', icon: 'i-pin', onClick: () => toggleFav(p) },
        { label: '编辑', icon: 'i-edit', onClick: () => openPhraseModal(p) },
        { type: 'divider' },
        { label: '删除', icon: 'i-trash', danger: true, onClick: () => deletePhrase(p) },
      ];
      openContextMenu(e.clientX, e.clientY, items);
    });

    frag.appendChild(li);
  }
  list.appendChild(frag);
}

function reorderPhrases(srcId, targetId, above) {
  if (!data.activeGroupId) return;
  const group = data.groups.find((g) => g.id === data.activeGroupId);
  if (!group) return;
  if (srcId === targetId) return;
  const srcIdx = group.phrases.findIndex((p) => p.id === srcId);
  const tgtIdx = group.phrases.findIndex((p) => p.id === targetId);
  if (srcIdx < 0 || tgtIdx < 0) return;
  // 先记下当前选中的那条短语的 id：拖拽后数组下标整体位移，
  // 不修正 selectedPhraseIndex 就会让 .selected 高亮跑到别的短语上去。
  const selectedId = (selectedPhraseIndex >= 0 && group.phrases[selectedPhraseIndex])
    ? group.phrases[selectedPhraseIndex].id
    : null;
  const [moved] = group.phrases.splice(srcIdx, 1);
  let insertAt = group.phrases.findIndex((p) => p.id === targetId);
  if (!above) insertAt += 1;
  group.phrases.splice(insertAt, 0, moved);
  if (selectedId) {
    const newIdx = group.phrases.findIndex((p) => p.id === selectedId);
    selectedPhraseIndex = newIdx >= 0 ? newIdx : -1;
  }
  persist();
  renderPhrases();
}

// 把短语从所在分组挪到目标分组。短语拖动目前只在「全部」视图下启用（renderPhrases 里
// draggable = currentFilter === 'all' && !searchQuery），所以源分组一定等于当前活动分组；
// 但仍走 findPhraseOwner 兜底，避免以后放开拖拽限制（比如允许收藏视图也拖）时漏改。
// 选中态不修正：跨组移动后原列表里这条短语已经不存在，selectedPhraseIndex 重新渲染时会
// 自然失效（指向新索引），下次 moveSelection 会再校正。
function movePhraseToGroup(srcPhraseId, targetGroupId) {
  const owner = findPhraseOwner(srcPhraseId);
  if (!owner) return;
  // 拖回自己所在的分组：无操作（drop 仍然触发，只是不会改变数据）。
  if (owner.group.id === targetGroupId) return;
  const target = data.groups.find((g) => g.id === targetGroupId);
  if (!target) return;
  owner.group.phrases.splice(owner.index, 1);
  // 顶部插入：与「新建短语」位置策略一致，用户挪完立刻就能在最上方看到。
  target.phrases.unshift(owner.phrase);
  // 当前活动分组里少了一条短语时，索引可能越界，重置选中更安全
  if (selectedPhraseIndex >= 0 && data.activeGroupId === owner.group.id) {
    const visible = visiblePhrases();
    if (selectedPhraseIndex >= visible.length) selectedPhraseIndex = -1;
  }
  rebuildPhraseIndex();
  persist();
  renderAll();
  showToast(`已移动到「${target.name}」`, 'success');
}

function renderAll() {
  renderGroups();
  renderPhrases();
  renderQuickAccess();
}

// 侧栏顶部「收藏 / 最近」快捷入口的高亮：被 g/f/r 快捷键和点击共同使用。
// 视觉锚点已经迁移到左侧栏，这里把 active 状态同步过去即可。
function renderQuickAccess() {
  $$('.quick-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.filter === currentFilter);
  });
}

// 切换过滤视图：被 g/f/r 快捷键和侧栏快捷入口共同使用，统一处理选中态重置
function setCurrentFilter(filter) {
  if (!['all', 'fav', 'recent'].includes(filter)) return;
  if (filter === currentFilter) return;
  currentFilter = filter;
  selectedPhraseIndex = -1;
  renderQuickAccess();
  renderPhrases();
}

// 侧栏快捷入口的点击行为：再点一次已激活的「收藏 / 最近」回到「全部」。
// 侧栏里没有「全部」按钮，如果不做这个 toggle，用户点进收藏后就只能靠
// 按 g 键或改点某个分组才能退出去 —— 纯鼠标操作会卡死在该视图里。
function toggleQuickFilter(filter) {
  setCurrentFilter(filter === currentFilter ? 'all' : filter);
}

const renderPhrasesDebounced = debounce(() => renderPhrases(), 80);

// 严格白名单：data.json 被外部脚本写脏（"Paste" / "paste " / "xxx"）时落到 paste
// 是安全的，但显式白名单比"未知值降级到 paste"读起来更明确。提到模块顶层避免
// actOnSelected 每次调用都重新创建数组。
const ALLOWED_CLICK_ACTIONS = ['paste', 'copy'];

// 搜索 query 的唯一写入入口:IME 上屏、英文输入、点清空按钮都走这里,
// 避免散落在多处的赋值 / 隐藏 toggle 出现状态不一致。
function setSearchQuery(q) {
  syncSearchClearVisibility();
  const next = (q || '').trim();
  if (next === searchQuery) return;
  searchQuery = next;
  selectedPhraseIndex = -1;
  renderPhrasesDebounced();
}

// 清空按钮可见性跟输入框实际显示值走(而不是 trim 后的 searchQuery)——
// 这样用户在 IME 拼写过程中输入 "  abc" 时按钮也能正确显示,
// 而搜索匹配仍然按 trim 后的内容来。
function syncSearchClearVisibility() {
  const input = $('search-input');
  $('search-clear').classList.toggle('hidden', input.value.length === 0);
}

function isAnyPanelOpen() {
  return !$('modal').classList.contains('hidden') ||
         !$('prompt-modal').classList.contains('hidden') ||
         !$('settings-panel').classList.contains('hidden');
}

function moveSelection(delta) {
  const phrases = visiblePhrases();
  if (phrases.length === 0) { selectedPhraseIndex = -1; return; }
  if (selectedPhraseIndex < 0) selectedPhraseIndex = 0;
  else selectedPhraseIndex = Math.max(0, Math.min(phrases.length - 1, selectedPhraseIndex + delta));
  const items = $('phrase-list').querySelectorAll('.phrase-item');
  items.forEach((el, i) => el.classList.toggle('selected', i === selectedPhraseIndex));
  const sel = items[selectedPhraseIndex];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function actOnSelected() {
  const phrases = visiblePhrases();
  if (selectedPhraseIndex < 0 || selectedPhraseIndex >= phrases.length) return;
  const p = phrases[selectedPhraseIndex];
  if (!p) return;
  const items = $('phrase-list').querySelectorAll('.phrase-item');
  const item = items[selectedPhraseIndex];
  if (item) {
    item.classList.add('fired');
    setTimeout(() => item.classList.remove('fired'), 700);
  }
  const act = ALLOWED_CLICK_ACTIONS.includes(data.settings && data.settings.clickAction)
    ? data.settings.clickAction : 'paste';
  if (act === 'copy') copyPhrase(p);
  else pastePhrase(p);
}

const persist = (() => {
  let timer = null;
  let pending = null;
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    const snapshot = pending;
    pending = null;
    try {
      const res = await window.api.saveData(snapshot);
      if (res && res.ok === false) showToast(`保存失败：${res.error || '未知错误'}`, 'error');
    } catch (e) {
      console.error('saveData failed:', e);
      showToast(`保存失败：${e.message || e}`, 'error');
    }
  };
  const flushSync = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending || !window.api.saveDataSync) return;
    const snapshot = pending;
    pending = null;
    // pagehide / beforeunload 时 showToast 不会展示（DOM 即将销毁），
    // 但主进程返回的错误至少要在控制台留下诊断信息，方便事后排障。
    try {
      const r = window.api.saveDataSync(snapshot);
      if (r && r.ok === false) {
        console.error('saveDataSync failed:', r.error || 'unknown');
      }
    } catch (e) {
      console.error('saveDataSync failed:', e);
    }
  };
  const fn = (next) => {
    // IPC invoke 已经走 structured clone，主进程拿到的就是独立副本。
    // 这里再 JSON.parse(JSON.stringify(data)) 深拷贝一次是冗余的，每 200ms 防抖窗口
    // 内的任何修改（拖动窗口、粘贴、改设置）都会触发一次全量序列化，删掉。
    pending = next != null ? next : data;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 200);
  };
  fn.flush = flush;
  fn.flushSync = flushSync;
  return fn;
})();

window.addEventListener('pagehide', () => { persist.flushSync(); });
window.addEventListener('beforeunload', () => { persist.flushSync(); });

function recordRecent(phraseId) {
  if (!data.recent) data.recent = [];
  // 先确认短语存在 —— 否则会在 recent 里堆出指向已删除短语的孤立记录，
  // 拖到 50 条后还要再重置数据。
  // 用 phraseIndex 索引，O(1) 拿到 group / phrase 对象，避免每个粘贴都遍历全库。
  const hit = phraseIndex.get(phraseId);
  const target = hit ? hit.phrase : null;
  if (!target) return;

  // useCount 与「最近」列表是独立的统计概念：即使关闭了最近记录，
  // 「已用 N 次」徽章也应当照常增长。早期实现把这两件事绑在一起，
  // 关掉最近记录后徽章也跟着停了，对用户来说是隐藏行为变化。
  target.useCount = (target.useCount || 0) + 1;

  // 「最近」列表的更新受用户偏好控制。
  if (data.settings && data.settings.recordRecent === false) return;

  const idx = data.recent.findIndex((r) => r.id === phraseId);
  if (idx >= 0) data.recent.splice(idx, 1);
  data.recent.unshift({ id: phraseId, ts: Date.now() });
  if (data.recent.length > 50) data.recent.length = 50;
}

async function pastePhrase(phrase) {
  // 「粘贴时隐藏悬浮窗」必须交给主进程：它在 Ctrl+V 之后会把窗口重新显示出来。
  // 如果渲染进程先调 hideWindow() 再走 paste，主进程的「有明确目标」快路径
  // 不负责重显，窗口会一直留在隐藏状态。hideFirst 让主进程走 pasteByHiding。
  const hideFirst = !!(data.settings && data.settings.hideOnPaste);
  let res;
  try {
    res = await window.api.paste(phrase.content || '', { hideFirst });
  } catch (e) {
    // IPC 通道异常（preload 抛错、contextBridge 断开等）——主进程根本没拿到请求
    console.error('paste IPC failed:', e);
    showToast(`粘贴失败：${e.message || e}`, 'error');
    return;
  }
  const ok = res === true || !!(res && res.ok);
  if (!ok) {
    showToast(`粘贴失败：${(res && res.error) || '未知错误'}`, 'error');
    return;
  }
  // 只在真正成功后才计入「最近使用」，失败的不该污染历史
  recordRecent(phrase.id);
  // recordRecent 改的是 data.recent 和 p.useCount，必须落盘——
  // 否则「最近使用」和「已用 N 次」在重启后全部丢失（copyPhrase 一直有 persist，
  // 粘贴路径漏了，导致最常用的那条路径反而不记数）。
  persist();
  // 「最近」/「收藏」角标变化（useCount 从 0→>0、recent 列表变化时需要刷新）
  updateTotals();
  // 触发重渲染：recordRecent 调用后 useCount 已经 +1，任意视图下的「已用 N 次」
  // 数字（无论是首次出现 0→1，还是已有的 N→N+1）都必须立即刷新。
  // 旧条件 useCountJustAppeared || currentFilter === 'recent' 漏了 N→N+1 的常规递增，
  // 导致最常用的那条短语点击后徽章数字不更新——这是用户最常看到的视图卡顿。
  // 「最近」视图的顺序变化也包含在此次重渲染里（list 本来就要重建）。
  renderPhrases();
  // 「hideFirst」走 pasteByHiding 路径，无论 hasTarget 真假 Ctrl+V 都已发送，
  // 这里不能再因 hasTarget=false 提示「请点输入框」——会误导用户以为没粘上。
  // 非 hideFirst 且主进程确实不知道目标窗口（启动后第一次粘贴、lastFgHwnd 失效等）时，
  // 才提示用户手动点一下目标输入框。
  if (!hideFirst && res && res.hasTarget === false) {
    showToast('已复制到剪贴板，请先点一下要输入的位置', 'info');
    return;
  }
  showToast(`已粘贴：${phrase.title || '短语'}`, 'success');
}

async function copyPhrase(phrase) {
  // 走主进程：和「粘贴」共用同一套占位符展开逻辑（{date} / {time} / {clipboard} 等）。
  // 之前用 navigator.clipboard.writeText 时这些占位符是原文落盘，
  // 与粘贴行为不一致，用户粘贴看到正确值，复制却看到 {date}。
  try {
    const res = await window.api.copy(phrase.content || '');
    if (res && res.ok) {
      recordRecent(phrase.id);
      updateTotals();
      showToast(`已复制：${phrase.title || '短语'}`, 'success');
      persist();
      // useCount +1 后「已用 N 次」数字必须立刻刷新：包括 0→1 首次出现、
      // 以及 N→N+1 的常规递增。原条件漏了后者，导致点击后数字看起来不变。
      // 「最近」视图的顺序变化也在这次重渲染里一并覆盖。
      renderPhrases();
    } else {
      showToast(`复制失败：${(res && res.error) || '未知错误'}`, 'error');
    }
  } catch (e) {
    showToast('复制失败：' + (e.message || e), 'error');
  }
}

function renderPlaceholderPreview() {
  const c = $('phrase-content');
  const previewBox = $('placeholder-preview');
  const previewText = $('placeholder-preview-text');
  if (!c || !previewBox || !previewText) return;
  const src = c.value || '';
  // 同时识别 \{xxx\}（字面量）和 {xxx}（活跃占位符）——与主进程 expandPlaceholders 保持一致
  const PLACEHOLDER_RE = /\\?\{(date|time|datetime|weekday|clipboard)\}/g;
  if (!PLACEHOLDER_RE.test(src)) {
    previewBox.classList.add('hidden');
    previewText.innerHTML = '';
    return;
  }
  // 重置 RegExp 的 lastIndex（test() 会改它，再调用 replace 会跳过某些匹配）
  PLACEHOLDER_RE.lastIndex = 0;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const replacements = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()],
    clipboard: '{剪贴板}',
  };
  replacements.datetime = `${replacements.date} ${replacements.time}`;
  // 先 escapeHtml 整个 src：避免把用户输入的原始字符当 HTML 注入
  // 再识别 \{xxx\}（字面量）和 {xxx}（活跃占位符）：
  //   - 字面量：去掉反斜杠，显示为纯文本（不加 mark，因为不是活跃占位符）
  //   - 活跃占位符：用 <mark> 包裹展开值
  const escaped = escapeHtml(src).replace(
    PLACEHOLDER_RE,
    (m, key) => m.startsWith('\\')
      ? escapeHtml('{' + key + '}')
      : `<mark>${escapeHtml(replacements[key])}</mark>`
  );
  previewText.innerHTML = escaped;
  previewBox.classList.remove('hidden');
}

function openPhraseModal(phrase = null) {
  editingPhraseId = phrase ? phrase.id : null;
  $('modal-title').textContent = phrase ? '编辑短语' : '添加短语';
  $('phrase-title').value = phrase ? (phrase.title || '') : '';
  $('phrase-content').value = phrase ? (phrase.content || '') : '';
  $('phrase-fav').checked = phrase ? !!phrase.fav : false;
  refreshSaveButtonState();
  refreshCounter();
  renderPlaceholderPreview();
  $('modal').classList.remove('hidden');
  if (window.api.setTyping) window.api.setTyping(true);
  setTimeout(() => $('phrase-title').focus(), 50);
}

function closePhraseModal() {
  if ($('modal').classList.contains('hidden')) return;
  editingPhraseId = null;
  $('modal').classList.add('hidden');
  // 与 prompt cleanup 保持一致：还有其它面板（设置）打开时不要关掉打字态，
  // 否则设置面板里的输入框瞬间收不到键盘事件。
  if (!isAnyPanelOpen() && window.api.setTyping) window.api.setTyping(false);
}

// 「收藏 / 最近」视图会跨分组展示短语，此时被操作的短语可能根本不在当前 activeGroup 里。
// 所有按 ID 增删改之前都必须先定位它真正所属的分组，否则会静默失败
// （编辑丢改动、删除删不掉、移动不生效）。
//
// 性能：旧实现每次按 ID 查找都要 O(N×M) 遍历所有 group+phrases。
// 维护一份 phraseIndex = Map<id, {group, phrase, index}>，data 变化时重建，
// 查找降到 O(1)。短语库到几百条以上时 recordRecent / findPhraseOwner 的差距肉眼可见。
let phraseIndex = new Map();
function rebuildPhraseIndex() {
  phraseIndex.clear();
  if (!data || !Array.isArray(data.groups)) return;
  for (const g of data.groups) {
    if (!Array.isArray(g.phrases)) continue;
    for (let i = 0; i < g.phrases.length; i++) {
      const p = g.phrases[i];
      if (p && typeof p.id === 'string') phraseIndex.set(p.id, { group: g, phrase: p, index: i });
    }
  }
}

function findPhraseOwner(phraseId) {
  const hit = phraseIndex.get(phraseId);
  if (!hit) return null;
  // index 可能在用户拖拽 / 排序后过期；这里再校准一次以防万一
  // （拖拽路径会走 reorderPhrases，里面的 splice 会让后续 index 整体位移）
  const realIdx = hit.group.phrases.indexOf(hit.phrase);
  return { group: hit.group, phrase: hit.phrase, index: realIdx >= 0 ? realIdx : hit.index };
}

// 「最近」相关的角标 / 计数刷新（使用 recordRecent / 删除短语 后调用）
// 唯一需要触发的副作用是更新侧栏顶部「收藏 / 最近」的角标。
// 旧版 applyToggles 已被合并到 renderPhrases 里，无需再单独调用。
// 原 refreshRecentUi wrapper 已删除，调用点直接用 updateTotals()。

function savePhraseFromModal() {
  const title = $('phrase-title').value.trim();
  const content = $('phrase-content').value;
  const fav = $('phrase-fav').checked;
  if (!content.trim()) {
    showToast('内容不能为空', 'error');
    return;
  }

  if (editingPhraseId) {
    // 编辑：必须用 ID 跨组查找，否则在 收藏 / 最近 视图下打开的编辑弹窗会"保存成功"但实际丢改动
    const owner = findPhraseOwner(editingPhraseId);
    if (owner) {
      owner.group.phrases[owner.index].title = title;
      owner.group.phrases[owner.index].content = content;
      owner.group.phrases[owner.index].fav = fav;
    } else {
      showToast('找不到要编辑的短语，可能已被删除', 'error');
      closePhraseModal();
      return;
    }
  } else {
    // 新增：固定插入到当前活动分组（行为不变）
    const group = data.groups.find((g) => g.id === data.activeGroupId);
    if (!group) {
      showToast('请先选择分组', 'error');
      return;
    }
    group.phrases.unshift({ id: uid('phr'), title, content, fav, useCount: 0 });
    // 增量更新索引：新增条目只在这一条；编辑条目不改变 id，无需动索引。
    rebuildPhraseIndex();
  }
  closePhraseModal();
  persist();
  renderAll();
  showToast(editingPhraseId ? '已更新' : '已添加', 'success');
}

async function deletePhrase(phrase) {
  const label = phrase.title || (phrase.content || '').slice(0, 20) || '该短语';
  const ok = await confirmUser(`确认删除短语「${label}」？`, { title: '删除短语' });
  if (!ok) return;
  // 找出当前显示列表里这条短语的真实位置：删除后需要把选中索引往前提，
  // 否则键盘选中状态会指向空或下一条
  const visible = visiblePhrases();
  const visibleIdx = visible.findIndex((x) => x.id === phrase.id);

  for (const g of data.groups) {
    g.phrases = g.phrases.filter((x) => x.id !== phrase.id);
  }
  if (data.recent) data.recent = data.recent.filter((r) => r.id !== phrase.id);
  // 修复 selectedPhraseIndex：
  // - 选中项就是要删除的项：重置为 -1（renderPhrases 会自动 -1 当超出范围，但
  //   直接重置更准确——删除后用户期望选中态消失，而不是悄悄换到下一条）
  // - 选中项在删除项之后：下移 1
  // - 选中项在删除项之前：保持不变
  if (visibleIdx < 0) {
    // 不可见视图（理论上不应发生，但保留兜底）
  } else if (selectedPhraseIndex === visibleIdx) {
    selectedPhraseIndex = -1;
  } else if (selectedPhraseIndex > visibleIdx) {
    selectedPhraseIndex -= 1;
  }
  // 短语索引同步：被删的 id 还留在 phraseIndex 里会污染下次查找
  rebuildPhraseIndex();
  persist();
  renderAll();
  showToast('已删除', 'success');
}

// 切换收藏：在「最近」/「收藏」跨分组视图下，p 只是源对象的浅拷贝，
// 必须用 _groupId 回写到原始数据，否则修改会在下一次渲染时被覆盖掉。
// 「全部」视图下 p 直接指向源对象，原地修改即可。
function toggleFav(p) {
  if ((currentFilter === 'recent' || currentFilter === 'fav') && p._groupId) {
    const g = data.groups.find((x) => x.id === p._groupId);
    if (g) {
      const real = g.phrases.find((x) => x.id === p.id);
      if (real) {
        real.fav = !real.fav;
        p.fav = real.fav;
      } else {
        p.fav = !p.fav;
      }
    } else {
      p.fav = !p.fav;
    }
  } else {
    p.fav = !p.fav;
  }
  persist();
  // 收藏数变了 → 侧栏「收藏 N」徽章必须同步刷新（否则点完星标看不到数字变化）
  updateTotals();
  renderPhrases();
  showToast(p.fav ? '已加入收藏' : '已取消收藏', 'success');
}

function movePhrase(phrase, delta) {
  if (currentFilter !== 'all' || searchQuery) {
    showToast('清空搜索 / 切换到全部后再调整顺序', 'info');
    return;
  }
  const group = data.groups.find((g) => g.id === data.activeGroupId);
  if (!group) { showToast('当前没有可用分组', 'info'); return; }
  const idx = group.phrases.findIndex((x) => x.id === phrase.id);
  if (idx < 0) { showToast('短语不在当前分组', 'info'); return; }
  // 「全部」视图的显示顺序 == group.phrases 的数组顺序（visiblePhrases 不做任何排序），
  // 所以直接和相邻项交换即可。
  //
  // 旧逻辑假设列表是「收藏区在前、未收藏区在后」，于是只肯在同 fav 的项之间跳着交换。
  // 但这个分区渲染从来没有实现过，结果就是：只要上/下一条的收藏状态和自己不同，
  // Alt+↑/↓ 就静默什么都不做，用户以为快捷键坏了。
  const target = idx + delta;
  if (target < 0 || target >= group.phrases.length) {
    showToast(delta < 0 ? '已经在最顶部' : '已经在最底部', 'info');
    return;
  }
  [group.phrases[idx], group.phrases[target]] = [group.phrases[target], group.phrases[idx]];
  // 选中项的下标按显示顺序换算：本视图下显示顺序 = 数组顺序，所以 idx / target 直接换
  if (selectedPhraseIndex === idx) selectedPhraseIndex = target;
  else if (selectedPhraseIndex === target) selectedPhraseIndex = idx;
  persist();
  renderPhrases();
}

function refreshSaveButtonState() {
  $('modal-save').disabled = !$('phrase-content').value.trim();
}

function refreshCounter() {
  const t = $('phrase-title');
  const c = $('phrase-content');
  const tc = $('title-counter'); if (tc) tc.textContent = `${t.value.length} / 40`;
  const cc = $('content-counter'); if (cc) cc.textContent = `${c.value.length} / 2000`;
}

function onPhraseListClick(e) {
  const favBtn = e.target.closest('[data-act="fav"]');
  if (favBtn) {
    e.stopPropagation();
    const item = favBtn.closest('.phrase-item');
    const idx = parseIdx(item);
    if (idx < 0) return;
    const p = visiblePhrases()[idx];
    if (p) toggleFav(p);
    return;
  }
  const actBtn = e.target.closest('[data-act]');
  if (actBtn) {
    e.stopPropagation();
    const item = actBtn.closest('.phrase-item');
    const idx = parseIdx(item);
    if (idx < 0) return;
    const p = visiblePhrases()[idx];
    if (!p) return;
    const act = actBtn.dataset.act;
    if (act === 'copy') {
      item.classList.add('fired');
      setTimeout(() => item.classList.remove('fired'), 700);
      copyPhrase(p);
    } else if (act === 'edit') openPhraseModal(p);
    else if (act === 'del') deletePhrase(p);
    return;
  }
  const item = e.target.closest('.phrase-item');
  if (!item) return;
  const idx = parseIdx(item);
  if (idx < 0) return;
  const p = visiblePhrases()[idx];
  if (!p) return;
  selectedPhraseIndex = idx;
  $$('.phrase-item').forEach((el, i) => el.classList.toggle('selected', i === idx));
  item.classList.add('fired');
  setTimeout(() => item.classList.remove('fired'), 700);
  actOnSelected();
}

// 把 "dataset.idx" 字符串解析成有效下标：Number(undefined) = NaN、NaN 作为数组下标
// 返回 undefined，导致「点击了但什么都不发生」的静默失败。这里集中防御一次。
function parseIdx(item) {
  if (!item || !item.dataset) return -1;
  const n = Number(item.dataset.idx);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

async function addGroup() {
  const name = await promptUser('给新分组起个名字：', '', { title: '新建分组', placeholder: '例如：客服' });
  if (!name || !name.trim()) return;
  const g = { id: uid('grp'), name: name.trim(), phrases: [] };
  data.groups.push(g);
  data.activeGroupId = g.id;
  currentFilter = 'all';
  // 清空搜索：新建的分组必然是空的，旧搜索词会让 empty-hint 走「没有匹配」分支，
  // 隐藏「添加第一条短语」按钮，用户得手动清搜索框才能继续 —— 体验断裂。
  const sInput = $('search-input');
  if (sInput) sInput.value = '';
  setSearchQuery('');
  selectedPhraseIndex = -1;
  persist();
  renderAll();
  showToast('已新建分组', 'success');
}

async function renameGroup(target = null) {
  // 支持右键传入任意分组，否则默认操作当前激活分组
  const group = target || data.groups.find((g) => g.id === data.activeGroupId);
  if (!group) return;
  const name = await promptUser('把分组重命名为：', group.name, { title: '重命名分组' });
  if (!name || !name.trim()) return;
  group.name = name.trim();
  persist();
  renderAll();
}

async function deleteGroup(target = null) {
  // 支持右键传入任意分组，否则默认操作当前激活分组
  const group = target || data.groups.find((g) => g.id === data.activeGroupId);
  if (!group) return;
  if (data.groups.length === 1) {
    showToast('至少保留一个分组', 'error');
    return;
  }
  const yes = await confirmUser(
    `确认删除分组「${group.name}」？该分组下的 ${group.phrases.length} 条短语也会被删除。`,
    { title: '删除分组' }
  );
  if (!yes) return;
  const removedPhraseIds = new Set(group.phrases.map((p) => p.id));
  data.groups = data.groups.filter((g) => g.id !== group.id);
  if (data.recent) data.recent = data.recent.filter((r) => !removedPhraseIds.has(r.id));
  // 只在被删的是当前激活分组时才切换激活分组，避免误改上下文
  if (data.activeGroupId === group.id) {
    data.activeGroupId = data.groups[0].id;
    // 清空搜索：切换激活分组是上下文变化，旧搜索词可能让新激活的分组
    // 显示「没有匹配」而不是正常列表，用户得手动清搜索框才能继续。
    const sInput = $('search-input');
    if (sInput) sInput.value = '';
    setSearchQuery('');
    selectedPhraseIndex = -1;
  }
  rebuildPhraseIndex();
  persist();
  renderAll();
  showToast('已删除分组', 'success');
}

async function clearGroupPhrases(group) {
  if (!group || group.phrases.length === 0) {
    showToast('该分组已经是空的', 'info');
    return;
  }
  const yes = await confirmUser(
    `确认清空分组「${group.name}」中的 ${group.phrases.length} 条短语？`,
    { title: '清空短语' }
  );
  if (!yes) return;
  const removedIds = new Set(group.phrases.map((p) => p.id));
  group.phrases = [];
  if (data.recent) data.recent = data.recent.filter((r) => !removedIds.has(r.id));
  // 如果选中的短语在被清空的分组里 → 重置；否则选中索引可能指向空位置
  if (selectedPhraseIndex >= 0) {
    const visible = visiblePhrases();
    if (selectedPhraseIndex >= visible.length) selectedPhraseIndex = -1;
  }
  rebuildPhraseIndex();
  persist();
  renderAll();
  showToast('已清空', 'success');
}

async function exportDataNow() {
  const res = await window.api.exportData();
  if (res && res.ok) showToast(`已导出到：${res.filePath}`, 'success');
  else if (res && res.canceled) return;
  else showToast(`导出失败：${(res && res.error) || '未知错误'}`, 'error');
}

function mergeImported(imported) {
  let addedPhrases = 0;
  let updatedPhrases = 0;
  let addedGroups = 0;
  const byGroupId = new Map(data.groups.map((g) => [g.id, g]));
  for (const ig of imported.groups || []) {
    if (!ig || typeof ig.name !== 'string') continue;
    // 分组 id 必须统一为字符串，否则 byGroupId.get 用 ig.id 做 key 时
    // 会和现有字符串 id 走不同的 hash 路径，后续 if (!g) 分支也不会触达合并逻辑。
    const groupId = (typeof ig.id === 'string' && ig.id) ? ig.id : null;
    let g = groupId ? byGroupId.get(groupId) : null;
    if (!g) {
      // 修复：保留导入分组的 ID（如果是合法字符串），后续再次合并时能识别同一组
      const newGroupId = groupId || uid('grp');
      g = { id: newGroupId, name: ig.name, phrases: [] };
      data.groups.push(g);
      byGroupId.set(g.id, g);
      addedGroups++;
    }
    const byPhraseId = new Map(g.phrases.map((p) => [p.id, p]));
    for (const ip of ig.phrases || []) {
      if (!ip || typeof ip.content !== 'string') continue;
      // 短语 id 同样统一为字符串，避免数字/对象 id 被当作字符串 id 误识别。
      const phraseId = (typeof ip.id === 'string' && ip.id) ? ip.id : null;
      const existing = phraseId ? byPhraseId.get(phraseId) : null;
      if (existing) {
        // 修复：导入数据没带 title/fav 时保留现值，避免覆盖为默认值
        existing.title = typeof ip.title === 'string' ? ip.title : existing.title;
        existing.content = ip.content;
        existing.fav = typeof ip.fav === 'boolean' ? ip.fav : existing.fav;
        updatedPhrases++;
      } else {
        // 修复：保留导入短语的 ID，便于后续合并识别同一条
        const newPhraseId = phraseId || uid('phr');
        const newPhrase = {
          id: newPhraseId,
          title: typeof ip.title === 'string' ? ip.title : '',
          content: ip.content,
          fav: !!ip.fav,
          useCount: typeof ip.useCount === 'number' ? ip.useCount : 0,
        };
        g.phrases.push(newPhrase);
        // 关键：把刚 push 的新短语登记回 byPhraseId，
        // 否则导入文件里若出现重复 id 的两条短语，后一条会绕过合并、
        // 直接再加一遍成为重复条目。
        byPhraseId.set(newPhraseId, newPhrase);
        addedPhrases++;
      }
    }
  }
  return { addedGroups, addedPhrases, updatedPhrases };
}

async function importDataNow() {
  const input = $('import-file-input');
  if (!input) {
    showToast('导入入口不可用', 'error');
    return;
  }
  input.value = '';
  input.click();
}

async function applyImportedData(incoming) {
  const totalGroups = (incoming.groups || []).length;
  const totalPhrases = (incoming.groups || []).reduce(
    (n, g) => n + ((g && g.phrases) ? g.phrases.length : 0), 0
  );
  const choice = await openPromptModal({
    title: '导入短语',
    message: `检测到 ${totalGroups} 个分组、${totalPhrases} 条短语。\n输入「替换」将覆盖现有数据，输入其他内容或留空则按 ID 合并。`,
    defaultValue: '',
    placeholder: '替换 / 合并',
    okLabel: '确定',
    icon: 'info',
    showInput: true,
  });
  if (choice == null) return;
  const mode = String(choice).trim();
  if (mode === '替换') {
    // 修复：导入数据里 groups 为空时不应该把整个分组列表清空，
    // 否则 activeGroupId 变成 null、UI 进入「请先选择分组」的死锁状态。
    if (!incoming.groups || incoming.groups.length === 0) {
      showToast('导入数据中没有分组，已取消替换', 'error');
      return;
    }
    // 替换前先索引一下当前 data 里所有短语的 useCount：
    // 用户经常「导出备份 → 删了几条 → 导入同一份备份」来撤销删短语，
    // 备份里那条的 useCount 是 0，但当前 data 里它可能是 87。
    // 盲替换会让所有累计使用次数归零，这是毫无意义的统计回退。
    const existingUseCount = new Map();
    for (const g of data.groups || []) {
      for (const p of g.phrases || []) {
        existingUseCount.set(p.id, p.useCount || 0);
      }
    }
    const groups = (incoming.groups || []).map((g) => {
      // 替换模式也要守住「content 必须是字符串」这道关。
      // 合并模式在 mergeImported 里逐条 continue 跳过了，这里直接过滤掉。
      const safePhrases = (g.phrases || [])
        .filter((p) => p && typeof p.content === 'string')
        .map((p) => {
          const id = (typeof p.id === 'string' && p.id) ? p.id : uid('phr');
          return {
            id,
            title: typeof p.title === 'string' ? p.title : '',
            content: p.content,
            fav: !!p.fav,
            // 导入文件带 useCount 用导入的，否则从本地旧数据里找回（同 id 的累积计数）
            useCount: typeof p.useCount === 'number'
              ? p.useCount
              : (existingUseCount.get(id) || 0),
          };
        });
      return {
        // 保留导入的 ID：替换通常是恢复备份，ID 一致便于后续合并/对比/调试
        id: (typeof g.id === 'string' && g.id) ? g.id : uid('grp'),
        name: typeof g.name === 'string' && g.name ? g.name : '未命名分组',
        phrases: safePhrases,
      };
    });
    // activeGroupId 必须在新 groups 数组构建完之后再算 —— 旧版本放在对象字面量里
    // 写成 null、再下一行再赋值，逻辑没错但读起来很怪，重组后更清晰。
    data = {
      groups,
      recent: [],
      settings: data.settings,
      activeGroupId: groups[0]?.id || null,
    };
    showToast(`已替换：${totalPhrases} 条短语`, 'success');
  } else {
    const r = mergeImported(incoming);
    showToast(
      `已合并：新增 ${r.addedGroups} 分组 / ${r.addedPhrases} 短语，更新 ${r.updatedPhrases} 短语`,
      'success'
    );
  }
  // 兜底校验：合并模式下用户的 activeGroupId 仍指向旧分组（merge 不会删除），
  // 替换模式理论上 groups[0]?.id 已指向新数据，但万一导入数据本身有问题
  // （id 类型异常等）也兜底回到第一个分组。
  if (!data.groups.find((g) => g.id === data.activeGroupId)) {
    data.activeGroupId = data.groups[0]?.id || null;
  }
  selectedPhraseIndex = -1;
  currentFilter = 'all';
  // 替换模式下清空搜索：旧搜索词在全新数据里大概率 0 命中，挡住正常浏览；
  // 合并模式下保留搜索：用户大概率是想用搜索词找刚合并进来的新短语。
  if (mode === '替换') {
    const sInput = $('search-input');
    if (sInput) sInput.value = '';
    setSearchQuery('');
  }
  // 导入后整张短语库都变了，索引必须重建
  rebuildPhraseIndex();
  // 导入必须同步刷盘，原因有两个：
  // 1. 主进程持有 cachedDataSnapshot，「最近」清空等场景需要这次 save 才能拿到新快照；
  //    走异步 persist() → 200ms 防抖窗口里 scheduleSaveBounds 仍可能用旧快照覆盖磁盘
  // 2. beforeunload 时已经走过 flushSync，再走异步 persist 不会更快落盘
  if (window.api.saveDataSync) {
    try {
      const r = window.api.saveDataSync(data);
      if (r && r.ok === false) {
        showToast(`导入后保存失败：${r.error || '未知错误'}`, 'error');
      }
    } catch (e) {
      showToast(`导入后保存失败：${e.message || e}`, 'error');
    }
  } else {
    persist();
  }
  renderAll();
}

function togglePanel(id, show) {
  const panel = $(id);
  if (!panel) return;
  if (show == null) show = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  if (show) {
    if (window.api.setTyping) window.api.setTyping(true);
    if (id === 'settings-panel') refreshSettingsUI();
  } else {
    // 关闭设置面板时若还在录制态 → 一并退出，避免面板隐藏后用户看不到录制 UI、
    // 不知道按了什么键其实被记录了。stopRecordShortcut 是 function declaration，
    // 写在文件后面也能正常 hoist 引用。
    if (id === 'settings-panel' && isRecordingShortcut) stopRecordShortcut();
    if (isAnyPanelOpen()) return;
    if (window.api.setTyping) window.api.setTyping(false);
  }
}

// 把 data.settings.opacity 同步到主进程 + 设置面板 UI。启动和 refreshSettingsUI 都复用，
// 避免重复 IPC（旧的实现 init() 调一次、refreshSettingsUI 又调一次共两遍）。
function applyOpacityFromSettings() {
  const s = (data && data.settings) || {};
  const op = s.opacity != null ? s.opacity : 100;
  const slider = $('opacity-slider');
  if (slider) slider.value = String(op);
  const opVal = $('opacity-value');
  if (opVal) opVal.textContent = String(op);
  if (window.api.setOpacity) {
    try { window.api.setOpacity(op / 100); } catch {}
  }
}

function refreshSettingsUI() {
  const s = data.settings || {};
  document.body.dataset.theme = s.theme || 'dark';
  $$('#theme-segmented .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === (s.theme || 'dark'));
  });
  applyOpacityFromSettings();
  const act = s.clickAction || 'paste';
  $$('#click-action-segmented .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.action === act);
  });
  const hide = $('hide-on-paste-toggle');
  if (hide) hide.checked = !!s.hideOnPaste;
  const rec = $('recent-toggle');
  if (rec) rec.checked = s.recordRecent !== false;
  refreshRecentDesc();
  refreshUseCountDesc();
  const pathEl = $('data-path-value');
  // 总是向主进程要一次最新路径：旧的「只在为占位符时拉取」实现里，
  // 一旦该字段因为其他原因先被改写过（比如未来给用户展示相对路径），
  // 真实的绝对路径就再也不会被写回了。改成无条件更新，行为更稳。
  if (pathEl && window.api.getDataPath) {
    window.api.getDataPath().then((p) => { if (p) pathEl.textContent = p; });
  }
  // 开机自启动：以操作系统状态（注册表 / macOS 登录项）为唯一真相。
  // 不依赖 data.settings —— 外部修改（用户手动改注册表、卸载时勾选等）也能即时反映。
  // OS 调用失败时回退到 data.settings.autoLaunch，仍然是个有意义的 UI 缓存。
  // 注意：失败时主进程会返回 { ok: false, enabled: false }，不能用 typeof === 'boolean'
  // 来判断 —— 否则会把 failure 的 enabled:false 当真，把用户上次保存的开启状态覆盖掉。
  const autoLaunch = $('auto-launch-toggle');
  if (autoLaunch && window.api.getAutoLaunch) {
    window.api.getAutoLaunch().then((res) => {
      if (res && res.ok === true && typeof res.enabled === 'boolean') {
        autoLaunch.checked = res.enabled;
      } else if (s.autoLaunch != null) {
        autoLaunch.checked = !!s.autoLaunch;
      }
    });
  }
  // 全局快捷键：每次打开面板都拉一次最新值（异步 IPC，成本可忽略）。
  // 拉到后写进 <kbd>；HTML 里硬编码的占位「Ctrl+Shift+V」只是兜底。
  refreshShortcutDisplay();
}

function refreshRecentDesc() {
  const desc = $('recent-count-desc');
  if (!desc) return;
  const n = (data.recent || []).length;
  desc.textContent = n === 0 ? '还没有记录' : `当前共 ${n} 条最近使用记录`;
}

// 「已用 N 次」徽章的累计统计：跨所有分组的 useCount 求和，
// 让用户在清空前能看到总次数，而不是只能凭印象猜。
function refreshUseCountDesc() {
  const desc = $('usecount-count-desc');
  if (!desc) return;
  let total = 0;
  let countedPhrases = 0;
  for (const g of data.groups || []) {
    for (const p of g.phrases || []) {
      const c = p.useCount || 0;
      if (c > 0) {
        total += c;
        countedPhrases++;
      }
    }
  }
  if (total === 0) desc.textContent = '还没有使用记录';
  else desc.textContent = `已累计 ${total} 次使用（${countedPhrases} 条短语）`;
}

// 把主进程的当前全局快捷键值刷到设置面板的 <kbd> 上。
// IPC 是异步的，IPC 返回前 HTML 占位符「Ctrl+Shift+V」会被用户看到，
// 几乎无感知；这样避免在 HTML 里假设默认值导致主进程没启动时显示错。
function refreshShortcutDisplay() {
  if (!window.api.getGlobalToggle) return;
  window.api.getGlobalToggle().then((acc) => {
    const display = $('shortcut-display');
    if (display && acc) display.textContent = formatAcceleratorForDisplay(acc);
  });
}

/* ==================== 全局快捷键录制 ==================== */
// 录制流程的状态机：
//   startRecordShortcut() → 进入录制态（按钮高亮、kbd 脉冲）
//   stopRecordShortcut()  → 退出录制态（恢复原 UI）
//   applyRecordedShortcut() / resetShortcut() → IPC 写盘 + 重注册，更新 <kbd>
//
// 实际的 keydown 处理在 setupKeyboardShortcuts 顶部（优先级最高）。
// 单独抽函数是因为按钮点击和 keydown 都要触发停止，逻辑共享更稳。

function startRecordShortcut() {
  if (isRecordingShortcut) {
    // 再点一次「录制」按钮 → 等价于按 Esc 取消
    stopRecordShortcut();
    return;
  }
  isRecordingShortcut = true;
  recordInvalidShown = false;
  const display = document.querySelector('.shortcut-display');
  if (display) display.classList.add('recording');
  const btn = $('btn-record-shortcut');
  if (btn) {
    btn.classList.add('recording');
    btn.textContent = '按 Esc 取消';
  }
}

function stopRecordShortcut() {
  isRecordingShortcut = false;
  const display = document.querySelector('.shortcut-display');
  if (display) display.classList.remove('recording');
  const btn = $('btn-record-shortcut');
  if (btn) {
    btn.classList.remove('recording');
    btn.textContent = '录制';
  }
}

async function applyRecordedShortcut(acc) {
  try {
    const res = await window.api.setGlobalToggle(acc);
    if (res && res.ok) {
      const shown = formatAcceleratorForDisplay(res.accelerator || acc);
      const display = $('shortcut-display');
      if (display) display.textContent = shown;
      // 同步本地 data.settings.shortcuts：主进程已经把新值写盘，但渲染层 data 对象
      // 是后保存的引用，不主动更新的话下次 persist() 会把陈旧的 settings 整体覆盖回去，
      // 快捷键这条改动就丢了。和 autoLaunch 处理方式一致。
      if (!data.settings) data.settings = {};
      if (!data.settings.shortcuts) data.settings.shortcuts = {};
      data.settings.shortcuts.globalToggle = res.accelerator || acc;
      showToast(res.unchanged ? '已是当前快捷键' : `已更新：${shown}`, 'success');
    } else {
      showToast(`快捷键更新失败：${(res && res.error) || '未知错误'}`, 'error');
    }
  } catch (err) {
    showToast(`快捷键更新失败：${err.message || err}`, 'error');
  }
}

async function resetShortcut() {
  // 默认值与 main.js 的 DEFAULT_GLOBAL_TOGGLE 保持一致：
  // 通过 IPC 让主进程统一处理写盘 + 重注册，渲染层只负责 UI 反馈
  try {
    const res = await window.api.setGlobalToggle('CommandOrControl+Shift+V');
    if (res && res.ok) {
      const display = $('shortcut-display');
      if (display) display.textContent = 'Ctrl+Shift+V';
      // 同 applyRecordedShortcut：本地缓存要同步，否则下次 persist 会回滚
      if (!data.settings) data.settings = {};
      if (!data.settings.shortcuts) data.settings.shortcuts = {};
      data.settings.shortcuts.globalToggle = 'CommandOrControl+Shift+V';
      showToast('已恢复默认', 'success');
    } else {
      showToast(`恢复默认失败：${(res && res.error) || '未知错误'}`, 'error');
    }
  } catch (err) {
    showToast(`恢复默认失败：${err.message || err}`, 'error');
  }
}

function initSettings() {
  $$('#theme-segmented .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      data.settings.theme = theme;
      document.body.dataset.theme = theme;
      $$('#theme-segmented .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      persist();
    });
  });
  const slider = $('opacity-slider');
  if (slider) {
    // 拖滑块时 input 事件 60+ fps 触发，每次都走 IPC + 主进程 setOpacity 不可忽略。
    // 用 rAF 把多次 input 合并成每帧最多一次 IPC（节流到 ~60fps 上限），
    // 落盘仍每次触发（200ms 防抖窗口内会合并，不会打爆磁盘）。
    let opacityRaf = null, pendingOpacity = null;
    slider.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      const opVal = $('opacity-value');
      if (opVal) opVal.textContent = String(v);
      data.settings.opacity = v;
      pendingOpacity = v / 100;
      if (opacityRaf) return;
      opacityRaf = requestAnimationFrame(() => {
        opacityRaf = null;
        const next = pendingOpacity;
        pendingOpacity = null;
        if (next != null && window.api.setOpacity) {
          try { window.api.setOpacity(next); } catch {}
        }
      });
      persist();
    });
  }
  $$('#click-action-segmented .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      data.settings.clickAction = btn.dataset.action;
      $$('#click-action-segmented .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      persist();
    });
  });
  const hide = $('hide-on-paste-toggle');
  if (hide) {
    hide.addEventListener('change', () => {
      data.settings.hideOnPaste = hide.checked;
      persist();
    });
  }
  const rec = $('recent-toggle');
  if (rec) {
    rec.addEventListener('change', () => {
      data.settings.recordRecent = rec.checked;
      if (!rec.checked) data.recent = [];
      persist();
      renderAll();
      refreshRecentDesc();
    });
  }
  const clr = $('btn-clear-recent');
  if (clr) {
    clr.addEventListener('click', async () => {
      const yes = await confirmUser('确认清空所有最近使用记录？', { title: '清空最近' });
      if (!yes) return;
      data.recent = [];
      persist();
      renderAll();
      refreshRecentDesc();
      showToast('已清空最近记录', 'success');
    });
  }
  // 「已用 N 次」徽章的累计清零：useCount 与「最近」列表是独立统计，
  // 所以走自己的按钮，不会顺带影响最近使用历史。
  const clrUse = $('btn-clear-usecount');
  if (clrUse) {
    clrUse.addEventListener('click', async () => {
      let total = 0;
      for (const g of data.groups || []) {
        for (const p of g.phrases || []) total += p.useCount || 0;
      }
      if (total === 0) {
        showToast('还没有使用记录', 'info');
        return;
      }
      const yes = await confirmUser(
        `确认将所有短语的「已用 N 次」清零？当前累计 ${total} 次使用。`,
        { title: '清空使用统计' }
      );
      if (!yes) return;
      for (const g of data.groups || []) {
        for (const p of g.phrases || []) p.useCount = 0;
      }
      persist();
      renderAll();
      refreshUseCountDesc();
      showToast('已清空使用统计', 'success');
    });
  }
  // 开机自启动：开关状态由 OS 写入（注册表 / macOS 登录项），
  // 这里只负责发 IPC + 把 OS 返回值持久化到 data.settings 作为下次启动的 UI 回退。
  // OS 写入失败要把 UI 翻转回原值，避免显示与实际状态不一致。
  const autoLaunch = $('auto-launch-toggle');
  if (autoLaunch) {
    autoLaunch.addEventListener('change', async () => {
      const want = autoLaunch.checked;
      if (!window.api.setAutoLaunch) return;
      let res;
      try {
        res = await window.api.setAutoLaunch(want);
      } catch (e) {
        res = { ok: false, error: e.message || String(e) };
      }
      if (!res || res.ok !== true) {
        autoLaunch.checked = !want;
        showToast(`设置开机自启动失败：${(res && res.error) || '未知错误'}`, 'error');
        return;
      }
      if (!data.settings) data.settings = {};
      data.settings.autoLaunch = res.enabled;
      persist();
      showToast(res.enabled ? '已开启：开机自启动' : '已关闭：开机自启动', 'info');
    });
  }
  // 全局快捷键录制 / 恢复默认。
  // 录制按钮在点第二次时走 startRecordShortcut 内部的 toggle 分支退出录制。
  // 恢复默认直接发默认 accelerator，IPC 那边会做去重 + 重注册。
  const recordBtn = $('btn-record-shortcut');
  if (recordBtn) recordBtn.addEventListener('click', startRecordShortcut);
  const resetShortcutBtn = $('btn-reset-shortcut');
  if (resetShortcutBtn) resetShortcutBtn.addEventListener('click', resetShortcut);
}

/* ==================== 全局键盘快捷键 ====================
// README 里宣传的快捷键之前完全没有 keydown 监听器，全部都失效。
// 这里统一处理：优先级 弹窗 > 输入框 > 列表导航。
//
// 设计要点：
// 1. 弹窗/面板打开时只处理 Esc / Ctrl+Enter 等弹窗内的快捷键，
//    不响应 Ctrl+B / g/f/r 等全局快捷键，避免误触。
// 2. 焦点在输入框 / 文本域时，普通字符键（g/f/r/数字/斜杠）不触发，
//    让用户能正常输入。Ctrl 系列、Esc、Alt+方向 仍然响应。
// 3. 数字键直触 1~9 走的是「按当前可见顺序的前 9 条」，
//    通过 visiblePhrases() 拿到的列表，搜索 / 过滤器都会影响它。 */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    /* ====== 0. 录制全局快捷键（最高优先级） ======
       放在所有分支最前面：录制期间用户的按键不能被任何弹窗逻辑吞掉，
       也不能让 Ctrl+字母被现有 Ctrl+N/G/B/F/, 系列吃掉。 */
    if (isRecordingShortcut) {
      // Esc 取消录制
      if (e.key === 'Escape') {
        e.preventDefault();
        stopRecordShortcut();
        return;
      }
      // 修饰键单独按下 → 继续等待主键
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      // 吞掉默认行为：方向键滚动、F1 帮助、Tab 切焦点 等在录制态下都不该触发
      e.preventDefault();
      const acc = keyEventToAccelerator(e);
      if (!acc) {
        // 没有修饰键（单按字母 / 数字 / 符号）→ 一次性 toast 提示，避免每按一个键都刷
        if (!recordInvalidShown) {
          showToast('需要包含至少一个修饰键（Ctrl / Alt / Shift）', 'info');
          recordInvalidShown = true;
        }
        return;
      }
      stopRecordShortcut();
      applyRecordedShortcut(acc);
      return;
    }

    const modalOpen = !$('modal').classList.contains('hidden');
    const promptOpen = !$('prompt-modal').classList.contains('hidden');
    const settingsOpen = !$('settings-panel').classList.contains('hidden');
    const anyPanelOpen = modalOpen || promptOpen || settingsOpen;

    const active = document.activeElement;
    const tag = active && active.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (active && active.isContentEditable);
    // 搜索框获得焦点时再单独判一次，便于决定 Esc / Enter 的行为
    const isSearch = active === $('search-input');

    /* ====== 1. 弹窗内的快捷键（最高优先级） ====== */
    if (modalOpen) {
      // Ctrl+Enter 保存短语
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'Enter' || e.key === '\n')) {
        e.preventDefault();
        if (!$('modal-save').disabled) savePhraseFromModal();
        return;
      }
      // Esc 关闭短语弹窗
      if (e.key === 'Escape') {
        e.preventDefault();
        closePhraseModal();
        return;
      }
      // 弹窗打开时不响应其它快捷键
      return;
    }
    if (promptOpen) {
      // Esc 关闭提示弹窗（按钮上的 click 已经监听）
      if (e.key === 'Escape') {
        e.preventDefault();
        $('prompt-cancel').click();
        return;
      }
      // 提示弹窗里 Enter 直接确认
      if (e.key === 'Enter') {
        e.preventDefault();
        $('prompt-ok').click();
        return;
      }
      return;
    }
    if (settingsOpen) {
      if (e.key === 'Escape') { e.preventDefault(); togglePanel('settings-panel', false); return; }
      return;
    }

    /* ====== 2. Esc 顶层兜底：清空搜索 / 隐藏窗口 ====== */
    if (e.key === 'Escape') {
      if (isSearch || searchQuery) {
        e.preventDefault();
        const si = $('search-input');
        if (si) si.value = '';
        setSearchQuery('');
        if (isSearch) si.blur();
        return;
      }
      // 没有任何面板打开、也不在搜索 → 隐藏到托盘
      if (window.api.hideWindow) {
        e.preventDefault();
        window.api.hideWindow();
      }
      return;
    }

    /* ====== 3. Ctrl / Meta 系列：不管焦点在哪都响应 ====== */
    if (e.ctrlKey || e.metaKey) {
      const k = (e.key || '').toLowerCase();
      if (e.shiftKey) {
        // Ctrl+Shift+V 由主进程的 globalShortcut 接管，这里只挡一下默认行为
        if (k === 'v') { e.preventDefault(); return; }
      }
      switch (k) {
        case 'n':
          e.preventDefault();
          openPhraseModal();
          return;
        case 'g':
          e.preventDefault();
          addGroup();
          return;
        case 'b':
          e.preventDefault();
          toggleSidebar();
          return;
        case 'f':
          e.preventDefault();
          {
            const si = $('search-input');
            if (si) { si.focus(); si.select(); }
          }
          return;
        case ',':
          e.preventDefault();
          // 不传 show 参数 → togglePanel 内部走「根据当前 hidden 状态反转」分支，
          // 这样再按一次 Ctrl+, 能正确关闭设置面板（之前传 true 永远显示）。
          togglePanel('settings-panel');
          return;
      }
      return;
    }

    /* ====== 4. Alt + 方向键：调整顺序（在输入框里也能用） ====== */
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const phrases = visiblePhrases();
      const p = phrases[selectedPhraseIndex];
      if (p) movePhrase(p, e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    /* ====== 5. 输入框内只看 Alt+方向 / Esc，其它字符都让浏览器处理 ====== */
    if (isInput) return;

    /* ====== 6. 字符类快捷键：/、g/f/r、1~9 ====== */
    // ? 原先是打开帮助面板的，现在帮助面板已经从界面去掉，删掉避免误触后无效果
    if (e.key === '/') {
      e.preventDefault();
      const si = $('search-input');
      if (si) { si.focus(); si.select(); }
      return;
    }
    if (e.key === 'g' || e.key === 'G') { e.preventDefault(); setCurrentFilter('all'); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setCurrentFilter('fav'); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); setCurrentFilter('recent'); return; }

    // 数字键直触：当前可见顺序的前 9 条
    if (e.key >= '1' && e.key <= '9') {
      const idx = Number(e.key) - 1;
      const phrases = visiblePhrases();
      if (phrases[idx]) {
        e.preventDefault();
        // 选中态同步：actOnSelected 不会改 .selected，但 actOnSelected 内部会把
        // items[selectedPhraseIndex] 加 .fired 触发动画，所以这里只需手动同步选中高亮。
        // 否则按完 5 视觉上还在原选中上，下次按 ↓ 仍跳到原 idx——反馈错位。
        selectedPhraseIndex = idx;
        $$('.phrase-item').forEach((el, i) => {
          el.classList.toggle('selected', i === idx);
        });
        actOnSelected();
      }
      return;
    }

    /* ====== 7. 方向键导航 + Enter 触发 ====== */
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
      return;
    }
    if (e.key === 'Enter') {
      const phrases = visiblePhrases();
      if (phrases.length === 0) return;
      if (selectedPhraseIndex < 0) {
        // 搜索/重渲染后还没用方向键选过：Enter 默认取第一条，
        // 与数字键 1 的行为保持一致（避免输入完搜索词立刻按 Enter 无响应）
        selectedPhraseIndex = 0;
        $$('.phrase-item').forEach((el, i) => el.classList.toggle('selected', i === 0));
      }
      e.preventDefault();
      actOnSelected();
      return;
    }
  });
}

async function init() {
  data = await window.api.loadData();
  // 防御性兜底：主进程在 whenReady 之前一切异常都可能导致返回 null/undefined，
  // 此处不能让 null 走到下面的 data.groups / data.recent 访问上。
  if (!data || typeof data !== 'object') data = { groups: [], recent: [], settings: {} };
  if (!data.groups) data.groups = [];
  if (!data.recent) data.recent = [];
  if (!data.settings) {
    data.settings = {
      theme: 'dark', opacity: 100, clickAction: 'paste',
      hideOnPaste: false, recordRecent: true,
      alwaysOnTop: true,
    };
  }
  // 老数据没有 alwaysOnTop 时按"开启"处理（保持历史行为）
  if (typeof data.settings.alwaysOnTop !== 'boolean') {
    data.settings.alwaysOnTop = true;
  }
  if (!data.groups.find((g) => g.id === data.activeGroupId)) {
    data.activeGroupId = data.groups[0]?.id || null;
  }
  if (!data.activeGroupId && data.groups.length > 0) {
    data.activeGroupId = data.groups[0].id;
  }

  // 短语 ID → {group, phrase, index} 索引：让 findPhraseOwner / recordRecent 走 O(1) 查找。
  // 启动期 / 导入完成后都重建一次，后续 mutate 入口（add/delete/move/import）后也会重建。
  rebuildPhraseIndex();

  document.body.dataset.theme = data.settings.theme || 'dark';
  // 透明度初始化：刷新 slider / 标签和发 setOpacity IPC 都由下面的
  // refreshSettingsUI 统一做一次（refreshSettingsUI 内部会调 applyOpacityFromSettings），
  // 不要再单独跑一次，否则启动期会多发一次 setOpacity 跨进程调用。

  // 把磁盘上的置顶偏好同步到主进程；主进程在 createWindow 里已经读过一次，
  // 这里再做一次幂等更新，避免数据被外部修改（导入/手动编辑）后状态不一致。
  if (window.api.setAlwaysOnTop) {
    try { window.api.setAlwaysOnTop(data.settings.alwaysOnTop); } catch {}
  }
  applyPinButtonUI(data.settings.alwaysOnTop);

  // 先应用折叠态再渲染，避免首屏出现「先展开再收缩」的闪烁
  applySidebarState();

  renderAll();
  refreshSettingsUI();

  $('btn-hide').addEventListener('click', () => window.api.hideWindow && window.api.hideWindow());
  // 两份按钮都绑同一个 toggle：侧栏展开时 sidebar-footer 的「折叠」按钮可见，
  // 侧栏折叠时 add-bar 左边的「展开」按钮可见，两者互斥显示。
  $('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  const expandBtn = $('btn-expand-sidebar');
  if (expandBtn) expandBtn.addEventListener('click', toggleSidebar);

  // 标题栏设置按钮：直接打开设置面板
  $('btn-settings').addEventListener('click', () => togglePanel('settings-panel', true));

  // 置顶开关：标题栏上的小按钮，点击即时切换窗口层级
  const pinBtn = $('btn-pin-top');
  if (pinBtn) {
    pinBtn.addEventListener('click', async () => {
      const next = !data.settings.alwaysOnTop;
      // 先发 IPC（主进程会调 setAlwaysOnTop），再落盘、再切 UI。
      // 失败也不阻塞 UI：用户点了就当生效，最坏下次启动再修正。
      let ok = next;
      if (window.api.setAlwaysOnTop) {
        try {
          const res = await window.api.setAlwaysOnTop(next);
          // 主进程返回应用后的真实状态（理论上永远等于 next，但保留防御）
          if (typeof res === 'boolean') ok = res;
        } catch {}
      }
      data.settings.alwaysOnTop = ok;
      applyPinButtonUI(ok);
      persist();
      showToast(ok ? '已开启：始终置顶' : '已关闭：始终置顶', 'info');
    });
  }

  const reveal = async () => {
    const ok = await window.api.revealDataFile();
    if (!ok) showToast('打开文件管理器失败', 'error');
  };
  const revealBtn = $('btn-reveal-file-2');
  if (revealBtn) revealBtn.addEventListener('click', reveal);

  // 「关于」区：链接 + 右侧「打开」按钮都通过 IPC 跳到主进程
  // 用 shell.openExternal 走系统默认浏览器，避免在当前 Electron 窗口里直接跳转。
  const openDeveloper = async () => {
    const link = $('link-developer');
    const url = link ? link.getAttribute('href') : '';
    if (!url) return;
    const ok = await window.api.openExternal(url);
    if (!ok) showToast('打开链接失败', 'error');
  };
  const openDevBtn = $('btn-open-developer');
  if (openDevBtn) openDevBtn.addEventListener('click', openDeveloper);
  const devLink = $('link-developer');
  if (devLink) devLink.addEventListener('click', (e) => {
    // 阻止默认导航（避免把 Electron 窗口带飞），统一走 IPC
    e.preventDefault();
    openDeveloper();
  });

  // 面板关闭：data-close 按钮 + 点遮罩区域
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      const panel = closeBtn.closest('.panel');
      if (panel) togglePanel(panel.id, false);
      return;
    }
    if (e.target.classList && e.target.classList.contains('panel-backdrop')) {
      const panel = e.target.closest('.panel');
      if (panel) togglePanel(panel.id, false);
    }
  });

  // 数据路径展示在 refreshSettingsUI 内按需懒加载（首次打开设置面板时才请求主进程），
  // 这里不必再额外调一次 getDataPath，避免与 refreshSettingsUI 抢着写 DOM 引发竞态。

  $('btn-add-group').addEventListener('click', addGroup);

  $('btn-add-phrase').addEventListener('click', () => openPhraseModal());

  // 空状态里的快速「添加第一条」按钮
  const emptyAdd = $('empty-add-btn');
  if (emptyAdd) emptyAdd.addEventListener('click', () => openPhraseModal());

  $('phrase-list').addEventListener('click', onPhraseListClick);

  // 侧栏顶部「收藏 / 最近」点击：切换过滤视图，
  // 再点一次已激活的项则退回「全部」（侧栏没有「全部」按钮，需要这个出口）。
  $$('.quick-item').forEach((el) => {
    el.addEventListener('click', () => toggleQuickFilter(el.dataset.filter));
  });

  // IME 拼写期间(input 在 composition 中)只同步清空按钮可见性,
  // 搜索推迟到 compositionend 之后再触发,避免拼音过程里搜索结果不停闪烁。
  let searchComposing = false;
  $('search-input').addEventListener('compositionstart', () => {
    searchComposing = true;
  });
  $('search-input').addEventListener('compositionend', (e) => {
    searchComposing = false;
    setSearchQuery(e.target.value);
  });
  $('search-input').addEventListener('input', (e) => {
    if (searchComposing) {
      syncSearchClearVisibility();
      return;
    }
    setSearchQuery(e.target.value);
  });
  $('search-clear').addEventListener('click', () => {
    $('search-input').value = '';
    setSearchQuery('');
    $('search-input').focus();
  });

  $('modal-close').addEventListener('click', closePhraseModal);
  $('modal-cancel').addEventListener('click', closePhraseModal);
  $('modal-save').addEventListener('click', savePhraseFromModal);
  $('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closePhraseModal();
  });
  $('phrase-title').addEventListener('input', refreshCounter);
  $('phrase-content').addEventListener('input', () => {
    refreshSaveButtonState();
    refreshCounter();
    renderPlaceholderPreview();
  });

  initSettings();
  setupKeyboardShortcuts();

  $('btn-export').addEventListener('click', exportDataNow);
  $('btn-import').addEventListener('click', importDataNow);
  const importInput = $('import-file-input');
  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const incoming = JSON.parse(text);
        if (!incoming || !Array.isArray(incoming.groups)) {
          showToast('导入失败：文件格式不合法（缺少 groups 数组）', 'error');
          return;
        }
        await applyImportedData(incoming);
      } catch (err) {
        showToast(`导入失败：${err.message || err}`, 'error');
      } finally {
        importInput.value = '';
      }
    });
  }

  refreshSaveButtonState();
  refreshCounter();
}

init().catch((e) => {
  console.error('init failed:', e);
  showToast('初始化失败，尝试重启应用', 'error');
});

// 全局错误兜底：把渲染层的未捕获异常和未处理的 Promise 拒绝落地到日志，
// 避免 Chromium 默默吞掉、用户只看到界面卡死不知道发生了什么。
window.addEventListener('error', (e) => {
  console.error('[renderer error]', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer unhandledrejection]', e.reason);
});
