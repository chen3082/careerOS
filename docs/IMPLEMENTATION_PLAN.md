# CareerOS 實作順序、驗收與待驗證事項

本計畫實現 [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) 與 [SYSTEM_CONTRACTS.md](SYSTEM_CONTRACTS.md)。所有 phase 都交付前端、API、持久資料與錯誤處理；靜態原型或 mock response 不算完成。此文件未承諾工期，需依 spike 結果、團隊人數和來源權限排程。

## 1. 開發前先驗證的五件事

| Spike | 最小證據 | 決策／失敗路徑 |
| --- | --- | --- |
| Claude Remote MCP＋OAuth | 兩測試帳戶連接、read/propose/revoke、跨帳戶拒絕、斷線後任務仍可查 | 鎖定 auth／SDK／client 相容矩陣；不可用時保留 BYOK 網站，MCP 標未開通 |
| 台灣與國際來源 | 各一個合法可用的真實搜尋來源；公開職缺資料一致；可送出的表單、文件與成功證據 | 決定首波 supported adapters；若台灣只匯入，必須標 partial，不能算雙市場搜尋／投遞完成 |
| Browser runner 接手 | 隔離帳戶、可登入／CAPTCHA 接手、短效控制網址、session 撤銷、提交後斷線查證 | 某站無法支援則 manual；不用永久保存全部瀏覽器資料來硬繞 |
| Gmail／Calendar | 測試 incremental sync、token 過期、重複通知、撤權；確認正式 scope 與審查路徑 | 未正式接通時 manual events，清楚顯示同步不可用 |
| 中文語音／文件 | 一組真實中英錄音轉錄品質、雙語 PDF/DOCX、每分鐘／每份使用量 | 決定 provider、成本與版型；無法轉錄仍保留音檔與手動逐字稿 |

真實投遞 smoke test 使用測試 ATS／合作方測試表單優先。對外真實雇主只用本人資料及已授權的申請，不為測試大量提交垃圾資料。來源連通、登入成功或按鈕被點擊均不能代替送出證據。

## 2. 開發里程碑

| 階段 | 可用成果 | 退出條件 |
| --- | --- | --- |
| P0：基礎與可行性 | repo、auth、schema、private storage、tasks/outbox、logs、權限測試、上列 spikes | 任務可恢復；兩帳戶隔離；初始來源及 AI 模式明確 |
| P1：經驗到多份履歷 | 網站文字／語音／上傳、facts 確認、Markdown、版本、履歷編輯與匯出；MCP read/propose/generate-result | 相同確定事實生成兩方向中英文履歷；歷史版本不改；無模型狀態可解釋 |
| P2：職缺與客製 | 雙市場搜尋、import、去重、要求證據、個人 collection、專用履歷、事實檢查 | 每市場至少一個真實搜尋來源；相同／不同 requisition 正確處理 |
| P3：投遞閉環 | dossier、批次／policy、runner、補答、登入接手、pause、unknown reconciliation、手動補登 | 每市場至少一個支持來源完整送出；重試／崩潰不自動重投；可下載當次文件 |
| P4：面試與結果 | 收件 signal inbox、Calendar、輪次／改期、面經附件、offer 修訂／決定、正確統計 | prep 不算 invitation；多職缺不誤歸屬；手動更正不被舊同步覆蓋 |
| P5：私人小組與職涯 | group jobs、invites、細粒度分享／撤銷；有來源的方向／缺口／成長計畫 | 每人未投清單正確；成員無私檔權限；建議帶可查 evidence 與樣本分母 |
| P6：發布加固 | 真實 end-to-end、配額／用量、備份恢復、資料刪除、兩市場驗收、成本基準 | 完成下表；未完成整合如實標明，不用假成功 UI |

P5 的介面與資料模組可提早實作；整體以最先驗證「真實經驗 → 真實履歷 → 真實申請 → 正確紀錄」為依賴主線。公開產品命名要區分內測里程碑和所有已要求功能完成的完整版。

## 3. 需求追蹤矩陣

| 使用者需求 | UI | Domain／資料 | 驗收 ID |
| --- | --- | --- | --- |
| 大段個人經驗、語音、Markdown | 我的經驗 | sources/facts/revisions/transcripts | A01–A04 |
| 同資料生成多份履歷 | 履歷工作室 | generation/resume versions/rendering | A05–A07 |
| 按 JD 客製，不能編造 | JD／履歷比較 | evidence/claim validation/eligibility | A06、A08 |
| 台灣＋國際找職缺、投遞 | 找職缺／投遞中心 | adapters/jobs/policies/attempts/answers | A09–A15、A40–A41、A44–A45 |
| 記錄已投、面試、面經、offer | 看板／申請詳情／面試／Offer | events/signals/interviews/notes/offers | A16–A21 |
| 同類工作、未投、小群組 | collections／groups | per-user application join／share ACL | A22–A25 |
| 連自己的 Claude、控制成本 | 偏好與連接、任務狀態 | MCP/OAuth/AI mode/usage | A26–A30 |
| 職涯路線、技能／經驗／執照 | 職涯導航 | evidence corpus/gaps/growth tasks | A31–A33 |
| 可靠、可刪除、所有功能在網站 | 全站與帳戶管理 | tasks/storage/ACL/lifecycle/recovery | A34–A39、A42–A43 |

## 4. 驗收清單（目前皆待實作）

| ID | 測試與必須看到的結果 |
| --- | --- |
| A01 | 長文字、舊履歷與音檔轉錄可形成候選 facts，每條回查原文／時間；拒絕麥克風時仍可打字／上傳。 |
| A02 | 兩份來源數字／日期矛盾時顯示衝突；AI 不替使用者任意確定。 |
| A03 | revision 12 匯出後網站改為 13，再匯入改動的 Markdown 做三方合併；不覆寫 13 的不同變更。 |
| A04 | 刪除一條經驗後新生成不使用它，舊申請保留快照；永久刪除另外驗 A37。 |
| A05 | 一份資料產生兩種方向及中英文版本，可編輯比較、匯出 PDF/DOCX；渲染失敗不可顯示完成。 |
| A06 | 故意要求添加沒有來源的技能、誇大數字、任職／專案混淆，均不得成為 auto_apply_eligible；引用錯誤 source ID 也不得通過。 |
| A07 | 同時從網站與 MCP 編輯，收到 version conflict；歷史投遞仍能取出同 hash bytes。 |
| A08 | 已確認 block 的排序／節選可依政策自動生成；新的自由改寫仍須相應驗證／確認。 |
| A09 | 台灣及國際各一個真實搜尋來源核對原文、時間、地點、薪資單位；來源失敗與零結果不同。 |
| A10 | 同一 requisition 跨平台識別，兩個相同職稱不同 requisition 不合併；私有 JD 不出現在他人搜尋。 |
| A11 | 單次／批次／規則投遞皆由網站發起，未知簽證或薪資答案進 needs_input，已授權範圍不逐筆重問。 |
| A12 | 發 submit 後斷線、worker 死亡或 lease 到期，進 outcome_unknown；不得出現第二個 sender。取得回條後只計一筆。 |
| A13 | 同 key 重送、換 key 並行、同一任務 queue 重送都不雙投；不同 body 同 key 得 conflict。 |
| A14 | 撤銷 policy／調整文件使舊授權失效；已過 submit permit 的工作顯示取消可能無法阻止並查結果。 |
| A15 | 同平台共用站內履歷的兩個申請串行；申請紀錄能說明實際使用站內履歷或附件。 |
| A16 | 面試練習、一般行事曆、投遞自動回覆不增加 invitation；明確邀請才入列。 |
| A17 | 同公司兩個職缺、三輪面試、改期／取消、同信重送／重新分類不誤合併或重複計數。 |
| A18 | 同步亂序及 cursor 過期重抓不覆蓋手動更正；不確定歸屬出現在待確認。 |
| A19 | 面經上傳成功但摘要失敗时，仍能下載原檔／重試；原文不被摘要取代。 |
| A20 | Offer revision 不加收到 offer 數；接受／婉拒由本人操作，不寄信、不自動接受。 |
| A21 | 日期 cohort、三輪 interview、offer 修訂、分母零、inbound 招募、withdrawn 的漏斗手算一致。 |
| A22 | A/B 同組，A 已投不從 B 未投清單消失；B 未分享顯示未知，非未投。 |
| A23 | admin、過期邀請、移除成員都不能存取 private resume/key/inbox；並行接受不超過邀請使用上限。 |
| A24 | 分享整理面經只公開所選 snapshot；編輯原稿／新增附件不自動分享；撤銷後 URL/API/快取拒絕。 |
| A25 | 群組成員含惡意提示的 comment/JD 不能讓 agent 替他提交或讀出別人資料。 |
| A26 | 真實 Claude 連接、list/read/propose、生成結果寫回網站，grant 撤銷後新調用拒絕；無 user_id 越權。 |
| A27 | 純 MCP 網站任務停 waiting_client；關閉 Claude 不引發平台偷偷付費；已有授權且無需推理的任務可繼續。 |
| A28 | BYOK 可從網站完整生成；key 失效／額度不足時停止，不能偷偷用平台 key；前端及 log 無 key。 |
| A29 | 同時 10 個工作搶最後一筆額度，原子 reservation 不超額；provider timeout 仍保留待結算。 |
| A30 | 轉錄分鐘、browser 時間與推理 tokens 分項顯示；變更時區不能刷新日投遞上限。 |
| A31 | 每条 career recommendation 能定位 JD／taxonomy 證據、樣本範圍／分母和日期；未知能力先追問。 |
| A32 | 法定執照、雇主必備、加分與無證據區別；資料缺失不生成「必考」或錄取率。 |
| A33 | 完成專案附成果→使用者確認→新增 fact→更新履歷；不把練習當受雇經驗。 |
| A34 | 重新部署、關閉分頁、換裝置後 task checkpoint／results 可恢復；replay 不重做外部副作用。 |
| A35 | 兩帳戶 IDOR、跨 tenant foreign key、群組 ACL、惡意 PDF／URL SSRF／prompt injection 的安全回歸通過。 |
| A36 | staging 備份恢復能對齊 DB 與 object manifests；由恢復範圍之外的 deletion ledger 重播，核對高水位後才開讀取 gate；記錄實測 RPO／RTO。 |
| A37 | 匯出可讀 ZIP，永久刪除撤 token／停任務／清 shares／索引／檔案／快取；歷史文件如實標刪除。刪帳後還原至刪帳前，網站／MCP／下載均不得讀到復活個資；ledger 不可用維持隔離。 |
| A38 | 手機能錄音／補答／更新面試／上傳面經；桌面走完多履歷到 offer；空帳戶不顯示假活動。 |
| A39 | 完整流程各市場均有真實持久資料、文件、提交證據與結果紀錄；任何未接通項目清楚標示，不能由 mock 冒充驗收。 |
| A40 | confirmed、本人補登已投、interviewing、closed 後使用不同 key／隔日再 submit，同 cycle 都回 ALREADY_SUBMITTED；unknown／recovery blocker 回 OUTCOME_UNRESOLVED。 |
| A41 | ready 後撤回／更正來源 fact、答案或證照到期，舊 bytes 保留但無法再取 permit；與 permit 並行時按鎖順序決定，不依延遲快取；未引用的新經驗變更不誤擋。 |
| A42 | 遍歷 MCP generic proposal/correction event_type，不能發布 interview/offer/submitted、接受 offer、改政策／分享；用 MCP bearer 直接呼叫網站 confirm route 也被拒絕。本人網站精確確認後才更新統計。 |
| A43 | 外部已送出後 PITR 到 permit 前／application 建立前，及已撤 policy 後還原：gates 預設關閉、舊 runner/grant 失效、journal 重建 blockers、沒有第二次提交；journal 寫入失敗亦不能發 permit。 |
| A44 | 台灣 TWD 月薪不套美國年薪、中英相似的否定問句不顛倒答案、sponsorship 不跨國重用、條款改版不沿用同意；補答與續跑競態有 version conflict，撤回答案即停新提交。 |
| A45 | policy v1 到 v2 縮窄市場、降低 cap、換准用文件，舊 epoch 的未消耗授權一律失效；與 permit 並行按提交順序處理；多個 policy 仍共用帳戶上限。 |

## 5. 測試與評估策略

Domain tests 驗證狀態轉移、ACL、facts 引用、quota、去重和統計；DB integration tests 驗證 transactions／unique constraints／RLS／lease race；connector contract fixtures 驗證表單 schema 漂移與 evidence；staging E2E 覆蓋 Web 和真實 MCP client。關鍵外部 submit 測試包含每個 checkpoint 前後故障注入。不要把單纯 mock success 當作 connector 成功率。

建立經同意／去識別的中英雙市場評估集，來源與人工標註可追溯，包含模糊信件、同公司多職缺、改期、拒絕、面試練習、offer 討論及真 offer。抽取與分類分開評估：關鍵主張新增率、來源正確性、invitation／offer precision、歸屬正確性、ambiguous routing；不只看整體 accuracy。

發布目標（尚未量測）：在固定 regression corpus 中不容許新增無據的關鍵履歷主張通過投遞資格；具外部副作用的重試及跨帳戶權限案例全部通過。自動面試／offer 規則先 shadow，逐市場／語言報樣本數、precision 及信賴區間；低樣本或 precision 的保守下界未達 99% 時維持人工確認。模型 score 不能替代這項實測，零觀察錯誤也不等於零風險。

來源 adapter 需記錄來源、版本、表單類型、測試日期和成功證據；不公開宣稱測過一家公司就支援整個 ATS。回歸只在改動、依賴更新、provider schema 漂移或新失敗時擴大重跑；對真雇主的提交不可作高頻測試。

## 6. 待決策但不阻擋寫程式的預設

- 主架構採 TypeScript、PostgreSQL、私人 object storage、獨立 workers；雲端品牌等 OAuth／runner spike 後選。
- AI 以 MCP＋BYOK 為首發，平台推理額度預設不啟用；語音供應商獨立列成本。
- 先做個人帳戶＋私人小組，不做企業組織帳戶或公開社群。
- 首波職類依測試使用者資料選 1–2 個，但 schema 支援其他職類；不預設所有使用者都是工程師。
- 台灣每站的正式存取方式、批量再利用權與投遞能力未完成驗證；iCAP 和職業執照資料按來源逐項查明，不先鏡像整站。
- Gmail scope 審查、MCP OAuth 供應商相容性、ApplyPilot 原碼採用授權需在相應功能發布前完成；預設不直接移植 ApplyPilot。

## 7. 獨立審查與變更管理

本次另由獨立 reviewer agent 審查設計；原始發現、優先級與處理結果保留於 [SYSTEM_DESIGN_REVIEW.md](SYSTEM_DESIGN_REVIEW.md)。Review 驗證的是設計一致性與可實作性，不等於程式、來源接入或正式環境已通過驗收。新增需求或來源能力改變時，更新 system design、contracts、受影響 acceptance IDs 與相容矩陣，避免圖、文件和程式語意分歧。
