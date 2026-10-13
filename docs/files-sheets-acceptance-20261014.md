# 表格与云端文件流程验收（进行中）

## 已部署
- 原私有站点：https://feishu-agenda-lab-20261006.andy-sg.chatgpt.site
- Sites source SHA: 50c004bef3b9229a73cd865029bf265af1669d13
- 部署：appgdep_6ace5d051ba88191a597c373310e6586，succeeded。
- 插件版本：1.2.0，pluginrel_6ace5ea2fec481919c7c1e6f6fe79d9b。
- 插件两个 manifest 语义回读一致，技能正文除平台尾部换行外一致；原 App 绑定和 PRIVATE 范围保留。

## 新能力
- create_spreadsheet、add_worksheet、write_sheet_cells：沿用预览、确认及回执机制；写后需 sheet_values 独立回读。
- download_file：云盘二进制与在线文档导出。
- download_message_attachment：先用户身份核查消息与资源关联，再使用原已在该会话中的机器人下载。
- download_folder：云盘文件夹递归、分页、目录结构、ZIP 清单，逐项失败明确可见。
- download_status、download_continue、download_retry：绑定原应用连接和授权；重试仅限失败文件。
- D1 保存加密任务、R2 保存加密分块；24 小时逻辑失效，物理回收随之后任务触发。
- 限制：10 MiB/文件、50 MiB/任务、200 项、10 层、10 个有效任务。只读下载不会改变飞书原文件。

## 自动化验证
- 293 项测试通过；TypeScript 检查及 Worker 打包检查通过。
- 20 项官方 Miniflare/workerd 检查通过，新增真实 D1/R2 的 300000 字节三分块加密存储及逐字节回读、跨所有者拒绝。
- 上述运行时使用合成上游响应，不等于真实飞书验收。

## 真实验收状态
- 首页确认本人陈元旭；CLI2 显示已授权 42 项，原应用 3 项。
- 新表格与文件页面可正常打开。
- 创建本人测试电子表格的预览被 insufficient_scope 拒绝，没有创建业务数据。
- CLI2 飞书授权页准备从 42 项更新为 45 项：增加 space:document:retrieve、sheets:spreadsheet:create、sheets:spreadsheet。
- 2026-10-14 已按浏览器即时确认要求提问，当前等待用户回答；尚未点击授权。
- 三条真实完整流程尚未验收，不得标记完成。未发送同事消息，未邀请同事，未添加机器人到同事群。
- 当前会话插件工具 schema 仍显示旧枚举；新功能先经站点页面验收，后续需刷新主机工具并验证聊天入口。

## 后续
1. 用户确认后完成 CLI2 授权。
2. 本人样本：创建表格、新工作表、写入矩形并独立回读。
3. 创建个人文件夹及子文件夹样本，验证二进制与导出文件的字节数、摘要、ZIP 目录和清单。
4. 在本人或现有机器人私聊内验证附件下载，不打扰同事；若上游不支持某类群聊文件夹，明确区分云盘目录与聊天专有容器。
5. 修复真实接口偏差，重新部署及补齐证据，再提交收尾 dry-run。尚无本任务合并授权。
