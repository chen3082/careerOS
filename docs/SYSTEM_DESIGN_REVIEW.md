# CareerOS System Design 獨立審查

審查日期：2026-09-18（美西）。Reviewer：獨立 `system_design_review` agent。

審查基準為 SYSTEM_DESIGN.md、SYSTEM_CONTRACTS.md、IMPLEMENTATION_PLAN.md 的 1.0 初稿，另對照 WEB_PRODUCT_SPEC.md、GROUPS_PRODUCT_SPEC.md、CAREER_GUIDANCE_DATA_PLAN.md。以下行號指審查時的初稿，後續修訂會使行號位移；同時保留段落與關鍵字供定位。這是設計／契約審查，沒有執行尚不存在的應用程式，也不代表來源接入、安全或正式環境驗收完成。

## 結論

架構方向可行，需求範圍完整；未發現必須推翻 MCP＋BYOK、模組化單體或獨立 runner 的理由。發現 **4 項 P1、2 項 P2 契約缺口，沒有 P0**。這些是需要在實作前明確化的狀態與授權規則，不是聲稱已有運行中的漏洞。尤其是「防重」必須同時涵蓋成功後的新請求、資料庫還原，以及原始事實或授權變更。

本節以下保留原始審查意見；主線可在文件末尾另加修正處理結果，不覆寫原始發現。

## 原始 Findings

### F01 — P1：已確認送出後，新的 submit intent 缺少明確拒絕條件

**位置：** SYSTEM_CONTRACTS.md:63、67、92、205、241；SYSTEM_DESIGN.md:173–179；IMPLEMENTATION_PLAN.md:60–61。

`unique(owner, job_id, cycle_no)` 保證一個邏輯申請，`同 application 至多一個未結案 submit intent` 保證同時只送一次，但契約沒有明寫：既有申請已 confirmed 或明確手動补登已投後，即使先前 intent 已結案、新 idempotency key 不同，也不得再建立可送出的 attempt。Attempt 狀態圖的 confirmed 沒有出邊，仍無法阻止為同 application 建立第二個 attempt。

**可重現場景：** A 的申請成功並結案 intent → 隔日 MCP／批次任務以另一個 key 再呼叫 applications.submit → application 唯一鍵仍沿用 A、目前沒有 active intent、policy／配額仍有效 → 按已列出的 guard 都可通過，導致同一申請週期再投一次。這也可能發生於 client 遺失回應後錯用新 key，而不是同 key 的重試。

**影響：** 外部重複提交，且統計仍只顯示一個 logical application，容易掩蓋實際重投。

**建議修正：** 在 application lock 下，先查有效 submitted event／confirmed receipt／manual reported submission 及 unresolved attempt；任何已投狀態直接回 ALREADY_SUBMITTED 和既有申請資訊，未查明狀態回 OUTCOME_UNRESOLVED。只有明確證據判定未送出的 safe retry，或本人確認的新招聘 cycle，才可取得新 permit。不要依 current projection 判斷，因為 interviewing／closed 的申請也可能已投。新增驗收：confirmed 後不同 key、隔日重試、manual 補登後規則任務、closed 後同 cycle submit，均不能再送。

### F02 — P1：撤回或更正事實，沒有使既有履歷／待提交 dossier 的資格失效

**位置：** SYSTEM_DESIGN.md:99、109、119、123–129、175；SYSTEM_CONTRACTS.md:52、56、65–66；IMPLEMENTATION_PLAN.md:52、62。

目前只明確要求刪除 fact 後「後續生成」不再使用、歷史快照不變；resume eligibility 又來自已核准 block，policy 綁定舊 fact revision。沒有定義一個已確認 fact 被撤回、判為錯誤，或其有效期屆滿時，已存在的可自動投遞文件是否被停用，以及 submit permit 如何查最新撤回狀態。

**可重現場景：** revision 12 中「持有某執照」已核准，建立 ready resume／dossier 並加入規則佇列 → 使用者發現填錯，於 revision 13 將該 fact 撤回 → 系統按要求讓新生成不再引用，但舊 resume bytes、block 確認與 policy revision 仍完整 → worker 仍可送出舊錯誤主張。

**影響：** 使用者已更正的錯誤仍會被自動對外提交。固定歷史內容與固定未來提交資格被混在一起。

**建議修正：** 明確分開 immutable content 與 mutable current eligibility。保存 fact/block 依赖與撤回／失效資訊；撤回、實質更正或證照到期時，使引用該版本的未提交 dossier 進 needs_review，必要時撤銷相應授權。每次 permit 發出前在交易內檢查當下 eligibility，不能只相信建立時的 ready 布林。已送出的歷史文件不改寫；一般新增經驗也不應無差別讓所有舊文件失效。增加「排入後撤回來源，再要求提交」及「失效與 permit 並行」驗收。

### F03 — P1：MCP 的通用 manual event 工具可繞過 interview／offer 的 proposal 邊界

**位置：** SYSTEM_CONTRACTS.md:126、146、181–184；SYSTEM_DESIGN.md:218–224、300；IMPLEMENTATION_PLAN.md:64、68、74。

`interviews.propose`／`offers.propose` 明確只產生候選，也說不提供自動接受 offer 的工具；但 `applications.record_manual` 接受未列白名單的 event_type，直接回 user_reported event。只禁止冒充 Gmail／runner 並不能禁止模型透過這個通用入口寫入 interview.invited、offer.received 或 offer.accepted。`source=user_reported` 不足以證明本人已確認該項事實。

**可重現場景：** 使用者要練習面試，或 JD／面經帶有誤導內容 → 模型沒有呼叫 interviews.propose，改用 applications.record_manual(event_type=interview.invited) → 若 domain 按現在工具表接受事件，面試數與看板立刻更新。相同路徑也可繞過 offer 的決策限制。

**影響：** 面試練習被記為實際邀請、獲得或接受 offer 被誤記；前面精確設計的來源與確認區分失效。

**建議修正：** 列出每種 actor/channel 可寫的事件白名單與確認方式。MCP 的補登預設產生 manual-event proposal，經網站明確確認才計入統計；若支援從 Claude 直接確認，必須有服務端可驗證、綁定確切候選的 user-confirmation 流程，不能由模型傳 confirmed=true。offer 接受／婉拒、投遞政策與分享等受保護操作不能經 generic event/correction route 繞過。網站明確補登仍可直接發布 user_reported，避免把所有手動操作都無謂加一道確認。增加遍歷全部 event_type 的 route／scope 越權測試。

### F04 — P1：PITR 還原會使已消耗的提交權限回到未消耗，恢復流程缺少副作用隔離

**位置：** SYSTEM_DESIGN.md:173–181、292、296；SYSTEM_CONTRACTS.md:241、253；IMPLEMENTATION_PLAN.md:82、84。

設計允許 DB RPO ≤15 分鐘，並有 PITR、manifest 與事件重放不做外部副作用的規則；但沒有處理「外部申請已成功，對應 permit／receipt 記錄被還原到成功前」的情況。禁止事件 replay 呼叫 submit 不等於禁止恢復後的普通 task worker 重新執行已回到 ready 的任務。

**可重現場景：** 10:00 備份中 task 為 ready、permit 未使用 → 10:05 外部提交成功 → 10:10 故障，還原至 10:00 → 一般 workers 重啟，從 ready 繼續，DB 不再知道先前成功 → 對不支援 idempotency 的表單再次提交。舊 runner 若尚存活，還可能與還原後 runner 同時操作。

**影響：** 即使平常 lease/CAS 設計全部正確，災難恢復仍會重投，甚至恢復本已撤銷的投遞政策。

**建議修正：** 定義 recovery quarantine：還原後預設禁止所有外部 submit，提升部署／授權 epoch、終止並隔離舊 runner，使舊 grant 失效；使用與還原 DB 分離的控制資訊標記恢復事件。對可能落在資料遺失窗或故障時仍在執行的任務，一律查證／needs_review；只有確認未送出且重驗現行授權的任務才恢復發送。若無獨立可信高水位，應擴大隔離範圍，不能猜哪些未送出。補「還原前已送但 receipt 不在恢復點」「還原後出現已撤 policy」的故障注入驗收。

### F05 — P2：可重用答案庫沒有資料／API 契約

**位置：** WEB_PRODUCT_SPEC.md「投遞中心」與「前後端分工與資料歸屬」；SYSTEM_DESIGN.md:129、175；SYSTEM_CONTRACTS.md:64、178；IMPLEMENTATION_PLAN.md:59。

原產品規格要求補答後存入情境相符的答案庫；目前 prepare 接受 answer refs，dossier 保存答案 snapshot，但資料字典沒有 answer_bank／answer_version，HTTP/MCP 也沒有補答及其重用範圍的契約。

**可重現場景：** 使用者為台灣職位填「期望薪資 80,000／月，TWD」，接著投美國職位遇「expected compensation」，或相同「是否需要 sponsorship」在不同國家出現。實作者無法依契約決定先前 answer ref 是否可重用，也沒有版本化失效規則。

**影響：** 前端補答／續跑不完整，或模糊配對使答案被錯誤跨市場、公司及問題語意重用。文件雖要求「情境一致」，尚未提供可落實的一致性鍵。

**建議修正：** 新增 answer_question／answer_version 或等價模型：原始問句、正規化語意、值及單位、適用市場／國家／雇主／職缺、事實來源、confirmed_by、有效期、允許重用範圍與撤回狀態；首次補答讓使用者選範圍，敏感／同意問題不得僅因文字相似而重用。dossier 凍結確切 question/answer 版本；補答 API 接 expected task version 與 idempotency key。追加中英同義問句、否定問句及跨市場單位驗收。

### F06 — P2：修改 policy 的舊版本是否仍可授權提交，需要單一明確語意

**位置：** SYSTEM_DESIGN.md:109；SYSTEM_CONTRACTS.md:65–66、179、241；IMPLEMENTATION_PLAN.md:62。

文件說 policy 版本不可變、每次重驗、暫停立即生效，但沒有明確定義同一 policy 多個版本能否同時 active，以及 `authorization.policy_version` 是否必須等於目前生效版本。單次 dossier 改動會使舊授權失效；規則改動未同樣明列。

**可重現場景：** v1 允許美國＋台灣，已有美國職缺排隊；使用者改成只找台灣的 v2 → v1 不可變、沒有 revoked_at，而 submit 只檢查 policy.enabled 和 v1 條件 → 舊工作仍可能送出。不同實作都能聲稱自己遵守「重驗 policy」，卻產生相反行為。

**影響：** 使用者縮小自動投遞範圍後，已有工作行為不一致。這是契約歧義，不主張現有文字已要求繼續使用 v1。

**建議修正：** 指定一個 active_version／policy authorization epoch；版本發布時原子替換並使舊未消耗授權失效，queued/preparing/ready 任務重新評估。submit permit 必須比對 authorization、dossier、當前 active version／epoch；已跨 submit 邊界者只查結果。若想支援多個獨立政策同時運行，應是不同 policy ID，不是同一政策的兩個「最新」版本。新增縮窄規則、降低 cap、改允許文件與並行 permit 的驗收。

## 已經做得足夠的部分

- Web／MCP 共用 domain 與持久資料，沒有把 MCP 當可窺看任意對話／檔案或自行喚醒 Claude 的通道；純 MCP 背景推理停 waiting_client，BYOK 失敗不靜默切平台 key。
- 分離 application、attempt、interview、preparation、offer、revision；unknown 不盲重試，fencing／permit 與外部 exactly-once 的限制有清楚承認。
- 履歷 provenance 不只保存假的 source ID；自由改寫需確認，已核准有限轉換可自動化，避免每一筆都重新要求授權。
- 使用者／群組 ACL、owner 複合外鍵、分享快照與附件 allowlist、撤銷的即時讀取檢查已覆蓋核心隱私需求；管理員不能代投或讀私有 key。
- 同步用 evidence inbox、cursor、去重與手動 override；練習不算面試、改期不算新輪、offer 修訂不灌高數字，inbound 與投遞 cohort 區分合理。
- 職涯方向建立在 dated sample、taxonomy 與個人證據；未知不等於缺技能、不把觀察數據寫成錄取概率或證照因果效果。
- 資料權利、來源支援程度、AI／語音／瀏覽器成本、帳號刪除與備份淘汰都有明確邊界。實作階段及驗收矩陣確實包含原始完整需求，而非只交一個 chatbot。

## 非阻擋的待驗證依賴

以下已明確列為 spike／發布條件，沒有當成「已完成」或本次新 finding：

- 真實 Claude client／OAuth／SDK／協定相容性，尤其 revoke 與兩帳戶隔離。
- 台灣及國際各來源的可用存取方式、正式搜尋、表單可自動填寫／提交範圍與成功證據。
- 遠端 browser session 登入、CAPTCHA 接手與站內履歷行為；不適用時 manual handoff。
- Gmail 正式 scope 審查、Calendar／Gmail 增量同步，以及模型分類所需資料傳送設定。
- 中文語音及雙語文件品質、provider 精確價目與 API 能力、實測用量後的商業方案。
- iCAP／職能與證照資料的再利用方式；ApplyPilot 原碼若採用時的授權評估。

待這些依賴有實證後，應更新 capabilities／相容矩陣和發布範圍；不需要因雲端品牌或精確模型尚未指定而停止 domain、schema、UI 與測試環境開發。

## 修正處理結果

獨立 reviewer 已回看 SYSTEM_DESIGN.md 1.1、SYSTEM_CONTRACTS.md 1.1 及新增驗收 A40–A45。以下 **closed 僅指設計契約已閉合**；尚未實作，沒有將驗收清單當成已執行的測試。以上原始 findings 與初稿行號完整保留。

| Finding | 主線修正與回看依據 | 相應驗收 | 結果 |
| --- | --- | --- | --- |
| F01 | 主設計 §9 與契約 §3、§7A、§8：在 application lock 下查整個 cycle 的有效已投證據；不同 key、隔日或已進 interviewing／closed 都回 ALREADY_SUBMITTED；unresolved／recovery blocker 阻擋再送。網站 correction 也不能直接抹去提交鎖。 | A40，補強 A12–A13 | **closed（設計層）** |
| F02 | 主設計 §6–7 與契約 dependency／validity_event／owner_eligibility、§8：immutable bytes 與目前 eligibility 分離；撤回／更正／到期直接影響依賴，permit 與更正共用鎖並查最新有效性，不等背景快取；已送歷史仍保留。 | A41，補強 A04、A14 | **closed（設計層）** |
| F03 | 主設計 §10、契約 §1、§4、§5–6：record_manual 改成 propose_manual_event，列 actor/event 白名單；credential_kind 由 middleware 決定，MCP bearer 不能呼叫網站 confirm／decision 偷渡。候選確認綁 payload hash，offer decision 使用專用命令。 | A42，補強 A16、A20、A26 | **closed（設計層）** |
| F04 | 主設計 §9、§16 與契約 §3、§8：journal durable ack 必須先於 permit，journal／control epoch 位於 primary DB 還原範圍之外；恢復先關 gates、隔離 runner、重建包含遺失 application 的 blockers，再逐帳戶對帳。所有舊 recovery_epoch 的單次／批次／規則授權均失效，須本人重新啟用；journal 不可用則 fail closed。付費 AI 另按 provider usage 對帳，不從提交 journal 推算。 | A43，補強 A34、A36 | **closed（設計層）** |
| F05 | 主設計 §7、契約 answer_question／answer_version／answer_proposal、§5–6、§8：新增答案版本、語意／極性／schema／國家／雇主／職缺／條款範圍、撤回及有效期；補答用 task version＋question hash；MCP 僅提案，未驗證問題映射不能自動重用。 | A44，補強 A11 | **closed（設計層）** |
| F06 | 主設計 §5 與契約 policy 字典、§8：同 policy 只有一個 active_version／authorization_epoch；發布或暫停使舊未消耗授權失效，permit 在相同鎖邊界重新比對；不同 policy 仍共享帳戶上限。 | A45，補強 A14、A30 | **closed（設計層）** |

回看另外要求補強刪除資料的恢復邊界：若 deletion ledger 與 DB 一起回滾，即使設計說「重播 ledger」仍可能讓已刪個資復活。主線已在 **主設計 §15、契約資料字典後段及 A36／A37** 明確指定：權威 deletion tombstones／高水位保存在 DB 還原範圍之外，DB 只存投影；先重播刪除、清分享／索引／快取並核對高水位，再開放網站、MCP、檔案下載與背景讀取；ledger 不可用時保持隔離。Reviewer 已核對這三處，這項追加提醒亦已 **closed（設計層）**，不改寫原始六項發現的數量或內容。

最終回看結論：F01–F06 均已補上可實作的 guard、狀態或授權契約與對應驗收，未發現修正引入新的重大矛盾。可以依實作計畫進入開發；第三方 spikes、故障注入、權限測試與真實來源驗收仍是後續發布條件，不能由本次文件 review 取代。
