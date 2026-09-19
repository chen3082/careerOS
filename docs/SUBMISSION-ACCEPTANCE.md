# 實際傳送與收件驗收的範圍

本次新增 submission run、不可變 dossier、一次性授權、PDF bytes 校驗、送出前審閱、結果未知防重送，以及獨立 HTTP receiver 驗收程式。**這仍不是可用的 LinkedIn／104 正式投遞 adapter。** 正式環境沒有注入測試引擎，`SUBMISSIONS_ENABLED=false` 仍強制執行。

先前 MCP E2E 驗证了建立履歷、申請草稿、手動紀錄與狀態流程，沒有測到對外提交。不能把那些結果當作完整投遞驗收。

## 這次測什麼

`tests/submission-e2e.ts` 使用 MCP 建立三份虛構素材與履歷，使用者確認後產生正式 PDF，再透過 CareerOS 網頁的審閱與授權介面送出。瀏覽器處理隔離表單並傳送真正的 multipart HTTP request。

`tests/submission-receiver.ts` 是另一個 Node 程序。它實際接收 PDF，將檔案與 receipt 同步寫入磁碟；sender 沒有透過改資料庫來冒充收件。測試核對接收 PDF 的 SHA-256、解析出的履歷文字，以及應用中的回條和 submitted event。

另測：收件後刻意斷線、禁止重投、另一個 Node 程序重開 journal、模擬 DB 回退、兩個執行器爭同一個 permit、跨使用者、過期授權後取消、同職缺不同 URL、PDF 同檔名換內容、表單目的地／帳戶／hidden field 改變，以及 permit 等待與 submit event 期間的變更。

原生 browser route 對重新導向鏈的攔截不足以保護 PDF。提交請求使用 `route.fetch({maxRedirects:0,maxRetries:0})` 發出一次真實 HTTP request，拒絕 3xx，將原始回應交回頁面。307／308 測試使用第二個 localhost receiver，要求它收到零筆請求。

測試程式的 fixture origin 只允許 `NODE_ENV=test` 與 `127.0.0.1`；GCP 測試另外使用沒有對外連線的 disposable Docker network，不掛載正式環境或資料。Receiver 和 journal 中只有假資料。

## 不能由此推論的能力

- 沒有證明任何真實雇主收到申請，或 LinkedIn／104 登入、履歷選取與回條適配已完成。
- 本機 journal 的另一程序與模擬 DB 回退，不等於整台機器故障、跨主機備份還原或地區災難恢復演練。
- 沒有自動替使用者註冊公司帳戶；接手流程與門檻見 [APPLICATION_ACCOUNTS.md](APPLICATION_ACCOUNTS.md)。
- review agent 提出表單變更、目的地、redirect、到期取消和測試敘述問題，已据此修正；最終獨立複驗因 agent 用量上限中斷，不能寫成獨立 review 全數通過。

## 執行

已設定專用 `*_test` PostgreSQL、測試環境和 Chromium 時，先 build、migrate，再執行 `node --import tsx tests/submission-e2e.ts`。GCP 用 `sudo env CAREEROS_E2E_SCENARIO=submissions CAREEROS_E2E_IMAGE=careeros:submissions-qa bash scripts/test-mcp-e2e.sh`；該 wrapper 驗證既有服務未改變並清理測試容器和網路。實際結果以該次 `report.json`、receiver 檔案及 isolation report 為準。
