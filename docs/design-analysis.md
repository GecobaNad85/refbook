# 划词查询工具书实现分析

> 对 `kns.cnki.net` 文献详情页"划词查工具书"功能的逆向分析（2026-06），是本项目扩展与桌面端 API 逻辑的依据来源。

## 1. 整体架构

| 项 | 值 |
|----|----|
| 核心文件 | `detail.js` |
| 关键对象 | `GLS`（Glossary Selection） |
| 弹窗容器 | 页面内空 `<div id="GLSearch"></div>` |
| 样式 | `layout3.css` |
| 检索接口 | `t.cnki.net/rbook-api`（跨子域，带 cookie） |

技术栈为 jQuery + 原生 DOM 事件 + Ajax POST + 内联 HTML 拼接；弹窗用 `position: absolute` 配合手动边界计算，无现代框架。

## 2. 前端实现

### 2.1 事件监听（GLS 对象）

- `mousedown` → 记录起始元素 `GLS.startObj`
- `dblclick` → 置 `GLS.isdb = true`（双击选词不触发划词）
- `mouseup` → 核心逻辑

### 2.2 划词检测流程（mouseup）

```
mouseup
  → 检查起始元素是否在允许区域（IsInChooseTag）
  → window.getSelection().toString() 取选中文本
  → 排除 INPUT、A 标签，排除双击
  → 文本非空 → GLS.search(text, event)
```

### 2.3 弹窗定位与渲染（GLS.search）

- 取鼠标 `clientX/clientY`，做视口边界碰撞检测后绝对定位（避免弹出屏幕外）
- API 返回后动态拼 HTML 插入 `#GLSearch`：

```html
<div class='visPop'>
  <p>
    <span>CNKI工具书</span>
    <a class='more' href='https://gongjushu.cnki.net/rbook/search/simplesearch?key=xxx'>
      查看更多释义
    </a>
  </p>
  <div class='nr-book-result'>
    <div class='result-gjs'><!-- 词目 + 释义摘要 + 来源工具书 --></div>
  </div>
</div>
```

### 2.4 关键样式（layout3.css）

| 类/ID | 样式要点 |
|-------|---------|
| `#GLSearch` | 白底、圆角 3px、阴影 `2px 2px 10px #999` |
| `.visPop` | 绝对定位、`z-index: 9001`、最大宽 500px |
| `.result-gjs` | 浅灰背景 `#F9F9F9` |
| `.subject` | 蓝色标签 `#2347FF`，浅蓝底 `#D0E3FF` |

### 2.5 交互细节

- 双击选词不触发（`GLS.isdb`）
- 输入框（INPUT）与链接（A）上划词不触发
- 可开关：`GLS.isallow()`，关闭后 alert"搜索已关闭"

## 3. 检索接口

### 3.1 基本信息

| 项目 | 值 |
|------|-----|
| 地址 | `POST https://t.cnki.net/rbook-api/v1/criteria/query?uniplatform=NRBOOK` |
| Content-Type | `application/json` |
| 跨域 | `withCredentials: true`（见 §4） |

### 3.2 请求体

```json
{
  "resource": "CROSSDB",
  "product": "TOTAL",
  "q": {
    "userScope": {
      "title": "", "logic": "AND",
      "items": [
        { "key": "", "title": "词目", "logic": "AND", "operator": "DEFAULT", "uf": "ET", "uv": "要查询的词" },
        { "key": "", "title": "词目", "logic": "AND", "operator": "DEFAULT", "uf": "LC", "uv": "Y" }
      ],
      "childItems": []
    },
    "groupScope": { "title": "", "logic": "AND", "items": [], "childItems": [] }
  },
  "extend": 0, "start": 1, "size": 3, "type": 0, "sort": "FFD", "sequence": "desc"
}
```

| 参数 | 含义 |
|------|------|
| `resource: "CROSSDB"` / `product: "TOTAL"` | 跨库检索 / 全部产品（固定值） |
| `items[0]` `uf: "ET"` + `uv` | **精确匹配词目**，`uv` 为查询词 |
| `items[1]` `uf: "LC"` + `uv: "Y"` | 限定资源类型为工具书 |
| `size` / `sort` | 返回条数（默认 3）/ 按相关度（`FFD`） |

### 3.3 响应结构

```json
{
  "code": 0,
  "data": {
    "total": 1,
    "data": [
      {
        "metadata": [ { "name": "TI", "value": "…" }, "…" ],
        "relations": [
          { "scope": "readonline", "url": "在线阅读链接（含会话 token）" },
          { "scope": "cover", "url": null }
        ]
      }
    ]
  }
}
```

### 3.4 metadata 字段速查

| 字段 | 含义 |
|------|------|
| `TI` | 词目（带 `<font color='red'>` 高亮，展示时需去标签） |
| `AB` | 摘要 / 释义正文 |
| `BTI` | 来源工具书名 |
| `ZJTI` / `ZJDM` | 专辑名称 / 代码 |
| `ZTTI` / `ZTDM` | 专题名称 / 代码 |
| `PT` | 出版时间 |
| `NOC` | 被引次数 |
| `VSM` | 高频关联词，`词:频次` 逗号分隔 |
| `FN` / `BID` / `TN` | 条目 ID / 工具书 ID / 工具书编号 |
| `MLC` / `COPR` | 中图分类 / 版权标识 |

### 3.5 调用示例

```javascript
fetch('https://t.cnki.net/rbook-api/v1/criteria/query?uniplatform=NRBOOK', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify(payload) // §3.2 的请求体
})
  .then(r => r.json())
  .then(res => {
    if (res.code === 0 && res.data.data.length > 0) {
      const md = name => res.data.data[0].metadata.find(m => m.name === name)?.value;
      console.log(md('TI'), md('AB'), md('BTI'));
    }
  });
```

## 4. 鉴权与跨域

### 4.1 `withCredentials` 的作用

接口域名 `t.cnki.net` 与页面域名（如 `kns.cnki.net`）非同子域，属跨域请求。`withCredentials: true` 让浏览器携带 `t.cnki.net` 的 cookie（登录态、机构权限）。

### 4.2 带 / 不带 cookie 的实测对比

实测（查询"meta分析"）两次响应**数据完全一致**（条数、metadata、摘要），唯一差异是 `relations` 中 `readonline` 链接的会话 token 不同。

结论：**查词本身不鉴权**。`withCredentials` 的意义在于：

1. 生成绑定用户会话的在线阅读链接（`bar.cnki.net/bar/download/order?id=…`），保证"查询→点击→阅读"链路可用
2. 后端用户行为追踪
3. 可能对未登录用户降级（限制条数），未直接观测到

后续动作（查看全文 `entry/detail`）才是真正鉴权的部分。

### 4.3 CORS 白名单

后端响应头：

```
Access-Control-Allow-Credentials: true
Access-Control-Allow-Origin: https://kns.cnki.net   （不能用 *）
```

只认 `*.cnki.net` 来源；`Access-Control-Allow-Origin: *` 时浏览器会拒绝携带 cookie。

## 5. 在何处能调用

| 场景 | 能否调用 |
|------|---------|
| `*.cnki.net` 页面控制台 | ✅ 直接调 |
| 自己网站的 JS | ❌ CORS 拦截 |
| 后端代理转发 | ✅ 绕过 CORS |
| 浏览器插件（声明 `*.cnki.net` 权限） | ✅ background 不受 CORS 限制 |
| curl / Postman 等非浏览器环境 | ✅ 无 CORS |
| `--disable-web-security` 启动的浏览器 | ✅ 仅临时调试 |

非浏览器/扩展环境直接 POST 即可：

```bash
curl -X POST 'https://t.cnki.net/rbook-api/v1/criteria/query?uniplatform=NRBOOK' \
  -H 'Content-Type: application/json' \
  -d '{…§3.2 请求体…}'
```

本项目采用的绕过方式是**浏览器扩展 background**（不受页面 CORS 约束）与**桌面端直接 HTTP 请求**（无浏览器沙箱）。

## 6. 结论

经典的"划词 → 浮窗释义"模式：`mousedown` 记起点 → `mouseup` 取选区 → 区域过滤 → POST 检索接口 → 渲染浮窗。要点：

- 接口为精确词目匹配（`ET`）+ 工具书限定（`LC=Y`），默认返回 3 条
- 查询不强制登录，全文/在线阅读等后续动作才需要登录态
- 接口有 CORS 白名单（仅 `*.cnki.net`），外部调用需扩展、代理或非浏览器环境
