# Quick Paste

桌面悬浮的剪贴板工具：按分组管理常用句子，点一下就粘贴到当前正在输入的窗口。

写代码、做客服、写文案时总有几句话要重复敲——问候、结束语、固定回复、常用代码片段。把它做成常驻桌面的悬浮窗，分组整理好，一键贴到任意正在输入的窗口。

- 不抢焦点，点完继续干活
- 不挑场景，浏览器、记事本、Office、微信、QQ、IDE 都能用

## 快速开始

需要 Node.js 18+。

```bash
npm install
npm start          # 启动
npm run dist       # 打包 NSIS 安装包到 dist/
```

`npm start` 走的是 `scripts/start.js` 而不是直接 `electron`：Git Bash 等终端会把 `ELECTRON_RUN_AS_NODE=1` 注入子进程，让 Electron 退化成普通 Node.js 卡住。启动脚本会先清掉这个变量再 spawn。

## 主要功能

- 悬浮窗无边框、可拖拽；标题栏一键切换「始终置顶」
- 分组管理：右键重命名 / 删除 / 清空，分组与短语都可拖动重排，把短语拖到左侧分组即可换组
- 一键粘贴：点击 → 写剪贴板 → 自动 Ctrl+V
- 收藏 / 最近 / 使用计数；「最近」列表与使用计数都能在设置面板一键清空
- 实时模糊搜索，命中片段高亮
- 占位符：`{date}` `{time}` `{datetime}` `{weekday}` `{clipboard}`，编辑时实时预览；`\{xxx}` 反斜杠保留字面量
- 明暗主题、窗口透明度（60–100%）、粘贴时是否隐藏悬浮窗
- 侧栏可折叠（`Ctrl+B`）
- JSON 导入导出：整库替换 或按 ID 合并
- 单实例锁

## 快捷键

弹窗打开时只响应 `Esc` / `Ctrl+Enter`；焦点在输入框时只响应 `Ctrl` / `Alt` 组合键和 `Esc`，普通字符不会触发。

| 类别 | 快捷键 | 作用 |
|---|---|---|
| 全局 | `Ctrl+Shift+V` | 唤出 / 收起悬浮窗 |
| 列表 | `↑` / `↓` | 上下移动选中项 |
| 列表 | `1` ~ `9` | 粘贴当前可见顺序的前 9 条 |
| 列表 | `Enter` | 粘贴选中的短语 |
| 列表 | `Alt+↑` / `Alt+↓` | 调整顺序 |
| 过滤 | `g` / `f` / `r` | 切换 全部 / 收藏 / 最近 |
| 过滤 | `/` 或 `Ctrl+F` | 聚焦搜索框 |
| 过滤 | `Esc` | 清空搜索 / 关闭弹窗 / 隐藏窗口 |
| 操作 | `Ctrl+N` / `Ctrl+G` | 新建短语 / 新建分组 |
| 操作 | `Ctrl+B` | 折叠 / 展开分组栏 |
| 操作 | `Ctrl+,` | 打开设置 |
| 操作 | `Ctrl+Enter` | 保存短语编辑 |

## 占位符

| 标签 | 展开为 |
|---|---|
| `{date}` | 当前日期，如 `2026-09-11` |
| `{time}` | 当前时间，如 `14:32` |
| `{datetime}` | 日期 + 时间，如 `2026-09-11 14:32` |
| `{weekday}` | 中文星期，如 `周四` |
| `{clipboard}` | 当前剪贴板内容 |

含 `{clipboard}` 的短语粘贴时会先快照原剪贴板再覆盖，避免读到自身写出去的内容。

想教别人用占位符时，写成 `\{date}` 会保留成字面量 `{date}`，不会被展开。

## 数据存储

| 系统 | 路径 |
|---|---|
| Windows | `%APPDATA%\quick-paste\data.json` |
| macOS | `~/Library/Application Support/quick-paste/data.json` |
| Linux | `~/.config/quick-paste/data.json` |

设置面板 → 数据 → 「打开」一键定位。写盘采用「先写临时文件再 rename」的原子化策略，畸形 JSON 会自动尝试修复。

## 常见问题

**粘贴后窗口消失了？**
默认不会。走「隐藏 → 粘贴 → 重新显示」兜底有三种：识别不到目标窗口、开了「粘贴时隐藏悬浮窗」、目标窗口拒绝被拉到前台。200ms 后会自动回来，嫌慢改 `main.js` 的 `PASTE_RESTORE_DELAY_MS`。

**某些应用粘贴不上？**
部分 Electron / Chrome 内核应用为安全考虑忽略 SendKeys。普通应用都没问题。

**`Ctrl+Shift+V` 不起作用？**
可能被其它程序占用了。注册失败时主进程只会在终端打一行 warn，应用照常运行——改用托盘图标唤出即可。要换快捷键：设置面板 → 快捷键 → 录制。

**拖到副屏的窗口下次启动不见了？**
不会丢。启动时会按窗口中心点找最近的显示器，把窗口整体夹回该显示器的工作区；副屏拔掉 / 分辨率改了也能正常恢复。

**怎么完全退出？**
关闭按钮只隐藏到托盘。真正退出请右键托盘图标 → 退出。

## 项目结构

```
.
├── package.json
├── main.js                   # 主进程：窗口 / 托盘 / 模拟粘贴 / 单实例锁 / IPC
├── preload.js                # contextBridge 暴露 window.api
├── renderer/
│   ├── index.html
│   ├── styles.css
│   └── renderer.js
├── scripts/
│   └── start.js              # 清掉 ELECTRON_RUN_AS_NODE 后启动 Electron
├── icon.ico                  # 托盘 / 标题栏 / 安装包共用
├── .gitignore                # 忽略 node_modules/ 与 dist/
└── README.md
```

`npm run dist` 会用 `electron-builder` 走 NSIS 打包，产物落在 `dist/` 下（`快速粘贴 Setup x.y.z.exe` 安装包 + `win-unpacked/` 免安装目录），仓库已通过 `.gitignore` 忽略。

## 许可证

MIT
