# 工具书查词 · 桌面版（refbook-tauri）

CNKI 工具书划词查询的 Tauri v2 桌面版。选中任意文字按 **Ctrl+Alt+D**，自动唤起窗口查询 CNKI 工具书总库的释义；支持智能分词检索、繁简体兜底、多标签结果切换、条目全文查看。

与浏览器扩展（`extension/`）共用同一套 CNKI API 逻辑，Rust 实现（`src-tauri/src/cnki.rs`），无前端构建步骤。

## 功能

- **全局划词查询**：Ctrl+Alt+D 读取系统选区（Wayland 优先 `wl-paste --primary`，回退 X11 PRIMARY、剪贴板），唤起主窗口自动查询。
- **分词检索**：整词未命中时，用 SegmentIt 智能分词（CDN 加载，带 POS 过滤）并行查询各词段，贪心选取互不重叠的命中词段，横向标签切换展示；SegmentIt 加载失败回退滑动窗口分词。
- **繁简兜底**：原文（繁体）链无结果时，OpenCC 转简体后再查一遍。
- **查看全文**：经内置 CNKI 鉴权 webview 带 cookie 调 `entry/detail` API（并发 `content/preview/download` 三 scope），获取完整释文。
- **来源链接中转**：条目原文页（`bar.cnki.net`）校验 Referer，桌面端经内置 webview 打开 `gongjushu.cnki.net` 中转页，注入脚本读 `#cnki_redirect` 跳转，Referer 合法。
- **系统托盘 + 悬浮图标**：托盘菜单（显示主窗口 / 划词查询 / CNKI 登录 / 悬浮图标开关 / 退出）；主窗口关闭时显示悬浮图标入口，点击唤起主窗口，可拖动并记忆位置（Wayland+KDE 下经 KWin 窗口规则定位）。
- **CNKI 登录管理**：托盘登录项动态文字（已登录显示"已登录（用户名/机构）"）；已登录点击可查看身份、退出登录或重新登录（真正清除 HttpOnly 会话 cookie）。
- **主题系统**：浅色 / 深色 / 跟随系统三档，主窗口页脚切换，跨窗口（主窗口/弹窗）同步，偏好持久化。
- **窗口尺寸记忆**：手动调整主窗口大小后自动记住，下次启动恢复（保持居中，最大化状态不覆盖已记尺寸）。
- **提示弹窗失焦自关**：划词提示弹窗失焦后自动关闭（启动后延迟武装，避免误关）。
- **自绘标题栏**：主窗口 `decorations: false`，自定义最小化/最大化·还原/关闭按钮（规避 Linux 原生标题栏按钮失灵）。

## 目录结构

```
refbook-tauri/
├── src/                    # 前端（无构建，原生 HTML/CSS/JS）
│   ├── index.html          # 主窗口 + 提示弹窗
│   ├── main.js             # 前端逻辑（查询链、分词、标签、窗口控制）
│   ├── popup.html          # 划词提示弹窗
│   ├── float.html          # 悬浮图标
│   ├── styles.css
│   └── assets/             # 图标等静态资源
└── src-tauri/
    ├── src/
    │   ├── lib.rs          # 主入口：窗口/托盘/悬浮图标/快捷键/选区读取/鉴权
    │   ├── cnki.rs         # CNKI API（搜索、条目详情、ping）
    │   └── main.rs
    ├── icons/              # 应用图标（由 crfd.svg 生成）
    ├── capabilities/       # Tauri 权限配置
    ├── Cargo.toml
    └── tauri.conf.json
```

## 开发环境

- Rust（stable）
- Node.js 24 + pnpm 9
- Linux：`libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libx11-dev libxdo-dev libxcb-shape0-dev libxcb-xfixes0-dev`
- Wayland 会话需安装 `wl-clipboard`（读 PRIMARY 选区）

## 本地开发

```bash
cd refbook-tauri
pnpm install
pnpm tauri dev
```

## 构建

```bash
cd refbook-tauri
pnpm tauri build            # 产出当前平台安装包
pnpm tauri build --bundles deb appimage   # Linux 指定格式
```

产物位于 `src-tauri/target/release/bundle/`。

## CI

- `.github/workflows/test-build.yml`：push `main` 时构建三平台安装包并上传 artifacts（不发布）。
- `.github/workflows/release.yml`：打 `v*` tag 时构建并发布 GitHub Release。

Rust 构建缓存：`swatinem/rust-cache@v2`（按 `Cargo.lock` 哈希缓存 `target`）。

## 使用说明

1. 首次使用：托盘菜单 → **CNKI 登录…**，在弹出的 CNKI 窗口登录一次（cookie 持久化到 webview cookie 罐，之后查看全文自动带 cookie）。
2. 划词：选中文字 → Ctrl+Alt+D → 主窗口自动查询。
3. 关闭主窗口 → 隐藏到托盘，显示悬浮图标入口；点悬浮图标或托盘恢复。
4. 查看全文需登录态（机构内网或个人 CNKI 账号），未登录时释文区会提示"点此登录 CNKI"。

## 已知限制

- **Wayland 下窗口位置**：Wayland 协议禁止客户端定位 toplevel；KDE/KWin 下已通过 KWin 窗口规则（`kwinrulesrc`）解决悬浮图标定位，GNOME/mutter 下悬浮图标初始位置仍可能不生效（X11 正常）。
- **无原生窗口边框**：主窗口去掉原生装饰后，边缘拖拽缩放可能失效（自绘标题栏的代价）。
- **全文获取依赖登录态**：`invoice`/`nonce` 或 cookie 缺失时 `entry/detail` API 返回 403。
