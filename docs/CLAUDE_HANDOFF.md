# CareerOS → Claude 開發交接

交接日期：2026-10-20（America/Los_Angeles）。程式基準：`267e7c9576826240c5286a8263c61067e21f679f`。本文件記錄可核對的現況、歷史驗收及下一步，不代表整個產品已達 production-ready。

使用者另要求交接實際邀請碼與密鑰。完整私密版放在本機 `/Users/handsomejeff/Desktop/project/careerOS/.private-handoff/CLAUDE_HANDOFF_PRIVATE.md`，內含本文件及正式環境憑證；環境檔另存同目錄 `careeros.production.env`。兩者限制為本人可讀寫並排除 Git，不隨 GitHub clone 提供。Claude 在此電腦接手時應先讀私密版；這份公開版本保留技術交接而不包含秘密值。

## 1. 先看這幾件事

1. **接手現有專案，不需要從零重寫。** 完整工作在 `feat/verified-browser-submission`；`main` 明顯較舊。
2. **首要問題是讓使用者真正登入，接著完成實際投遞。** 使用者曾因只測草稿／模擬收件、沒有真正投遞而不滿。不要再將準備完成當成送出成功。
3. **LinkedIn／104 正式投遞尚未完成。** 有受控 receiver 的提交引擎測試；沒有可交付的真實平台 adapter。`SUBMISSIONS_ENABLED=false`，程式目前會拒絕以其他值啟動。
4. **Google 登入的樣式已修，真實帳戶登入仍未驗收。** 最後查到 OAuth client 沒有 Authorized JavaScript origin；前次只填好表單，未完成 Save。本次沒有登入 Google Console，不能假設設定仍與前次完全相同。
5. **共用職缺每六小時抓取已實作；個人職缺雷達只有設計。** 不要重做 collector，也不要把雷達文件中的資料表當成已存在。
6. **同一台 GCP VM 有其他服務，不能影響它們。** 所有測試使用隔離資料庫／容器；部署只操作必要的 CareerOS 服務。
7. **私有 GCS bucket／跨主機備份已由使用者要求延後。** 保留待辦；未完成獨立 journal 和恢復驗收之前，不可宣稱無人值守投遞已具備上線條件。

## 2. 位置、版本與本次核對結果

| 項目 | 位置／狀態 |
| --- | --- |
| 本機 repo | `/Users/handsomejeff/Desktop/project/careerOS` |
| 本交接文件 | `/Users/handsomejeff/Desktop/project/careerOS/docs/CLAUDE_HANDOFF.md` |
| GitHub | [chen3082/careerOS](https://github.com/chen3082/careerOS) |
| 接手分支 | `feat/verified-browser-submission` |
| 文件建立前 HEAD | `267e7c9`，本機與 GitHub 分支相同；工作目錄乾淨 |
| main | `0f2f74a`，不是最新功能基準 |
| PR | [#1](https://github.com/chen3082/careerOS/pull/1)，2026-10-20 查得 OPEN、draft，base 為 main |
| 正式網站 | [CareerOS](https://gptig.allenchencode.com/careeros/) |
| MCP endpoint | `https://gptig.allenchencode.com/careeros/mcp` |
| SSH | `ssh gptig`；連線別名在此電腦的 `~/.ssh/config`，不要複製私鑰進 repo |
| GCP 程式目錄 | `/home/yehca3144_gmail_com/careeros` |
| 正式環境設定 | GCP 程式目錄內的 `.env`；本機私密交接副本在 `.private-handoff/careeros.production.env` |
| 登入修補 staging | `/home/yehca3144_gmail_com/careeros-login-fix-20260927` |
| Figma | [CareerOS 設計檔](https://www.figma.com/design/jjl7ioOIAnBqsoKKW9AEvt)，[職涯導航畫面](https://www.figma.com/design/jjl7ioOIAnBqsoKKW9AEvt?node-id=20-622)；設計稿不等於已實作狀態 |

2026-10-20 唯讀檢查：

- `careeros_web_1`、`careeros_worker_1`、`careeros_db_1` 都是 healthy；localhost health 回傳 `ok: true`。
- web image：`sha256:0ac664cbee391104548ce35f6cbcdd565f7e01ca35c71da90fb9b08837df95c6`，自 2026-09-27 啟動，restart count 0。
- worker image：`sha256:392a369a69229eca3f165b3dd5dfc8bfd148ef2434f0ba055539c4d6600d739b`，自 2026-09-19 啟動，restart count 0。上次只有 web 登入樣式修補，兩者 image 不同是預期狀態。
- 伺服器磁碟上的 `server/index.ts`、`server/web-shell.ts`、`web/google-login.tsx`、`package-lock.json` 與本機 SHA-256 相符。這是四個指定檔案的核對，不是整份映像的完整重現證明。
- `REGISTRATION_OPEN=false`、`SUBMISSIONS_ENABLED=false`；`CATALOG_POLLING` 未顯式設定，依 production 預設開啟。
- Google 登入 Client ID 已設定且符合使用者提供的值；Gmail／Calendar 的 client ID + secret 尚未成套設定。
- `/careeros/api/auth/status` 回傳 `bootstrapAvailable=true`：本次檢查時尚未建立第一位 CareerOS 使用者。

本次只做文件交接及唯讀核對，沒有重跑 E2E、沒有重啟服務、沒有修改 Google Console 或進行外站投遞。日期較早的測試結果不能當成本日重新驗收。

GCP 目錄以前是由部署複製建立，曾確認沒有 `.git`；不要假設可以直接在那裡 `git pull`。本機／GitHub 才是版本來源。接手前重新檢查，避免覆蓋使用者或其他 agent 的修改。

## 3. 使用者要做的產品

使用者希望有完整的繁體中文網站，台灣及美國／國際職缺都支援：

- 透過長文字、語音與既有文件建立完整的個人經驗庫，保留 Markdown 等可讀文件。
- 從同一份真實經驗產生多個方向、中英文履歷，並根據職缺改寫；這裡的「finetune 履歷」是內容客製，不是訓練模型。
- 搜尋職缺、處理求職網站或公司候選人帳戶、填表、送出及驗證回條。
- 自動記錄使用哪份履歷、何時投遞、是否面試／offer；也能手動補登站外申請。
- 上傳面經；把面試準備和真正收到面試邀請分開記錄。
- 按職類整理「尚未投遞」職缺，並能邀朋友到私人小組，選擇性分享進度與面經。
- 可連接自己的 Claude，也要支援 OpenAI／ChatGPT／Codex，控制平台 AI 成本。
- 提供有來源依據的職涯路線、技能／經驗／證照建議。
- 定期找到新的合適職缺，通知使用者，而不是每次手動重新搜尋。

使用者很在意實際可用的流程、開發速度與其他服務的穩定性。做完一項應報告真實結果、測試範圍和剩餘卡點；需要使用者操作時，說明具體原因，避免反覆索取已提供的資訊或同一項授權。

## 4. 功能現況

| 模組 | 已實作 | 未完成／不能宣稱 |
| --- | --- | --- |
| 經驗庫 | 文字、Markdown、PDF、DOCX、錄音來源；AI proposal；本人確認；不可變 career revision；Markdown 匯出 | 本機 Markdown 自動監看、round-trip 三方合併、完整結構化欄位編輯 |
| 履歷 | 多方向／中英文／職缺客製；fact ID、版本及撤回檢查；本人核對；固定 PDF／DOCX／Markdown 匯出 | 任意 claim 的機器語義正確性保證、更多版型及求職信 |
| 公開職缺 | Greenhouse／Lever 公司 boards、Arbeitnow 有界樣本；共用抓取、健康狀態、私人收藏與申請 overlay | LinkedIn／104／Cake／Yourator 原生搜尋、全市場覆蓋、完善跨站實體去重 |
| 個人職缺雷達 | 設計與獨立設計 review | monitor 資料表、matcher、私人通知、AI 配對、前端／MCP；尚無產品程式 |
| 手動投遞 | 補登日期／管道／職缺；選站內履歷、外部附件、只填名稱或未指定；事件追蹤 | 手動紀錄不是站方收件證明 |
| 自動投遞 | dossier、一次性授權、permit、不可重複提交、unknown 結果與受控 HTTP receiver 測試 | 真實 LinkedIn／104／公司站點 adapter、獨立跨主機 journal、正式啟用 |
| 帳戶協助 | 網站揭露需求／指定站點與 Email 授權；MCP claim、回報、驗證接手及續接 | CareerOS 沒有雲端託管瀏覽器；真實公司帳戶註冊未完成驗收；狀態回報不是永久登入保證 |
| 面試／offer | 邀請、輪次、改期、面試準備、面經文字／附件、offer 條件版本及本人決定 | 不能因為準備面試就記成獲邀，不能讓模型代為接受 offer |
| 小組 | 邀請、共用職缺、私人未投／準備 overlay、選擇性進度分享、面經文字快照、討論與撤銷 | 群組職缺雷達及 Email 摘要只在後續設計範圍 |
| MCP | Remote HTTP MCP、OAuth/PKCE、scopes；經驗／履歷／草稿及提案流程 | 不會自動喚醒 idle Claude，也不會默默監看硬碟或讀取 AI 對話 |
| BYOK | OpenAI／Anthropic 文字任務；OpenAI 音訊轉錄；使用者 key 加密、預算預留 | 真實付費生成品質與用戶端連接尚未驗收；不能用訂閱 Cookie 代付背景 API |
| 職涯導航 | 固定最多 20 份本人保存職缺樣本的分析、證據缺口與成長任務 | O*NET／ESCO 等外部資料尚未導入；不可當成完整市場統計 |
| Google 登入 | 官方 GIS、伺服器 JWT 驗證、邀請制、明確帳戶連結、CSP 修補 | 仍缺真實使用者登入成功驗收，詳見下一節 |
| Gmail／Calendar | 唯讀 connector 與週期同步程式，結果進待確認訊號 | OAuth client 配置／必要驗證／真實帳戶驗收 |
| 備份 | 加密本機備份、刪除 ledger、隔離還原測試 | 異地 bucket／獨立 journal／跨主機災難復原；使用者已要求延後 |

## 5. 優先接手：Google 登入與首次使用

### 已知原因與前次停點

使用者於 2026-09-27 提供截圖：`Access blocked: Authorization Error`、`no registered origin`、`Error 401: invalid_client`。當時實際檢查 Google Console，發現：

- Project：`gpt-ig`；OAuth client 名稱：`Web client 2`；類型：Web application。
- 公開 Client ID：`49258663193-i1m0ga8tjv53dpmlkrpbu8ripuiqci4h.apps.googleusercontent.com`。
- **Authorized JavaScript origins 完全空白**。
- 網址 `https://gptig.allenchencode.com/careeros/` 填在 redirect URIs；這不會自動註冊 JavaScript origin。
- 正確 JavaScript origin 是 `https://gptig.allenchencode.com`，沒有 `/careeros/` path。
- 前次把正確 origin 填進 Console 表單，但依當時瀏覽器工具要求，停在 Save 前等待確認；對話內沒有收到該確認。舊分頁及未儲存內容不保證仍在。

本次使用者要求的是交接文件，並非同意保存上述設定。Claude 應重新讀取 Console 現況，依實際工具的授權規則完成該具體修改；不要重設其他應用共用的 client、刪除 redirect URI 或擴大 Gmail scopes。

### 已修好的第二個問題

截圖中的巨大 Google 圖示是另外一個 CSP 問題，已由 `267e7c9` 修好並部署。Google SDK 會注入 inline button stylesheet，並把 `document.currentScript.nonce` 帶到該 stylesheet。

- `server/index.ts`：Helmet 每次回應產生 CSP nonce。
- `server/web-shell.ts`：HTML 與 CSP 成對回傳，meta 帶 style nonce；HTML `Cache-Control: no-store`，沒有 ETag／Last-Modified。
- `web/google-login.tsx`：把 CSP style nonce 放在載入官方 GIS 的 script element 上。這與 OIDC challenge nonce 是不同用途。
- root、index、encoded index、SPA fallback 都走相同 shell handler；靜態資源保留快取。
- 沒有加入 `unsafe-inline`／`unsafe-eval`，也沒有放寬 JWT 驗證。
- 9 月 27 日已用正式站的真實 GIS 檢查：按鈕高 40px，圖示 18×18px；這只證明樣式修復，不代表登入成功。

### 完成驗收的步驟

1. 核對目前 Console client、origin 及 audience；必要時保存正確 origin。這是 Google 設定，不能只修改 repo 解決。
2. 等待設定生效，重新開啟 CareerOS，用本人既有 Google 帳戶走真實流程。
3. 目前 `bootstrapAvailable=true`，首次帳號需工作台 bootstrap 邀請碼。使用者要求的實際值已放入本機私密交接文件，來源為 GCP `.env` 的 `BOOTSTRAP_TOKEN`。不要寫到本公開文件、GitHub、log 或模型測試 fixture；只在必要且已授權的本服務開通流程使用。
4. 首位帳號成功後，改由管理員在設定頁發出單次工作台邀請。小組邀請是另一套機制。不要為了測試直接取消邀請限制或往 DB 塞使用者。
5. 確認進入已登入工作台、重新整理保留 session、登出有效，再檢查重登入。已有密碼帳號必須明確連結 Google，不可只憑相同 Email 合併。
6. 如有新增 OAuth consent、CAPTCHA、MFA 或必須由本人輸入的內容，清楚交接該一步；不要將其隱藏成測試成功。
7. 更新 [登入 review](GOOGLE-LOGIN-REVIEW.md) 的真實結果。`health=ok`、按鈕顯示、synthetic JWT、單純 callback 200 都不能替代上述驗收。

相關文件：[設定與診斷](GOOGLE-LOGIN.md)、[測試及事故紀錄](GOOGLE-LOGIN-REVIEW.md)。

## 6. 最重要的未完成功能：實際投遞

### 真實外站測試停在哪裡

以前用明確標記為虛構測試的 PDF 做過瀏覽器嘗試，但**沒有完成真實雇主投遞或公司帳戶建立**。

- LinkedIn：Algorized，job ID `4463660149`；曾進 Easy Apply 聯絡資料步驟，卡在履歷上傳，當時 Chrome extension 缺少 file URL 權限，`uploadSucceeded=false`、`submitted=false`。
- 公司註冊：KODA Technologies Inc.，停在新帳戶表單，沒有完成建立。當時需要本人處理密碼及後續驗證。
- 本機歷史狀態：`test-results/live-acceptance/STATUS.json`。它是被 Git 忽略的本機紀錄，時間為 2026-09-19，不代表現在仍登入或職缺仍有效。
- 舊紀錄含個人聯絡資料，勿整份貼到 GitHub／issue。需要真實聯絡資料時由使用者確認，勿把虛構人物資料帶入正式申請。
- 手動控制瀏覽器能跑通，也不代表產品已內建相同 adapter；兩者必須分開驗收。

### 已有的工程基礎

`server/submissions.ts`、`server/submission-browser.ts`、`server/submission-journal.ts` 與 migration 009 已有受控提交流程。`tests/submission-e2e.ts` 透過網站審閱／授權，向另一個 Node receiver 發出真正 multipart request；收件端核對 PDF bytes／SHA-256／receipt。

驗收涵蓋收件後斷線、unknown 防重送、並行 permit、跨帳號、授權到期、PDF 被換、表單目的地／hidden fields 變更及 307／308。這證明受控收件流程，不證明 LinkedIn／104／Workday 都能投遞，也不證明跨主機還原不重投。

下一步應選定一條能取得可靠收件證據的真實申請路徑，完成「登入／帳戶 → 選定已確認履歷 → 表單與答案 → 使用者審閱與授權 → 送出 → 回條 → 網站追蹤」。先明確列出支援平台及接手點，不要承諾全網通用。使用真實職缺驗收時使用本人確認資料；虛構履歷留在測試環境／受控 receiver。

`server/config.ts` 目前對 `SUBMISSIONS_ENABLED !== "false"` 直接拋錯，**不是改 `.env` 就能開通**。需先完成真實 adapter、獨立 journal、恢復與不重投門檻，再決定允許的產品模式。若 bucket 仍延期，可以先交付清楚標示的協助填寫與本人接手流程，但不能標成已完成無人值守投遞。

詳見 [提交驗收範圍](SUBMISSION-ACCEPTANCE.md)、[帳戶準備](APPLICATION_ACCOUNTS.md)、[獨立帳戶流程 review](ACCOUNT-SETUP-REVIEW.md)。

## 7. 個人職缺雷達：可直接照設計實作

已存在的 collector 在 `server/catalog.ts`、`server/public-job-feed.ts`、`server/worker.ts`，資料表由 migration 011 建立。共用來源預設每六小時更新，不消耗 LLM；私人搜尋、收藏、履歷及申請不會被放到公開 catalog。

個人雷達詳見 [JOB-RADAR-DESIGN.md](JOB-RADAR-DESIGN.md)，有資料表／API／MCP／前端／部署計畫與 R01–R18 驗收規格。擬新增 `server/job-monitors.ts`、`web/job-monitors.tsx`、`tests/monitor-e2e.ts` 及 additive migration；這些目前尚不存在。

已做獨立設計 review，三個容易踩的問題已在設計修正：

1. 通知歷史清理不能清掉首次處理／已提醒的去重狀態；`radar_job_states` 應獨立保留。
2. 不能用跨來源 `max(bigserial)` 當 commit 水位；使用每個來源的 cursor、不可變版本，以及與配對／通知同交易前進的 checkpoint。
3. 舊 collector 切換新事件寫入需要排空／寫入屏障／capture epoch；首次來源的 `NULL`（未初始化）與 `0`（成功空 feed）必須分開，避免第一次把數百個舊職缺全當新通知。

先做私人規則比對與站內提醒；AI 為後續可選任務，不阻塞監測。群組監測及 Email 摘要另分階段。監測不產生投遞授權，unknown 申請不可列入可重投清單。設計 review 通過不代表 R01–R18 已跑過。

## 8. 程式與資料導覽

技術組合：Node.js 22+、TypeScript、Fastify、React 19／Vite、PostgreSQL 17、Docker Compose、nginx、MCP TypeScript SDK、Playwright（測試／文件渲染／受控提交）。目前是單機部署的應用與 worker，並非另有一組已上線的微服務。

| 檔案／目錄 | 用途 |
| --- | --- |
| `web/main.tsx` | 主要頁面、登入、經驗／履歷／申請／面試／小組／設定；現有前端較集中，不要假設已有大型 router/store 框架 |
| `web/job-catalog.tsx`、`web/account-setup.tsx` | 共用職缺 UI、外站帳戶協助 UI |
| `web/google-login.tsx`、`web/api.ts`、`web/styles.css` | GIS 按鈕、API client、現有視覺樣式 |
| `server/index.ts`、`server/web-shell.ts` | Fastify、CSP、routes、靜態資源與 HTML shell |
| `server/config.ts` | 環境驗證；正式 HTTPS、提交功能 gate；讀取 `.env` |
| `server/auth.ts`、`server/google-login.ts` | session、CSRF／origin、邀請及 Google 身分驗證 |
| `server/routes.ts`、`server/domain.ts`、`server/schemas.ts` | HTTP commands、領域規則、輸入 schema |
| `server/assets.ts`、`server/crypto.ts`、`server/parse-document.ts` | 私人附件、加密、文件解析 |
| `server/mcp.ts` | OAuth／PKCE／DCR、read/write scopes、MCP tool 註冊 |
| `server/ai-generation.ts`、`server/worker.ts` | 固定輸入的生成任務、供應商計畫、預算與背景執行 |
| `server/catalog.ts`、`server/public-job-feed.ts`、`server/connectors.ts` | 共用來源排程／lease、公開 API 抓取、私人搜尋相關程式 |
| `server/account-setup.ts` | 指定網站的帳戶協助授權、claim、接手與觀察回報 |
| `server/submissions.ts`、`server/submission-browser.ts`、`server/submission-journal.ts` | 受控提交、permit／dossier／unknown 與 journal |
| `server/google.ts` | Gmail／Calendar connector；與 Google 登入是不同授權 |
| `server/groups.ts`、`server/account.ts` | 小組 ACL／分享、帳戶匯出與刪除 |
| `migrations/001_initial.sql` … `011_shared_catalog.sql` | 實際 schema；新增功能用下一個可用 additive migration，不修改已執行版本 |
| `scripts/backup.sh`、`scripts/verify-recovery.sh`、`server/replay-deletions.ts` | 備份、隔離還原、較新刪除要求重播 |
| `.github/workflows/ci.yml` | build、unit、PostgreSQL integration、多種瀏覽器驗收、offline worker 及 audit |

實際 API 前綴是 `config.basePath + "/api"`，目前為 `/careeros/api`；MCP 為 `/careeros/mcp`。設計文件中的 `/v1`、更多正規化實體及未來狀態機是目標規格，**以 migrations、schemas、domain code 決定目前真實契約**。

MCP 常用流程：

- 生成：`generation_create_task` → `generation_list_pending` → `generation_get_context` → 客戶端生成 → `generation_submit_result`，必須符合固定輸入與 hash，結果仍是待確認草稿。
- Markdown：`career_markdown_get`；文字來源：`sources_create_text`。
- 共用職缺：`catalog_search`、`catalog_sources`、`catalog_refresh`、`catalog_save`。
- 帳戶協助：`account_setup_list` → `account_setup_claim` → `account_setup_get_context` → `account_setup_report_observation`。
- 工具實際名稱、欄位與權限以 `server/mcp.ts` 為準，不照舊設計文件的示意名字直接呼叫。

MCP 模式由已連接的使用者 AI 執行；server 不持有 Claude／ChatGPT 訂閱 cookie，也不能用 MCP 自動喚醒閒置客戶端。網站背景生成使用本人選定的 OpenAI 或 Anthropic key；不偷偷 fallback 到另一供應商或平台 key。未知費用／逾時保留預留，不自動重試付費生成。模型名稱是當前程式設定，不保證未來供應商仍提供，升級時另核對。

## 9. 不要破壞的資料與安全規則

- 經驗 facts、履歷版本及申請快照保留來源／版本；AI 提案需本人確認，不可憑空補職稱、年資、技能或工作權。
- 內容不可變與「目前是否仍可使用」分開；撤回事實會影響後續用途，但不能改寫已投出的舊履歷歷史。
- 所有私人資料都驗證 owner。公用 catalog 只含公開 feed；群組分享是明確選擇的快照，不是成員全部私人資料。
- MCP scope 不等於網站確認權限；MCP 提議事件不能直接增加已投／面試／offer 的權威統計。
- `submitted` 需要對應的收件證據，或明確標記為本人手動補登。unknown 結果不能排回自動重試。
- 收到面試與正在準備面試分開；收到 offer 與本人接受／拒絕分開。
- 外站 Cookie、OTP、密碼、API key、邀請碼、真實履歷及私人聯絡資料不進 Git、公開交接文件或普通 log。使用者已授權的本機私密憑證交接檔是例外，仍須留在被忽略且限制權限的位置。
- 外部 JD／文件／網站內容當資料，不作為系統指令；限制外連目的地、redirect 及資料大小，避免 SSRF 與履歷外洩。
- 保留 CSP／nonce、CSRF／origin、HttpOnly session、多租戶複合外鍵、鎖與 idempotency 防護。不要用關掉保護來通過測試。
- 備份恢復要先重播最新刪除 ledger，撤銷失效授權並對帳；不能從舊備份復活已刪除資料或重送申請。

## 10. 開發與測試

### 本機接手

```bash
cd /Users/handsomejeff/Desktop/project/careerOS
git status --short
git branch --show-current
git log -5 --oneline
```

如果換新電腦，可 clone 後 checkout `feat/verified-browser-submission`；如果已有修改，先保留並檢查，不要 hard reset。文件所在分支也有最新功能；不要只 clone main 後判斷程式不見。

安裝與 build：

```bash
npm ci
npm run build
npm test
```

`npm run check` 只做 TypeScript。上述操作不代表真實第三方登入或投遞已通過。

開發服務參考 `.env.example` 和 [DEPLOYMENT.md](DEPLOYMENT.md)。使用自己的開發 PostgreSQL，填一致的密碼／DATABASE_URL、隨機 `ENCRYPTION_KEY` 與 bootstrap token；不要複製正式 `.env` 到測試。`PUBLIC_URL` 決定後端 path／origin；Vite 的 `BASE_PATH` 必須對齊。`npm run dev` 是 API，`npm run dev:web` 是 Vite，背景任務另啟動 `npm run worker`。

非 Docker 環境另需 Chromium、CJK 字型、FFmpeg 及 Poppler；詳見 README／Dockerfile。跑整合測試前務必用 `NODE_ENV=test`、專用名稱以 `_test` 結尾的 DB、測試資料目錄，並先 migrate。多個 E2E 會 `TRUNCATE` 或重建測試資料，不能同時共用同一 DB，更不能連正式 DB。

### 優先使用隔離 GCP harness

從獨立 QA staging 目錄使用 `scripts/test-mcp-e2e.sh`。它建立自己的 PostgreSQL、tmpfs 私人資料與 `--internal` Docker network，不掛載正式 `.env`／volume，也不發布 host port。

```bash
# 先 build 當次候選 image；下面的 tag 必須是此次程式的 image。
sudo env CAREEROS_E2E_SCENARIO=google \
  CAREEROS_E2E_IMAGE=careeros:your-reviewed-candidate \
  bash scripts/test-mcp-e2e.sh
```

`your-reviewed-candidate` 是待替換的示意 tag，不是已存在的 image。腳本會確認 image 已存在，不會替你建置。**腳本掛載 tests 與 dist，backend 來自 image；只改 server 原始檔卻沿用舊 image，會測到舊 backend。**

| scenario | 測試程式 |
| --- | --- |
| `mcp` | `tests/mcp-e2e.ts`，三個虛構人物／六版履歷／真實 HTTP MCP |
| `manual` | `tests/manual-applications.ts` |
| `google` | `tests/google-login-browser.ts`；另跑 unit／integration |
| `providers` | `tests/ai-provider-browser.ts`；另跑 unit／integration |
| `submissions` | `tests/submission-e2e.ts`，受控 HTTP receiver |
| `accounts` | `tests/account-setup-e2e.ts` |
| `catalog` | `tests/catalog-e2e.ts` |

harness 需要約 1.7 GB 可用記憶體，限制 CPU／RAM／PID，低記憶體會停止自己的 runner；GCP 曾是 2 CPU／4 GB，接手時重新看資源。結束後檢查 `report.json` 的 `passed`、`servicesUnchanged`、`cleanupVerified`，不要只看個別 PASS。

`scripts/test-remote.sh` 是較早的流程，會讀正式部署 `.env` 並在既有 DB 服務建立另一個 test database，隔離程度較低；共享主機優先用上述 disposable harness。

### 歷史驗收，不等於本次重跑

| 日期／範圍 | 已留存的結果與限制 |
| --- | --- |
| 2026-09-19 MCP E2E | 27 組檢查、115 次 MCP tool 呼叫、三個虛構人物／六版履歷；固定 JSON fixture，非付費模型品質驗收 |
| 2026-09-19 submission E2E | 11 組、三份 PDF 真正送到受控 receiver；另有收件後斷線注入；非雇主收件 |
| 2026-09-27 Google 修補 | build、4 unit、41 integration、9 synthetic browser checkpoints；含 nonce CSS 正向與無 nonce CSS 拒絕 |
| 2026-09-27 真人瀏覽器 | 正式 Google SDK 按鈕樣式修復；沒有 Google 帳戶登入成功 |
| 2026-10-20 本次交接 | Git／PR／部署 health／功能設定／四個檔案 hash 唯讀核對；未重跑上述測試 |

最近 Google 報告：本機 `test-results/google-login-fix-20260927/report.json`；GCP `/home/yehca3144_gmail_com/careeros-login-fix-20260927/test-results/careeros-mcp-e2e-20260927T220441Z-3910862/`。其他案例見對應 review 文件。

報告與履歷 artifacts 通常被 `.gitignore` 排除，GitHub clone 不會自帶；不在新機器上看到它們不代表程式缺失。也不要因此把全部 test-results（可能含私人資料）加入 Git。

## 11. 部署與回退

目前是 Docker Compose（現場沿用 `docker-compose` 指令）。PostgreSQL 不發布主機 port；web 只綁 `127.0.0.1:3100`；nginx 代理 `/careeros` 及 MCP discovery。web／worker 為非 root、唯讀 rootfs、capabilities 移除及資源限制。不要為新功能取消這些限制。

開始前可做的唯讀檢查：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 gptig \
  'cd /home/yehca3144_gmail_com/careeros && sudo -n docker-compose ps && curl -fsS http://127.0.0.1:3100/careeros/health'
```

部署順序：

1. 保存當前 image ID、精確 container 名稱、啟動時間、restart count、health；先檢查資源與部署目錄是否有其他人改動。備份依部署文件處理。
2. 在獨立 staging 建候選 image，跑與修改相關的測試及 review。不要把 `.env`、附件或備份放進 build context。
3. 需要 schema 變更時用 additive migration，明確處理舊／新 worker 相容性與排程；例如雷達 collector 切換需遵守設計中的寫入屏障。
4. 只替換必要服務。純 web 修補可用 `docker-compose up -d --no-deps web`，但前提是候選 image 已正確指派。queue／provider／catalog 變更則可能要協調 web 與 worker，不能一律只換 web。
5. 比對其餘容器狀態，檢查健康與實際功能。正式測試證據應與 synthetic 測試分開記錄。
6. 回退使用已保存的相容 image；不要為回退直接 drop 正式資料表，不要重播提交任務。涉及 worker 格式變更時，舊 worker 可能不能安全恢復。

禁止對共享主機做 `docker system prune`、全機 restart、清空 volumes 或為了 CareerOS 停掉其他服務。現場同機有 habit API／Mongo／autoheal；本任務沒有改它們的授權。

9 月 27 日回退 tag 為 `careeros:rollback-google-fix-20260927`，其 image 為 `392a369a6922…`。執行前先驗證它仍存在及相容。Compose 的 web／worker 共用 tag `careeros:local`，但既有容器不會因 tag 改變而自動更新；**應看容器 Image ID，不能只看 tag 名稱判定版本。**

本機備份不是跨主機災難恢復。私有 bucket 建立曾因服務帳戶權限不足回 403，使用者明確說先列 TODO；這一項不是再給他同樣問題就算完成。不要把已延期的工程門檻繞過成「正式自動投遞已開通」。

## 12. 建議的接續順序與完成定義

| 次序 | 工作 | 可交付結果 |
| --- | --- | --- |
| 1 | Google 設定及首位帳號 | 本人從正式網站成功登入、重整／登出／重登入；紀錄真實結果與剩餘限制 |
| 2 | 實際申請流程 | 明確平台支援範圍，帳戶／履歷／答案／授權／接手／回條串通；無證據不標 submitted |
| 3 | 個人雷達 | 沿用 catalog，先私人規則及站內提醒，完成 R01–R18；不新增重複 collector |
| 4 | 真實 AI 客戶端與 BYOK | Claude 等客戶端實際連接；個人 key 成本／生成品質驗收，不靠 stub 宣稱完成 |
| 5 | 公開上線補強 | 依使用者優先級補異地備份、恢復、密碼復原、告警、負載與資安驗收 |

若某一步等待使用者登入或 Google Console 操作，可繼續不依賴它的程式工作；不要把等待時間當授權。每一批保留：改了什麼、commit、測試證據、部署版本、回退方式、仍未驗收的外部流程。使用者先前要求完成後另起 agent review，重要程式變更延續這個流程。

## 13. 文件閱讀順序

1. 本文件、[README](../README.md)、[TODO](TODO.md)：現況與限制。
2. [Google 登入](GOOGLE-LOGIN.md)、[登入事故與 review](GOOGLE-LOGIN-REVIEW.md)：眼前使用阻擋。
3. [提交驗收](SUBMISSION-ACCEPTANCE.md)、[帳戶準備](APPLICATION_ACCOUNTS.md)、[手動申請](MANUAL_APPLICATIONS.md)：投遞能力的實際界線。
4. [共用 catalog](SHARED-CATALOG.md)、[個人雷達設計](JOB-RADAR-DESIGN.md)、[雷達 review](JOB-RADAR-DESIGN-REVIEW.md)：監測功能。
5. [AI／MCP](AI-PROVIDERS.md)、[MCP E2E](MCP_E2E.md)、[部署](DEPLOYMENT.md)：開發及營運。
6. [SYSTEM_DESIGN](SYSTEM_DESIGN.md)、[SYSTEM_CONTRACTS](SYSTEM_CONTRACTS.md)、[WEB_PRODUCT_SPEC](WEB_PRODUCT_SPEC.md)、[GROUPS_PRODUCT_SPEC](GROUPS_PRODUCT_SPEC.md)、[CAREER_GUIDANCE_DATA_PLAN](CAREER_GUIDANCE_DATA_PLAN.md)：完整目標方案，包含未實作部分。

舊報告是按日期保留的快照，例如曾寫「尚未設定 Client ID」或「提交引擎尚未部署」；不要忽略後續日期的修補／部署紀錄。遇到矛盾，核對目前 code、migrations、image 與實際驗收，而不是把設計文字當產品能力。

## 14. 可直接貼給 Claude 的接手指令

```text
請接手 CareerOS，先讀：
/Users/handsomejeff/Desktop/project/careerOS/.private-handoff/CLAUDE_HANDOFF_PRIVATE.md
這份包含完整交接、現有邀請碼及部署密鑰。
如果你是在另一台機器且沒有私密檔，先讀 docs/CLAUDE_HANDOFF.md，
再由使用者提供私密檔；不要將缺少憑證當成需要重新建立整個專案。

程式在同一個 repo，接手分支是 feat/verified-browser-submission，main 較舊。
先檢查 git status、文件和部署現況，再沿用現有程式開發，不要從零重做。

優先完成正式網站 Google 登入與首位帳號，再推進能驗證真實收件的申請流程；
個人職缺雷達已有完整設計，但還沒有實作。
請清楚區分已完成、只有設計、synthetic 測試與真實平台驗收。

GCP 透過 ssh gptig 連線；正式目錄：
/home/yehca3144_gmail_com/careeros
不能影響同機其他服務。不要將 .env、邀請碼、API key 或私人履歷放入 Git。
維持隔離測試；重要變更完成後做獨立 agent review，回報測試與部署證據。
遇到需要本人登入、驗證或新增外部授權的步驟，具體說明卡在哪裡，
並繼續完成不依賴該步驟的工作。
```
