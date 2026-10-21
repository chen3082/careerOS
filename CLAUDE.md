# CareerOS 接手入口

請先閱讀 [docs/CLAUDE_HANDOFF.md](docs/CLAUDE_HANDOFF.md)。其中包含使用者需求、2026-10-20 核對的版本／部署狀態、程式導覽、已驗收範圍、卡點與測試方式。

此電腦若有 `.private-handoff/CLAUDE_HANDOFF_PRIVATE.md`，優先閱讀該完整私密版。使用者已要求交接現有邀請碼與密鑰，實際值及環境檔副本放在該目錄；它被 Git 忽略，不在 GitHub 上。可用於使用者授權的 CareerOS 開發／登入／部署，不得輸出到一般 log 或提交 Git。

- 接手分支是 `feat/verified-browser-submission`；先確認當前狀態，不要覆蓋其他人的修改。
- 正式 Google 帳戶登入尚未驗收；LinkedIn／104 自動投遞尚未完成。共用職缺抓取已實作，個人雷達只完成設計。
- `SYSTEM_DESIGN.md`／`SYSTEM_CONTRACTS.md` 描述目標架構，實際契約以 migrations 與 code 為準。
- 測試不得連正式資料庫或寄虛構履歷給真實雇主。共享 GCP 主機的其他服務不得受影響。
- 密鑰、邀請碼、Cookie、真實履歷與私人聯絡資料不得加入 Git；詳細操作邊界見交接文件。
- 重要程式變更延續使用者要求的獨立 agent review，並分開回報模擬測試與真實外部流程的結果。

此入口是開發交接索引；新使用者指示及實際核對結果優先於歷史快照。
