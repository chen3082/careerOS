# 手動補登已投遞

在「投遞中心」按「＋ 手動新增已投遞」，填入公司、職位、市場與實際投遞時間；管道、職缺網址與備註可選填。不必預先建立經驗、履歷或保存職缺。

履歷可選擇當時使用的站內版本、附上私人 PDF／DOCX（最多 20 MiB），或只填外部履歷名稱；也可以先不指定。補登後會加入總覽與投遞中心，可沿用既有流程更新面試與 offer。所有紀錄標示本人補登，不宣稱系統取得了外部送件回條。

## 資料與安全邊界

- `POST /api/applications/manual` 只接受網站 session，套用 same-origin／CSRF 檢查。MCP 保持提案與網站確認分權，沒有新增可直接宣稱已投遞的 MCP tool。
- JSON 可引用本人履歷／既有私人附件；新檔案用 multipart `metadata` JSON 加 `file`，最多一個檔案及一個欄位。拒絕同時指定站內及外部履歷，拒絕其他帳號的資源。
- 新附件、職缺、申請、submitted 事件、不可變歷史快照及 idempotency 結果共用一筆 PostgreSQL transaction。相同 key/內容重試回傳原結果；檔案內容 hash 參與比對，不重寫附件。
- 一般驗證、重複或職缺衝突造成交易失敗時，回滾資料列並刪除新加密檔。清理前另起 transaction，先鎖同一 owner 等原交易結束，再查主資料庫，避免 COMMIT 回覆不明時誤刪已成功提交的附件。如果資料庫／儲存不可用，保留檔案並記錄清理錯誤；這不是跨 filesystem／DB 的分散式原子交易，程序突然終止仍可能留下未引用檔案，需營運清理，不應直接刪除引用中的檔案。
- 附件沿用 owner 綁定的加密及私人下載，快照只保存名稱／類型／大小／SHA-256，不曝露 storage key。不上傳至 AI，也不自動匯入經驗或觸發解析任務。只做類型、大小與檔頭檢查，並非防毒掃描。
- 以 owner 鎖序列化申請去重；無網址職缺的身分包含市場。重用既有職缺時不覆寫描述，網址對應的公司／職位／市場不同則拒絕。
- 投遞時間由瀏覽器當地時間轉成 UTC 儲存，拒絕未來時間（容許 60 秒時鐘差）。補登不會將既有面試／offer 狀態降回已投遞。
- 表單與 action 綁定登入世代；登出／換帳號後，先前非同步履歷查詢不能再打開舊表單。歷史紀錄允許無站內履歷，詳情頁不會因空快照失敗。

Migration：`006_manual_applications.sql` 增加 external resume、履歷標籤及管道欄位，含 owner 複合外鍵與互斥約束，DDL 等鎖上限五秒。既有紀錄不需要資料回填。

## 可重現驗證

```bash
npm run build
npm test
# 一般 CI：專用 *_test PostgreSQL；不得指向正式 DB
npm run test:integration
# GCP/Linux Docker：使用新 PostgreSQL 容器、internal network、隨機測試密鑰、tmpfs
sudo env CAREEROS_E2E_SCENARIO=manual CAREEROS_E2E_IMAGE=careeros:manual-candidate bash scripts/test-mcp-e2e.sh
```

`tests/integration/product.test.ts` 覆蓋空經驗直接補登、不可變快照、站內履歷、附件私密性、附件回滾／檔案清理、同 key 重試、改檔衝突、跨市場身分與負向輸入。

`tests/manual-applications.ts` 使用真實 HTTP、Chromium、虛構帳戶／公司與產生的 PDF，涵蓋三種履歷來源及未指定履歷、台北時間、下載位元一致性、帳號隔離／CSRF、重複／併發、舊面試狀態、桌面／手機，以及延遲履歷回應跨帳號的回歸。外層 wrapper 驗證其他服務的 ID／啟動時間／重啟次數／健康狀態未變，且測試容器／網路已清除，才回報總體成功。
