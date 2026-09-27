# 帳戶協助流程獨立 review

日期：2026-09-19。範圍：`010_account_setup.sql`、API/MCP、網站帳戶準備與個資匯出。

獨立 agent 以實際 Chromium 和 MCP SDK 複核，最終未發現新的 blocker。發現並修正：

1. 跨分頁撤回註冊授權後，舊元件可能提交隱藏的過期 `allowRegistration=true`。元件依 `id:version` 重建，所有可重新授權的狀態都明示勾選框；獨立 Chrome 回歸確認重授權仍為 false。
2. 帳戶進度列表缺少自動更新。加入既有 10 秒 polling；關閉對話框重新載入列表。
3. 把 strict Zod schema 拆成 `.shape` 時，MCP SDK 會先移除未知欄位再執行 callback。改傳完整 strict schema，SDK 獨立測試確認額外秘密欄位遭拒且 callback 不執行。
4. 個資匯出 `SELECT *` 會包含活躍 `claim_id`。匯出剔除此 capability，避免落入下載檔。
5. 移除「不會重複建立帳戶」保證。外部 agent 不具備原子註冊 gate，恢復時必須先查帳戶是否已存在。

Owner 鎖定、claim/version、防重領取、取消/續接、TTL、精確 origin 和 Workday tenant 界線未發現新的 blocker。

本 review 不等於真實雇主網站註冊或 LinkedIn／104 投遞驗收；系統提供的是網站與使用者瀏覽器助理之間的協作協定。雲端瀏覽器代管與第三方專用 adapter 尚未啟用。
