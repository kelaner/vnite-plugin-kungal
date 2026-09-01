# vnite-plugin-kungal

基于 **鲲 Galgame 生态**（[kun-galgame-infra](https://github.com/KunMoe/kun-galgame-infra)）galgame-wiki 数据的 Vnite 刮削器插件，对接 **NextMoe Public API v2**（catalog 服务）。

## 功能

| Vnite 接口 | 数据源端点 |
|---|---|
| 搜索游戏 | `GET /v2/catalog/search?object=work` |
| 元数据（名称/简介/发行/厂商/标签/评分） | `GET /v2/catalog/works/{id}?include=intros,releases,ratings,tags,companies,links` |
| 封面 | `GET /v2/catalog/works/{id}/covers`（竖版封面优先） |
| 背景/截图 | `GET /v2/catalog/works/{id}/screenshots`（回落 banner） |

- 名称按 `localized[locale] ?? display_name` 契约取值（首选语言可配置，默认简体中文、回退日文原名）
- 简介同语言内优先人工翻译，机翻行仅作兜底
- 评分保持源原生刻度（VNDB 1-10 / Bangumi 0-10 / DLsite 0-5 / Erogamescape 0-100），写入 `extra`
- 发行日期取最早 release 日期（月精度日期 `YYYY-MM-00` 自动归一为 `01`）

## 前置条件：申请 API Key

1. 打开 [developer.nextmoe.dev](https://developer.nextmoe.dev)（NextMoe 开发者门户）
2. 注册账号 → 创建应用 → 在控制台**自助铸造**应用密钥 `nmk_live_xxx`（无需审批）
3. 密钥 scope 勾选 **`catalog:read`**
4. 把密钥填入 Vnite 插件设置（**API Key** 配置项）

## 构建与安装

```bash
npm install          # 安装 typescript
npm run build        # tsc 编译 -> dist/index.js
npm run pack         # 打包 -> dist/kungal-catalog-<version>.vnpkg
```

在 Vnite「插件」页导入生成的 `.vnpkg` 即可安装；启用后在刮削器数据源中选择 **KunGalgame（鲲 Galgame 目录）**。

## 配置项

| 配置 | 说明 | 默认 |
|---|---|---|
| API Key | `nmk_` 开头的应用密钥，必填 | — |
| API Base URL | 公开 API 根地址 | `https://api.nextmoe.dev/v2` |
| 首选语言 | `zh-Hans`（简中优先）/ `ja`（日文原名） | `zh-Hans` |
| 包含 R18 作品 | 关闭后 R18 作品不可见 | 开 |

## 限流说明

NextMoe Public API v2 对每把 key 限流：**60 次/分**、**50,000 次/日**（Redis 滑动窗口，429 响应带 `Retry-After` / `X-RateLimit-*` / `X-Quota-*` 头）。插件内置三层处理：

1. **本地节流**：滑动窗口 60 秒内最多 55 次请求（留余量），超限会提示"请求过于频繁，请 N 秒后重试"，避免自我触发服务端限流
2. **429 自动重试**：服务端返回 `Retry-After ≤ 15s` 时自动等待后重试一次，用户无感
3. **明确提示**：日配额用尽提示"今日配额已用尽，请明日再试"；分钟限流提示具体等待秒数

批量刮削（批量添加、批量更新元数据）请求量大，触发限流属正常现象，稍后重试或分批操作即可。

## 发布到 Vnite 插件市场

1. 将本仓库推送到 GitHub，并给仓库打 **`vnite-plugin`** 标签（Vnite 内置的 GitHub Registry 通过该标签检索）
2. 在 GitHub Release 中附上 `.vnpkg` 产物（版本更新依赖 Release 资产）

## 开发说明

- 类型声明 `src/types.ts` 摘自官方 [vnite-plugin-sdk](https://github.com/ximu3/vnite-plugin-sdk)（仅保留本插件使用面）；如需完整类型可 `npm i -D vnite-plugin-sdk`
- 插件运行时零依赖（仅使用 Node 内置 `fetch`），`dist/` 即完整产物
- 相关契约：[catalog v2-openapi.yaml](https://github.com/KunMoe/kun-galgame-infra/blob/main/docs/catalog/v2-openapi.yaml)
