# 表格与云端文件流程验收（进行中）

## 已部署
- 原私有站点：https://feishu-agenda-lab-20261006.andy-sg.chatgpt.site
- Sites source SHA: 1ae56f9e0eb97900e0a75f1606340f2e6e489757
- 部署：appgdep_6ace6273fa6c8191b7b909f7a1deb8c2，succeeded。
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
- 21 项官方 Miniflare/workerd 检查通过，新增真实 D1/R2 的 300000 字节三分块加密存储及逐字节回读、跨所有者拒绝。
- 上述运行时使用合成上游响应，不等于真实飞书验收。

## 真实验收状态
- CLI2 由 42 项更新为 45 项；用户在最终授权步骤明确确认，站点回读已生效。
- 创建表格 QLPEsR6lhhZj2ltZshgc3E8vn4g，新增工作表 2x9Rvy（云端验收）。
- 预览确认后写入 A1:C3 共 9 格，独立 sheet_values 回读全部一致，revision=2。中文、数字文本、符号均一致。
- 云盘原始文件 E6MEbZX4wo9GGSx1N59cC6nKnmO：307200 字节，云端下载并取回后逐字节一致。
- 消息附件：仅发送合成文件到本人和已有 CLI2 的单聊；message_id=om_x100b63d2568b2ca4b05d0e53a257522。云端消息归属验证后下载成功，取回 307200 字节，与原始样本一致。
- 二进制 SHA-256：a7d8881521cbb1e4a5ca960198c7907b45625b39d3a7a86368fc8b4ecad01014。
- 云盘根目录 K8fjfoUZPlBrIrdb3TNchOgAn0d；子目录 FAgmfDsJOl033edpaD8cI5UjnkY；本人所有，无协作者。
- 最终部署递归任务 6K06Wo6lEEYm7xVULKMX5KsxbwfbjubLLg6cAuH6WAw：两次步骤完成，2 文件共 307291 字节，pending=0、partial=false。
- 最终 ZIP 可解压、CRC 全通过；包含根目录文本、子目录二进制、目录条目和清单；扩展名保留；文本和二进制与原件逐字节一致。
- 不带身份访问私人下载链接返回 403，不返回 ZIP。
- 未向同事发消息、未添加机器人到同事群、未邀请协作者；保留样本与验收记录，没有删除飞书业务数据。

## 真实验收发现并修复
- 首次打包存在 cloud-files ↔ readonly 的初始化循环，新下载操作未注册。抽出 read-failure 模块，新增打包后 MCP schema 枚举检查，修复后已重新部署并真实下载成功。
- 目录文件名去重后缀原来置于扩展名之后；修复为扩展名之前，并保留目录条目。最终 ZIP 再次真实验收通过。
- 新增界面切换操作时清空旧结果，避免将前一次下载回执误认为本次结果；写入预览“多维表格标识”改为通用“表格标识”。

## 尚未完成的边界
- 聊天中直接发送的原生文件夹不是云盘 folder_token；当前 download_folder 只处理云盘目录。本次不把云盘目录成功等同于聊天原生文件夹支持。
- 本人机器人单聊中的原生文件夹样本选择器“选择”持续禁用；独立临时路径对照仍禁用，已取消且未上传。不将其推断为飞书永久不支持。
- 在线表格导出尝试返回 resource_access_denied；CLI2 本次授权列表未包含 drive:export:readonly。尚未区分全部资源/应用权限原因，不能宣称在线文档导出已通过。
- 当前宿主会话仍缓存旧工具 schema；新站点打包产物的 MCP schema 已验证包含 download_file/download_folder，但聊天工具刷新后的端到端调用尚待验证。
- 群消息附件真实样本使用已有本人机器人私聊；对真实同事群的适用条件仍是机器人原已在群内及具备资源权限，未对同事群做写入验收。

## 交付与后续
- 主体源码、测试与插件发布包已保留任务分支；尚未合并，不能把私有部署当成 Git 合并。
- 表格、消息附件、云盘目录三个已实现流程通过；按用户最初所指聊天原生文件夹的广义需求，任务仍有缺口。
- 下一步需独立打通聊天原生文件夹的公开接口/资源模型及云端路径，核对导出权限；不得用本机下载替代云端功能，也不把桌面端功能推断为开放 API 能力。
