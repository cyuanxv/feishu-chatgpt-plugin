# 飞书工作台 Sites 适配器：0.1.0-sites.22

原规划 30 个工具（17 读、13 写）与会议室预订已接入现有私有 Sites 站点。所有写工具只生成预览，经过确认页才执行；源码默认关闭写入，现有私有部署已启用。文档和任务共六类写入在批准样本上真实成功，其他写入与实际订房仍需专项验收。详情见 [逐项进度](docs/FULL-PLAN-PROGRESS.md)。

运行于 Sites / Cloudflare Workers 和 D1，不依赖本机 stdio、隧道或个人电脑常驻。历史快照目录名保留以兼容既有工具；下方 OAuth 安全约束继续适用。

## Included implementation

- Sites-authenticated principal boundary, exact-origin checks and owner-scoped storage
- Native form POST, expiring encrypted CSRF, atomic single-use form claim, fixed server HTTP303 handoff, state and Secure/HttpOnly/SameSite cookie binding
- S256 PKCE, encrypted pending bindings, one-use callback consumption, bounded provider diagnostics and safe error receipts
- AES-GCM credentials, grant/epoch fencing, single-winner refresh lease and fail-closed uncertain redemption
- Bounded calendar traversal, recurring instances, explicit partial coverage and continuations
- Synthetic mode that blocks real OAuth and provider transport
- D1 schema/migrations, build scripts, locked dependencies and synthetic unit/workerd/HTTP/served-script tests

Only the connection homepage uses `Referrer-Policy: same-origin`; redirects and callback/error pages retain `no-referrer`. Opaque, absent and foreign Origin values remain rejected. PKCE, state, browser binding, encryption, and one-use callback protections remain enabled. No fallback silently removes PKCE.

## Run the synthetic checks

Run from **this directory**, using Node.js 24:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix runtime-check
npm run typecheck
npm test
npm run check:source
npm run check:package
npm run check:workerd
npm run check:oauth-wire
npm run check:form-http
```

Tests use disposable synthetic databases and intercept provider calls. They need no real app credentials or account data. Generated builds, test databases, runtime reports and installed dependencies are excluded. HTTP and VM checks are not real-browser or live-account acceptance.

## Configuration and handoff

The hosting manifest contains only logical D1/MCP configuration, without a registered project ID. No deployment audience, app ID, Site URL, user identity, runtime key, grant, database contents, request log or private Git history is included.

See [handoff](docs/HANDOFF.md), [security](docs/SECURITY.md), [contracts](docs/CONTRACTS.md) and [validation](docs/VALIDATION.md). `SNAPSHOT-MANIFEST.sha256` 属于历史导出记录，不覆盖本分支新增文件；当前文件范围由 `check:source --list` 校验。

This preservation branch requires separate integration review and normal repository CI before any merge or deployment. Publishing source does not activate the adapter or provision a Site. MIT attribution is preserved.



## 当前配置与运维

通用读取由 FEISHU_DOCX_ENABLED 开启，写入预览和确认执行由 FEISHU_WRITE_ENABLED 开启；它们都不会自动授予飞书权限。应用按实际授权和同账户连接选择。完整写入/会议室规则见 [工作流](docs/WORKFLOWS.md)，开关、巡检与待完成部署验证见 [运维说明](docs/OPERATIONS-FULL-PLAN.md)。

复制源码后按锁文件安装并构建只证明可重建；创建新云端站点、D1、加密密钥、飞书应用回调及真实登录，均需要在新环境独立验收，不能借用旧站点验收结果。
