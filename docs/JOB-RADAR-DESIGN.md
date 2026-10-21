# 職缺雷達：個人監測、配對與提醒設計

設計日期：2026-09-27。程式基準：`f4fb9cd`。狀態：**個人職缺雷達的設計規格，尚未實作或部署**。本文件不代表已驗證今天的正式環境；既有共用抓取的實作與驗收另見 [SHARED-CATALOG.md](SHARED-CATALOG.md) 與 [SHARED-CATALOG-REVIEW.md](SHARED-CATALOG-REVIEW.md)。

## 1. 現況與這次補足的範圍

| 能力 | 程式現況 | 雷達增量 |
| --- | --- | --- |
| 公開來源定期抓取 | 已實作，預設每 6 小時；來源設定可為 1–24 小時 | 沿用同一個抓取器，避免每人重抓 |
| 共用職缺清單與來源健康 | 已實作，包含初次發現、內容 hash、來源失敗與部分資料 | 增加可重播的內容版本與事件 |
| 私人收藏／投遞狀態 | 已實作，以 owner 範圍查詢 | 配對結果接回既有私人職缺與申請 |
| 個人保存監測條件 | 尚未實作 | 多組條件、暫停、頻率、首次基準 |
| 新職缺／變更提醒 | 尚未實作 | 私人站內收件匣、去重、已讀與保留歷史 |
| 依經驗解釋適合原因 | 尚未串到監測 | 可選擇的 AI 分析，附 fact／JD 證據與成本 |
| LinkedIn／104 定期來源 | 尚未接入共用抓取 | 顯示未支援，不因可開申請頁就宣稱可監測 |
| 群組監測 | 尚未實作 | 第二階段，分享公開職缺條件及結果；個人狀態仍私人 |

使用者不開網站、不開 Claude／ChatGPT，也能持續抓取公開來源、執行條件篩選及產生站內提醒。MCP 提供查詢與操作介面，排程和進度由 CareerOS 的資料庫及 worker 管理。

## 2. 使用者流程與畫面

### 2.1 找職缺 → 職缺雷達

沿用「找職缺」頁，在「共用職缺／我的職缺」旁加「職缺雷達」分頁。入口提供「建立監測」；共用清單的目前搜尋條件也可「存成監測」。不替使用者預先啟用任何私人監測。

桌面版上方為監測卡片，下面為結果列表；手機版改為單欄，來源健康與進階條件可以展開。卡片包含名稱、啟用／暫停、未讀新職缺數、上次配對完成時間、下次檢查時間與來源警示。

```text
找職缺  >  職缺雷達                         [建立監測]
美國後端工程師  啟用  ·  3 個未讀新職缺      [設定] [暫停]
每 6 小時比對；來源最近成功：今天 08:00
[全部] [新發現] [內容變更] [我尚未投遞] [已略過]

職位／公司／地點                 來源、發現時間、狀態
符合條件：Python、台灣；薪資：未提供
AI 分析：待連接的助理處理
[查看原文] [收藏] [準備履歷] [略過]
```

上述數字是線框示意，不能作為正式頁面的預設假活動。無監測時呈現建立入口；無新結果時呈現上次成功檢查與涵蓋來源，不能將來源故障顯示成「沒有職缺」。

### 2.2 建立／修改監測

| 欄位 | 首版規則 |
| --- | --- |
| 名稱 | 必填，最多 100 字；例：台灣後端工程師 |
| 關鍵字 | 包含任一、包含全部、排除詞分開；每組最多 10 詞，每詞 50 字；比對職稱／公司／JD，Unicode 正規化、大小寫不敏感，不使用使用者提供的正規表示式 |
| 市場 | 台灣／美國／其他或地域未明，可複選；地域未明不算符合台灣或美國 |
| 來源 | 從已啟用的來源選擇，至少 1 個；私人監測不會新增任意抓取網址 |
| 公司 | 可包含／排除已知公司；名稱比對不代表公司法人實體合併 |
| 未知資料 | 顯示「未提供」；不得推定可遠端、薪資、年資或簽證資格 |
| 檢查頻率 | 每 1／6／24 小時，預設 6 小時；比對的是來源快取，畫面同時顯示實際來源更新頻率 |
| 提醒 | 首版站內提醒；預設只提醒首次新增符合條件的職缺；內容變更提醒可另開啟 |
| AI 配對 | 預設關閉；開啟後依現有 MCP／BYOK 模式處理，先顯示每日分析筆數上限 |
| 首次結果 | 建立現有職缺基準並可瀏覽，不將所有舊職缺寄成新提醒 |

首版不提供無資料支持的薪資、年資、公司人數、遠端或 sponsorship「硬篩選」。第二階段增加結構化抽取後，保存原文、單位與可信度，並明確讓使用者選擇保留或排除未知值；TWD 月薪不直接與 USD 年薪比較。

儲存前顯示條件摘要與最近快取的預估結果數，不呼叫 LLM、不產生提醒。提交後顯示「正在建立基準」。修改條件產生新版本並重新建立基準；原先已讀／略過／已投遞狀態保留，既有職缺不因改了關鍵字就成為新職缺。

### 2.3 提醒與申請

站內提醒列出新增職缺、命中的監測名稱、符合的明確條件、原文網址及 CareerOS 發現時間。跨監測命中同一職缺合併一則提醒，點入能看到各監測的配對理由。僅在已有該使用者的申請紀錄時顯示其私人進度。

「尚未投遞」意指 CareerOS 尚無本人已投紀錄，不推定其他網站從未投過；待準備仍未送出，但 `outcome_unknown` 必須顯示「送出結果待確認」，不列入可再次投遞清單。忽略／已讀屬於本人，不能影響朋友的清單。

「準備履歷」呼叫既有 `catalog_save` 領域流程建立或重用私人快照，再进入現有履歷／帳戶準備流程。監測、AI 分析或群組加入均不建立投遞授權；送出仍經原有 dossier、policy、permit 與回條規則。首版不新增或開啟任何自動投遞開關。

## 3. 處理流程、首次基準與一致性

1. 既有 collector 以來源 lease 抓取並驗證 feed。公開資料與私人條件分離；多個使用者共用一次來源抓取。
2. `publishCatalogFeed` 的同一筆交易更新公開清單、不可變版本、來源事件，以及每個來源的 `event_seq`。只有真正新增、內容改變、重新出現或完整 feed 證明未列出時產生事件；僅 `last_seen_at` 改變不產生事件。
3. 雷達排程器每分鐘挑選到期監測。以 `FOR UPDATE SKIP LOCKED`、唯一 run key 及短期 lease 排入配對，設定版本與 cursor 上限凍結在 run 中。
4. 規則比對先執行，新增結果、站內通知及 cursor 推進在同一個有 owner／generation／lease 檢查的交易中完成。失敗重試會讀到既有結果而不重複通知。
5. AI 分析是後續可選任務。規則結果與提醒不等待模型；沒有 key／客戶端或預算不足，不阻塞監測。

### 3.1 避免漏資料的 cursor

不用跨來源的 `max(bigserial)` 當作已完成水位：不同來源的交易可能以不同次序 commit。事件序號在持有相同 `catalog_sources` row lock 的交易內逐一增加；每組監測持有 **每個來源自己的 cursor**。來源序號、事件與清單同交易 commit／rollback。

每次 run 凍結各來源已 commit 的上限。逐頁處理 `(cursor, upper_bound]`，每頁最多 500 事件；cursor 只在該頁所有配對、提醒及狀態落盤後前進。run 未完成前不啟動同監測的下一個 run；崩潰後重新 claim 同一 run，以原本上限接續。長期延遲只排一個補進度 run，避免大量補跑每個漏掉的時段。

首次或條件改版的 baseline，先凍結來源上限，再讀每個職缺在該上限前最後一個不可變版本，分頁保存現有符合項。baseline 完成時才將來源 cursor 切到上限；其後 commit 的事件留給下一次增量，沒有「建立過程中新職缺被跳過」的空窗。baseline 不建立新職缺通知。

首次啟用的新來源即使抓到數百筆職缺，也只建立該來源的 baseline，UI 顯示「新來源，現有職缺已整理」。來源具有持久的 `initialized_at` 和 `initial_feed_seq`；尚未取得成功 feed 時兩者為 NULL，監測對該來源保持 `waiting_source`，不能因 event_seq=0 而宣布空 baseline 完成。

第一次成功發布 feed 時，collector 在同交易設定 initial-feed 水位；完整空 feed 的初始水位可以是 0，NULL 與 0 不能混用。監測在此後凍結不小於 initial-feed 水位的已 commit 上限作 baseline。第一次失敗則維持等待；第一次成功但僅部分 feed 仍可建立該已觀察樣本的 baseline，畫面標示覆蓋不完整。之後才被觀察到的職缺只能叫「新發現」，不能宣稱「新刊登」。不能把首次匯入日期當成雇主刊登日期；若來源有可靠刊登時間，另外保存 `published_at` 與其來源。

### 3.2 暫停、來源故障與職缺消失

- 暫停、修改條件或封存監測都鎖定監測 row、增加 `generation`、作廢進行中的 run。已持有舊 generation 的 worker 不得發布結果或通知；恢復後從已完成 cursor 補進度，條件修改則重新 baseline。
- 來源失敗／限流／資料不完整不產生「職缺關閉」。`not_listed` 只表示在成功完整 feed 中不再列出；畫面寫「來源已不再列出」，仍未驗證雇主關閉。
- 某來源失敗時，其它來源照常配對；run 顯示 `partial` 並列出失敗來源。沒有任何可用資料時顯示 unavailable，不能用成功零結果掩蓋故障。
- 判斷過期以來源及該筆職缺的觀察時間為準；部分 feed 中殘留的舊職缺不可冒充剛確認仍在刊登。關閉／重開事件不自動恢復已略過的項目或重新投遞。
- 管理員停用來源後，結果仍可看歷史，但不得再為該來源建立新提醒／AI 任務。發布結果前再次檢查 source enabled；停用狀態與變更 generation 以固定 source→monitor 鎖順序串行。

## 4. 擬新增資料結構

下表是後續 additive migration 規格，不是已存在的資料表。所有私人表帶 `owner_id`，使用 owner + id 複合外鍵；來源版本僅含公開 feed 資料。

| 實體 | 主要欄位與約束 |
| --- | --- |
| `catalog_sources` 增量 | `event_seq bigint NOT NULL DEFAULT 0, initialized_at timestamptz NULL, initial_feed_seq bigint NULL`；初始化欄位同為 NULL 或同時有值，0 為合法初始水位；沿用現有 provider、interval、lease 與健康欄位 |
| `radar_capture_state` | 單例 `capture_epoch, ready`；collector 切換／還原時的持久 gate；matcher 開始及發布都檢查 epoch，不單靠舊程序可能仍開著的環境變數 |
| `catalog_job_versions` | `id, source_id, catalog_job_id, source_seq, content_hash, public_snapshot, availability, observed_at`；唯一 `(source_id, source_seq)`；公開內容不可變，外鍵驗證 job 屬於該來源 |
| `catalog_events` | `source_id, source_seq, catalog_job_id, version_id, kind, committed_at`；kind 為 created／changed／relisted／not_listed；版本對應唯一、不可由使用者任意寫入 |
| `job_monitors` | `id, owner_id, name, filters, filters_version, version, generation, interval_hours, enabled, archived_at, alert_changes, ai_enabled, next_run_at, last_completed_at`；每人最多 10 組未封存監測；AI 日限額另存 user settings，不能用多建監測提高 |
| `monitor_sources` | `owner_id, monitor_id, source_id, cursor_seq, baseline_state`；唯一 `(monitor_id, source_id)`；來源增減使監測 generation 變更 |
| `monitor_runs` | `id, owner_id, monitor_id, generation, capture_epoch, due_slot, kind, state, frozen_bounds, progress, lease_token, lease_until, attempts, error_codes, started_at, finished_at`；唯一 `(monitor_id, generation, due_slot)`；每監測最多一個 queued／running run |
| `monitor_matches` | `id, owner_id, monitor_id, catalog_job_id, version_id, rule_reasons, match_state, first_matched_at, last_matched_at, generation`；唯一 `(owner_id,id)` 及 `(monitor_id, catalog_job_id)`；變成不符合仍保留歷史，無法繼續當作新符合項投遞 |
| `radar_job_states` | `owner_id, identity_key, first_match_handled_at, first_match_disposition, read_at, dismissed_at`；唯一 `(owner_id, identity_key)`，跨本人監測共用首次配對處理紀錄與已讀／略過狀態；首次 disposition 區分 baseline／already_applied／notified |
| `radar_notifications` | `id, owner_id, identity_key, event_kind, change_fingerprint, seen_at, created_at`；唯一 `(owner_id, identity_key, event_kind, change_fingerprint)`；純站內第一版，與來源事件交易建立 |
| `radar_notification_matches` | `owner_id, notification_id, monitor_id, catalog_job_id, version_id`；複合外鍵只連到同 owner；呈現合併通知的來源，不複製其他人的資料 |
| `radar_analyses` | `id, owner_id, catalog_job_id, version_id, career_revision, model_policy_version, task_id, state, result, evidence, created_at`；內容版本＋經驗 revision＋模型策略作快取 key；不把模型分數當录取概率 |

`identity_key` 首版沿用現有 catalog 的保守識別：相同完整來源 URL 可作跨來源別名，無 URL 時用 source + external_id。不要刪除未知 query 參數或只憑職稱合併；不同網址的疑似重複只顯示提示。首次提醒的 `change_fingerprint` 固定為 `first_match`，修改監測或另一個來源晚收錄同 URL 不重發；更新提醒取確定的公開欄位及 availability fingerprint，不含抓取時間或來源序號。

通知發布要即時檢查本人投遞狀態。已投過或結果待確認仍可在列表查看，但預設不產生「可投新機會」提醒。第一次配對即已投過者也寫入 first-match 去重紀錄，不因後續狀態改動突然被当成新機會。

baseline 也必須寫入 `first_match_handled_at` 及 suppression disposition，不能只是不建立通知；否則相同職缺被另一來源晚收錄時會再次被當成新機會。首次處理紀錄、必要通知與 cursor 同交易提交。既有未符合職缺後來因內容變更首次符合時，標示「新符合條件」而非「剛刊登」；是否提醒遵循 `alert_changes`，即使關閉提醒仍寫入已處理紀錄。URL 變動時保留相同 source + external_id 的穩定 identity，新增 URL 只作別名，不洗掉既有去重狀態。

公開事件／版本保留 90 日，並保留每個職缺的最新版本；私人配對、通知及 AI 結果預設保留 180 日，封存與刪帳可更早清理。精簡的 `radar_job_states` 去重紀錄保留至帳號刪除，不因通知歷史到期而重寄首次提醒。還在引用的版本不能被清掉：baseline run 使用的上限及版本保留到 run 完成或 24 小時強制過期；來源 cursor 若落在已刪除區間，標示 `history_gap` 並重建基準，不宣稱已完整回補。來源 initial migration 在同一來源鎖下為現有列建立 baseline 版本，所有既有職缺不產生新提醒。

## 5. API、MCP 與安全邊界

| HTTP（位於既有 `/api`） | 行為 |
| --- | --- |
| `GET /monitors`、`GET /monitors/:id` | 私人監測、來源水位、最近 run 與錯誤；不回 lease token |
| `POST /monitors/preview` | 只讀既有快取，回傳條件匹配數、來源日期與未知資料；不觸發抓取或付費 |
| `POST /monitors` | 嚴格 schema、idempotency key、owner 配額；建立監測與 baseline run 同交易 |
| `PATCH /monitors/:id` | `expectedVersion`，修改／暫停／恢復／封存；不沿用舊 generation 的工作 |
| `POST /monitors/:id/check` | 要求立即比對現有清單；每監測 5 分鐘 cooldown，同時執行時回既有 run；不暗中提高來源抓取頻率 |
| `GET /monitors/:id/matches`、`GET /monitors/:id/runs` | cursor 分頁；回傳本人進度、欄位證據與 freshness |
| `GET /radar/notifications` | 本人站內提醒與未讀數，cursor 分頁 |
| `POST /radar/job-state` | 本人的 read／dismiss 操作，驗證其結果存取權 |
| `POST /radar/notifications/:id/read` | 冪等標已讀；只容許本人 |
| `POST /radar/matches/:id/analyze` | 精確綁定版本與 career revision，遵循現有模型模式及預算，不影響來源抓取 |

`match` 必須有可供上述路由引用的 UUID 主鍵與 `(owner_id,id)` 唯一鍵。`expectedVersion` 對應 monitor 的 `filters_version` 之外獨立 row `version`（所有設定變更都增加），避免只切開關卻未被偵測。新增表的正式 migration 應將上述鍵落成 DB 約束。

所有 cookie 寫操作沿用 session、Origin、CSRF；身份由 session／OAuth scope 推導，不接受 body 指定 owner。MCP 首版提供 `monitors_list`、`monitors_get`、`monitor_matches_list`、`radar_notifications_list`（read）與 `monitors_check`、`radar_mark_read`（write）；建立／修改監測、AI 預算與外寄通知設定由網站本人操作。讀取工具不觸發搜尋或花費，也不能把 JD 中的指令當作 tool 授權。

每頁最大 100 結果，個人 10 組監測，來源數沿用全站 50 上限。通知、配對、監測與 AI 結果加入個人匯出；刪帳 cascade／撤 task，作廢仍在執行的 lease。新增個人表不得因共用來源而放寬既有 ACL。token、聯絡資料、使用者完整搜尋文字與文件內容不進入一般 log；只記 resource id、狀態與受控錯誤碼。

## 6. AI 分工與成本

- 抓取、內容 hash、去重、排程、明確條件比對與站內提醒不呼叫 LLM。
- AI 只分析已通過條件且使用者啟用的候選。輸入限這筆 JD 和必要的已確認 career facts，按 `(owner, JD version, career revision, model policy)` 快取；不同使用者不共用個人分析。
- 回覆為「符合項／需補充的資訊／可能缺口／引用證據」。不知道的能力記為未知，不判定缺乏；不輸出虛構成功率或擅自補經驗。
- MCP 模式建立 `waiting_client` 工作，由已連線助理明確取得並寫回。沒有客戶端時 UI 仍顯示規則結果；不偷偷切換平台或使用者 API key。
- BYOK 模式沿用原子 token reservation 與模糊失敗結算。預設 AI 上限 10 筆／UTC 日／使用者，所有監測共用；這是額外筆數上限，不替代現有 token 上限。0 代表停用。
- 修改經驗後，舊分析標示「基於舊版經驗」，不能當作新履歷的證據；重新分析是明確操作或已開啟且仍有預算的背景任務。

## 7. 通知與群組的分階段交付

首版只建立站內通知，不寄信、不送桌面推播。第二階段的 Email 每日摘要需要本人選擇且驗證收件地址，包含可取消訂閱設定、時區和固定摘要時段；按 UTC 儲存時點，夏令時間重複／跳時使用穩定 digest id 去重。跨監測的同職缺仍只列一次。

Email 使用 transaction outbox，發送時再次核對 opt-in、監測 generation、通知是否仍可見及使用者是否已刪除。供應商支持 idempotency 時傳 digest key；不支持時，送出後斷線記 `delivery_unknown`，先查供應商狀態，不宣稱一定只寄一次或盲目重寄。站內「已產生」、Email「服務商已接受」、使用者「已讀」分開記錄。

群組監測第二階段新增獨立 group-scoped 設定與 cursor，不把群組監測掛在某人的私人監測 row。owner／admin 可編輯公开來源及條件，成員自行訂閱提醒；退組即撤存取及待發通知。群組只保存公開職缺與共用篩選；每位成員的匹配理由、career facts、履歷、申請與 AI 用量各自保存。未分享進度顯示未知，不能讓組長看到私人未投清單。

## 8. 部署、容量與验收

先在隔離資料庫驗證 migration 與新 collector，再執行正式發布。設定獨立旗標 `RADAR_MATCHING`、`RADAR_AI`；外寄另有 `RADAR_EMAIL`，預設關閉。個人监測必須同時滿足功能旗標和 `radar_capture_state.ready=true` 才能 claim／publish。

正式切換有明確的短暫寫入屏障：暫停並排空所有 CareerOS 舊 collector writer（目前由 CareerOS worker 執行），確認已無舊程序可發布；其他同機服務照常運作，網站維持提供最近清單與排隊手動要求。將 capture gate 設 false、epoch 遞增，作廢舊來源 lease，再在每來源鎖下回填現有清單版本、水位與初始化欄位。有 `last_success_at` 的既有來源回填為已初始化，即使最後 feed 為空；從未成功抓取的來源保持 NULL。部署相容 web／worker 後確認新 feed 同交易产生版本與事件，才設定 gate ready、開始個人 baseline 與後續增量。不能讓舊 collector 在回填與切換間更新只有 catalog_jobs、沒有事件的資料。

日常停用雷達只關閉 matcher／通知，保留相容 collector 的事件捕捉與共用抓取。若必須回退到不產生事件的舊 collector：先把持久 capture gate 設 false、epoch 遞增、作廢所有雷達 lease／待發通知，再排空／替換 collector。共用清單可以恢復抓取，但雷達明確顯示不可用。後續升級重新執行寫入屏障與回填，所有受影響 cursor 記 `history_gap` 並重建基準；原私人去重紀錄保留，不宣稱回退期間完整監測。資料庫還原同樣先關 gate，不重播任何投遞。

首版共用既有 PostgreSQL 和部署容器，不新增常駐瀏覽器。新增 matcher 以有界批次輪流執行，不能掃完所有監測才處理既有私人工具任務。目標單批 500 事件、每圈一批，配對 lease 3 分鐘並定期續租；任務超時可從已落盤頁接續。來源仍依現有退避與 cooldown，頻率不得由個人監測倍增。容量數字是初始限額，發布前須在主機現有資源上量測。

| 驗收 | 必須證明的結果 |
| --- | --- |
| R01 | 首次建立包含 100 舊職缺的監測：可看 baseline、0 新通知；建立過程中 commit 的第 101 筆在增量 run 提醒一次 |
| R02 | 相同 feed 重跑、worker 崩潰後重跑、兩 worker 搶同 run：同職缺不重複配對／通知；以真實 PostgreSQL 測 race |
| R03 | 不同來源 commit 亂序、同來源 rollback、分頁中斷：cursor 沒有跳過未完成事件，沒有跨來源全域水位漏失 |
| R04 | A 同時命中兩監測、B 命中同職缺：A 合併提醒，B 有自己的提醒；A 已讀／略過／已投不影響 B |
| R05 | 修改／暫停監測及停用來源與 publish 並行：舊 lease／generation 無法發新結果與通知；恢復不雙投 |
| R06 | 限流、超時、部分 feed、完整空 feed：狀態可區分；僅完整成功可標 not_listed，均不誤稱雇主已關閉 |
| R07 | 新來源、改條件、事件保留期外恢復：分別建立基準；過期顯示 history_gap；無舊職缺通知洪水 |
| R08 | 相同 URL 跨来源不重複提醒；同職稱不同 requisition 不合併；未知市場、薪資、簽證不自動補答案 |
| R09 | 人工補登已投及結果未知的申請被正確排除可再投清單；歷史私人履歷與申請快照不被公開 JD 更新覆寫 |
| R10 | 未連 MCP、key 無效、10 筆限額及 token 上限競態：監測照常完成；AI 狀態可解釋，不改用平台額度 |
| R11 | API/MCP 跨 owner、唯讀 scope 寫入、CSRF、封存／刪帳、export：隔離與撤銷通過；返回資料無 lease／私密值 |
| R12 | 真實 worker → DB → API/MCP → 兩個瀏覽器帳號；桌面及 390px 手機走完建立、提醒、收藏、接回履歷；不靠 mock 成功文案 |
| R13 | 隔離環境使用可控 feed 驗證新職缺／變更，另對已支援真實來源做一次唯讀 smoke；不為雷達測試向真雇主提交履歷 |
| R14 | 發布前後比對同機其他容器的 ID、啟動時間、restart count、health；負載有界、原任務可繼續，清除測試資源 |
| R15 | Email／群組後續開啟前另驗：退訂／退組／刪帳與發送競態、timeout unknown、夏令時間與重複摘要、非分享狀態未知 |
| R16 | 清掉 180 日通知歷史後，另一來源晚收錄相同 URL、重建監測或來源改網址：持久首次配對紀錄仍阻止重複首次提醒 |
| R17 | 舊 collector 發布與回填切換競態、回退舊 collector、重新升級：寫入屏障／capture epoch 生效；缺事件期間停雷達並顯示 gap，無靜默漏資料 |
| R18 | 監測早於來源首抓建立；首抓失敗／部分／完整空／100 筆：waiting_source 正確，首次成功樣本不產生通知洪水，之後新增才提醒 |

監測指標：來源最近成功距今時間、到期配對排隊時間、cursor 落後量、history gap、單批耗時、新增／被去重通知數、AI 筆數及 token、資料表成長量。逾期目標先設為「排定檢查時間後 10 分鐘內開始配對」，並在驗收量測；這不保證職缺發布後 10 分鐘就收錄，因來源覆蓋與刷新頻率仍有限。

## 9. 實作落點與本次完成範圍

擬新增 `server/job-monitors.ts`、`web/job-monitors.tsx`、`tests/monitor-e2e.ts` 及 additive migration；修改 `server/catalog.ts` 的交易事件發布、`server/worker.ts` 排程、MCP 註冊及帳戶匯出。前端嵌入既有找職缺頁，沿用現有樣式與 session，不另建第二套登入或假資料展示。

**本次交付的是可實作的設計文件與獨立設計審查，不包含個人雷達的程式、Figma 新畫面、來源新授權、部署或實測通過宣稱。** 已有的共用抓取不重做；LinkedIn／公司註冊測試的使用者接手阻擋，也不因這份設計而視為解決。

獨立審查發現的三项 P2 與複查結果，見 [JOB-RADAR-DESIGN-REVIEW.md](JOB-RADAR-DESIGN-REVIEW.md)。
