# 工具书查词 · 桌面版（Electron 原型）

CNKI 工具书划词查询的桌面端原型，参考 [nextai-translator](https://github.com/nextai-translator/nextai-translator) 的桌面架构思路实现。

## 功能

- **主窗口**：手动输入词目查询，展示词条列表 + 完整释义
- **全局划词**：选中任意文字 → 按 `Ctrl+Shift+D` → 弹窗显示查询结果
- 复用浏览器扩展的 CNKI 查询逻辑（`searchRefbook` / `fetchEntryDetail`）

## 架构

```
electron/
  main.js        主进程：窗口管理、全局快捷键、选区捕获、IPC
  preload.js     contextBridge 安全桥
  cnki.js        CNKI API 查询逻辑（从 server.js 移植，纯异步函数）
renderer/
  main.html/js   主窗口（手动查词）
  popup.html/js  弹窗（划词结果）
  style.css      共享样式
```

- **查询**：渲染进程通过 `window.cnki.search/detail` IPC 调主进程，主进程用 `fetch` 直接请求 `t.cnki.net`（无浏览器 CORS/CSP 限制）
- **选区捕获**：`Ctrl+Shift+D` 触发，读取系统 PRIMARY 选区（Linux 选中即复制）或剪贴板回退
- **弹窗**：无框置顶小窗，失焦自动隐藏

## 运行

```bash
cd refbook-desktop
npm install      # 首次安装 Electron
npm start        # 启动
```

## 说明

- 搜索接口无需登录即返回词目、释义摘要、来源、被引等
- 完整释义正文（`/entry/detail`）通常需要机构内网或登录态
- Linux 选区捕获依赖 X11 PRIMARY selection；其他平台回退到剪贴板
- 原 `server.js`（Node HTTP 服务版）保留作对照，已被 `electron/cnki.js` 取代
