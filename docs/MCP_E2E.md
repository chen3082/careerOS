# MCP 端到端驗收：虛構履歷

這套驗收使用三位明確標記的虛構人物：台灣後端工程師、美國資料分析師、轉職前端工程師。每人產生中文與英文兩版履歷，包含 PDF、DOCX、Markdown。所有 email 使用保留的 `example.test`，職缺公司、面試、offer 都是合成資料，不會寄出求職申請。

## 2026-09-19 驗收結果

07:17:52–07:21:01 UTC 的隔離執行通過 **27 組檢查、115 次 MCP tool 呼叫**，產生六版履歷／18 個履歷檔案、三份原始素材與三份 canonical Markdown。六次 PDF／DOCX 重新上傳均由真實 worker 解析成功。桌面與手機截圖已檢視；本機收到的成品全部通過 SHA-256 比對。

Wrapper exit=0；`scenarioPassed=true`、`passed=true`、`servicesUnchanged=true`、`cleanupVerified=true`。既有服務的 ID、啟動時間、restart count 與 health 在測試前後相同。測試 DB、附件、container 與 network 已清除，僅保留合成文件和驗收報告。

這次測試發現並修正：停在履歷頁時，MCP 新建立的履歷沒有自動顯示。可見的履歷、總覽、申請、面試及職涯頁現在沿用既有每十秒更新機制，開啟表單時不更新。回歸保留同一頁，確認第二份 MCP 履歷無須重新整理即可出現。獨立 reviewer 檢查此修正的表單、帳戶隔離與請求頻率，沒有新增 blocker。

## 執行邊界

- 使用目前 `careeros:local` Docker image 的 backend，加上此次 `npm run build` 的 frontend 唯讀 mount（另存 SHA-256 manifest），透過官方 MCP SDK 呼叫真實 HTTP endpoint；本人確認使用 Chromium 操作網站。不是直接插入業務資料來假裝流程成功。
- 為每次 run 建立新的 PostgreSQL、app runner 與 `--internal` Docker network。不使用正式 Compose network／volume／`.env`，不開 host port，不修改 nginx，不重啟任何既有服務。
- 隨機產生拋棄式密碼、加密金鑰與 bootstrap token。DB 和私有附件在 tmpfs；只有公開測試程式及合成報告目錄被掛載。
- DB 限制 256 MiB／0.25 CPU；runner 限制 1024 MiB／0.75 CPU、唯讀 rootfs、移除 capabilities、限制 PID。開始前需至少約 1.7 GB 可用記憶體；執行時低於約 350 MB 即停止測試 runner。整輪最多 12 分鐘。
- 結束或失敗都清除本輪精確名稱的 container/network；不使用 `docker system prune`、全域 restart 或清空正式表。前後比對既有服務 ID、啟動時間、restart count、health，並驗證測試資源已移除。

## 執行

在已經 build 好 app image、具有 PostgreSQL 17 image 與 Python 3 的 Linux Docker 主機上，從 repo 執行：

```bash
npm run build
sudo bash scripts/test-mcp-e2e.sh
```

也可以把 `tests/mcp-e2e.ts`、`tests/fixtures/synthetic-careers.ts`、build 後的 `dist/` 和這個 script 複製到獨立 QA staging 目錄執行，無須改動正在部署的目錄。腳本不會 pull image 或安裝 host 套件。非 root 使用者須透過 sudo 執行；runtime application 保持 image 內的非 root 使用者。

報告位於 `test-results/careeros-mcp-e2e-<timestamp>-<pid>/`：

- `REPORT.md`／`report.json`：實際通過項目、時間、MCP 呼叫數、檔案 hash；外層 wrapper 完成後合併服務比對／清理結果，`scenarioPassed` 與整體 `passed` 分開記錄。
- 三份原始經驗、三份 canonical career Markdown、六份履歷（每份三種格式），以及桌面／手機截圖。
- `isolation.txt`：清理和服務狀態比對結果；before/after 檔案供本機核對，不上傳 Git。
- `run.log`：不輸出密碼、OAuth token 或正式資料；生成 JSON 為固定的虛構測試 fixture。

## 驗證範圍

MCP source → 經驗抽取草稿 → 網站確認 → canonical Markdown → 通用／職缺客製履歷 → 網站確認 → 固定文件下載 → 準備申請 → MCP 事件提議 → 網站確認 → 面試／面經／offer → 有職缺證據的職涯建議。

負向測試包含 PKCE、code 一次性、唯讀 scope、refresh reuse 撤銷、跨帳號 source/fact/task/job/resume/asset、CSRF／Origin、危險 redirect、輸出 evidence 限制、HTML 純文字顯示、私人附件加密／權限、檔案格式、群組撤銷及刪帳後存取失效。PDF／DOCX 另外經真實 worker 重新解析，核對中文姓名及 email。

**限制：**使用固定 fixture 模擬 MCP 客戶端產生的 JSON，沒有呼叫付費模型，不能據此宣稱 Claude 生成品質、模型抗 prompt injection 能力、真正對外投遞、Google 整合、公開 HTTPS proxy 全流程或完整滲透測試已驗收。正式網站的 health 另以唯讀檢查確認。
