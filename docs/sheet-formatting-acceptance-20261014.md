# 表格格式操作与真实验收（2026-10-14）

## 交付

原私有站点 /files 和 MCP 增加 set_sheet_font_color、merge_sheet_cells、unmerge_sheet_cells、set_sheet_column_width。仍使用既有逐次预览确认、稳定 request_id、连接绑定和未知结果保护；不新增权限。页面合并方式使用中文选项，列号从 1 起、包含首尾。

- 字体颜色：严格 #RRGGBB，仅修改 foreColor。
- 合并：全区域、按行、按列；执行前读取 Formula 值，非保留锚点有内容（包括 0、false、公式、富文本）即拒绝。拆分操作不恢复历史丢失内容。
- 列宽：20–2000 像素，一次 1–100 列，使用官方 1-based inclusive 索引。
- 颜色与合并：单次至多 2000 单元格、500 行、100 列。
- 平台没有原子条件合并；检查到提交间不能防止其他人同时编辑，预览已提示避免并发编辑。

## 发布证据

- Site ID：appgprj_6ac497b352108191ba74b2e774acf605
- URL：https://feishu-agenda-lab-20261006.andy-sg.chatgpt.site/files
- 最终源码：f91ed0c549573667954a9404fd0c2128dea7d679
- version：appgprj_6ac497b352108191ba74b2e774acf605~appgver_a4d7a96b55808191872f7a3c45536e72
- deployment：appgdep_6ace6dd7e13481919c3982aaf8765598，succeeded，has_mcp=true，env revision 16。
- 插件 1.3.0，release pluginrel_6ace6cb350308191ac53e042410e66ec；manifest、App 绑定和 presentation 保留，技能与版本修改后回读一致。

## 自动化校验

298 项测试通过（新增 5 组格式/内容保护测试）；21 项官方 Miniflare/workerd D1/R2 检查通过，其中包含 4 个新增格式工具在实际 bundle 中注册；typecheck、check:package 通过。测试构建 1,078,555 字节。后两项 UI 文案和选择框修改后，298 项及 typecheck/package 再通过。

这些合成上游测试不替代下面的真实飞书验收。

## 真实飞书验收

仅使用本人此前创建的「飞书插件表格文件验收（2026-10-14）」；token QLPEsR6lhhZj2ltZshgc3E8vn4g，worksheet 2x9Rvy「云端验收」。不邀请协作者、不发消息、不改共享。

所有写入均在原云端站点生成预览，通过确认页按钮执行；未直接调用执行端点。connection 留空自动路由到 CLI2（cli_aa845773257a1bed），无需追加授权（现有 45 项）。

| 操作 | intent_id | 结果与独立核对 |
|---|---|---|
| A1:C1 字体 #D93025 | Ny36fjNppVLEtdmyFPKsvEdNA5OIiv6_55wXfxm8AUs | succeeded；updatedCells=3；实际飞书 UI 表头红色 |
| A–C 列 180px | Wwo7sCTUuCyIjxk9MLIdC2Vf43y4pGfVAcZumzzRpkw | succeeded；飞书 UI 100% 缩放下列边界分别为 x45/225/405/585 |
| D5:E5 合并 | cHXlZtCdv-pbCE_hmL2pS2YpMJmhP3b9xzGjTU1Ayf4 | succeeded；定位 D5 后实际选区覆盖 D:E，工具栏显示拆分单元格；截图 sheet-formatting.jpg |
| D5:E5 拆分 | 6_psRG22q1TaNE-Yho7K7f-OcI6TWy-ijUiIuM_kVDA | succeeded；刷新后定位 D5 仅选中 D 列，D/E 分界恢复 |

通过现有插件 query_feishu sheet_values 独立回读 A1:C3，revision=6、partial=false、9 个单元格仍为原始中文/数字/符号数据。行/列分别合并模式的请求形状与内容保护有单元测试，真实样本使用全区域合并。

保护逻辑真实验收：intent `uNr-RtTCXY3TVdt1Hp0CXapf4oBvtxfMaMXbpyojdRU` 尝试合并已有内容的 A1:C1，返回 failed / merge_would_discard_content，确认页显示已停止操作，截图 sheet-merge-protection.jpg；之后再次回读 9 格与 revision=6 均不变。

## 边界

当前主机会话工具清单含上一版创建/写入/下载工具，尚未出现本次 4 个格式工具；服务端 bundle 注册和已部署网页已验证，聊天宿主刷新后的新入口仍待补验收，不能宣称已在本次聊天直接调用成功。可先用原站 /files。

此前聊天原生文件夹、在线文档导出权限缺口仍见 files-sheets-acceptance-20261014.md，本次不将它们关闭。本任务尚未授权合并。

## 官方依据

- https://open.feishu.cn/document/server-docs/docs/sheets-v3/data-operation/batch-set-cell-style
- https://open.feishu.cn/document/server-docs/docs/sheets-v3/data-operation/merge-cells
- https://open.feishu.cn/document/server-docs/docs/sheets-v3/sheet-rowcol/update-rows-or-columns

官方页面已在浏览器读取完整请求/响应与列索引规则。
