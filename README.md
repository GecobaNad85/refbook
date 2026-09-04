# CNKI 工具书划词查询

在任意网页划词,即时查询 CNKI 工具书词条释义。本仓库包含浏览器扩展(核心)及两个桌面端原型。

## 目录结构

```
.
├── extension/          # Chrome 扩展 (Manifest V3) —— 核心项目
│   ├── background.js   # Service worker:API 调用、凭据管理、缓存
│   ├── content.js      # 内容脚本:UI、事件、分词/繁简转换
│   ├── sandbox.html    # 分词 + 繁→简 iframe (SegmentIt / OpenCC)
│   ├── help.html       # 帮助页
│   ├── popup.css       # 弹窗样式
│   ├── manifest.json
│   └── icons/          # 扩展实际使用的图标
│
├── refbook-desktop/   # 桌面端原型 (Electron):主窗口 + 全局划词
├── refbook-tauri/     # 桌面端原型 (Tauri):见其 README
│
├── .github/workflows/  # CI:三平台安装包构建与发布
├── icons/              # 图标设计源文件 (icon-source.png 等,非运行时)
├── docs/               # 设计与分析文档
│   ├── design-analysis.md            # 划词查询工具实现分析
│   └── traditional-chinese-fallback.md  # 繁体字查询实现思路分析
├── CLAUDE.md           # Claude Code 项目指引
└── README.md
```

## 快速开始(扩展)

1. 打开 `chrome://extensions`,开启开发者模式。
2. "加载已解压的扩展程序",选择 `extension/` 目录。
3. 改动 `background.js` 后需在扩展页点 "Service Worker" 重载;改动 `content.js` 后刷新页面。

> 完整词条全文需要 CNKI 登录凭据(`invoice`/`nonce`):先访问 `gongjushu.cnki.net` 并登录,扩展会自动捕获。详见 `CLAUDE.md`。

## 桌面端

- **Electron**:`cd refbook-desktop && npm install && npm start`(见其 README)
- **Tauri**:`cd refbook-tauri`(见其 README)

## 构建与发布 (GitHub Actions)

`.github/workflows/` 提供三平台安装包 CI,主要针对 **Tauri** 桌面版:

| 工作流 | 触发 | 产物 |
|--------|------|------|
| `test-build.yml` | 手动运行,或 `main` 分支推送 | 三平台构建物上传为 workflow artifacts(不打 Release) |
| `release.yml` | 打 tag `v*`(如 `v0.2.0`) | 三平台安装包发布到 GitHub Release,并同步版本号 |

三平台产物:

- **Windows**(`windows-latest`)— NSIS `.exe` + MSI `.msi`
- **macOS**(`macos-latest`)— 通用二进制 `.dmg`(x86_64 + arm64 双架构)
- **Debian/Ubuntu**(`ubuntu-22.04`)— `.deb` + `.AppImage`

使用方式:

```bash
# 手动跑一次构建,到 Actions 页下载 artifacts
# 或打 tag 触发发布
git tag v0.2.0 && git push origin v0.2.0
```

发布时工作流会自动把 `refbook-tauri/src-tauri/tauri.conf.json`、`package.json`、`Cargo.toml` 的版本号同步为 tag 版本(去掉前导 `v`)。

## 备注

- `icons/` 为设计源文件,`extension/icons/` 为扩展运行时实际引用的图标。
