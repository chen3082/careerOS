# 交付與驗收紀錄

日期：2026-09-19 UTC。發布範圍為邀請制首版；完整目標功能與剩餘工作請分別看 SYSTEM_DESIGN 和 TODO。

網站：<https://gptig.allenchencode.com/careeros/>。MCP：<https://gptig.allenchencode.com/careeros/mcp>。程式庫：<https://github.com/chen3082/careerOS>。

| 驗證 | 結果 |
|---|---|
| TypeScript／Vite production build | 通過 |
| 加密／idempotency／備份 unit tests | 4 項通過 |
| 專用 PostgreSQL 整合測試 | 11 項通過，未使用正式資料 |
| 官方 MCP SDK | 真實 HTTP PKCE、scope、一次性 code、refresh reuse、讀写工具界線通過 |
| 文件 | PDF、DOCX、Markdown 含聯絡 email；兩次下載 PDF／DOCX 位元相同；跨帳號下載拒絕 |
| Chromium UI | 註冊→經驗→履歷確認→PDF→匯入職缺→申請草稿；1440×1050 桌面、390×844 手機；無 page error |
| 背景 worker | 真實佇列的中文字型 PDF 解析與台灣職缺搜尋均 succeeded；原解析器記憶體問題已修正 |
| GitHub CI | build、unit、PostgreSQL 整合、瀏覽器與 dependency audit 通過；另納入 PDF worker 回歸 |
| 獨立 agent | 7 項具體 finding 已修正；切換有資料頁面及 A→B 帳戶的隔離回歸獨立通過 |
| 台灣公開職缺 | Lever Gogolook 實際取得 11 份台灣職缺（當次來源共 12 份） |
| 美國公開職缺 | Greenhouse Figma 的 engineer 搜尋實際取得 74 份美國職缺（當次來源共 152 份） |
| 本機恢復 | 加密 DB／附件還原到獨立 DB；附件 SHA-256 相符；新刪除 ledger 重播後被刪帳號未復活 |
| 大檔備份 | 520 MiB 加解密，128 MiB JS heap、磁碟 scratch，內容 hash 一致 |
| 套件 audit | 0 已知弱點（驗證當時） |
| GCP | 網站 health／HTTPS／MCP discovery 200；私人 PostgreSQL；原有 habit 服務保持運作 |
| 備份排程 | 每日 UTC 03:20 加隨機延遲；加密本機保存七天，首次執行成功 |

職缺筆數為當次測試結果，不是保證未來數量或市場覆蓋。測試職缺只保存到隔離測試帳戶；正式資料庫沒有植入示範履歷、offer 或假投遞。

未實測：真實 Anthropic／OpenAI BYOK、Google 使用者授權、Claude 網站自訂 connector UI、真正對外送出履歷。前者需要使用者／營運者連接；自動投遞與跨主機恢復仍受 TODO 中的工程門檻限制，不能宣稱完整 production-ready。

第一次使用需要建立管理員；私人開通連結只保存在擁有者電腦上的交付文件，不放進 repository。請先建立經驗、確認履歷，再邀請小組成員。
