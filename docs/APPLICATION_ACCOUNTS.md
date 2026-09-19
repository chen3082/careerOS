# 投遞前登入與公司帳戶設計

狀態：2026-09-19 已實作網站授權、帳戶準備列表、MCP 接手與驗證續接。需要使用者連接具備瀏覽器工具的 AI 客戶端；CareerOS 不自行啟動雲端瀏覽器。真實雇主註冊尚未驗收，正式 LinkedIn／104 投遞仍未開通。Google 登入僅用於 CareerOS 身分，不會因此登入求職平台或授權 Gmail。

## 參考的實際產品

- [Simplify Copilot](https://help.simplify.jobs/articles/2415391-using-copilot-to-autofill-applications)：使用者開啟申請頁，工具填表，使用者檢查後自行提交。
- [Simplify Autopilot](https://help.simplify.jobs/articles/1784339-getting-started-with-autopilot)：獨立的代投流程，只支援部分招募系統；使用前列出姓名、聯絡方式、地區、LinkedIn、工作權與預設履歷。當前文件表示不確定答案時停止，不猜測。
- [Teal](https://help.tealhq.com/en/articles/9524931-bookmarking-a-job)：可先保存職缺再追蹤申請；保存職缺不等於對外投遞。
- [Broadcom 招募網站](https://broadcom.wd1.myworkdayjobs.com/en-US/External_Career/job/Principal-Engineer_R026289)：明確要求新候選人先建立帳戶，既有候選人先登入。這是公司招募入口，不是 CareerOS 帳戶。

## 使用者流程

1. 首次使用：CareerOS Google／Email 登入 → 個人資料與經驗 → 聯絡方式、履歷、工作偏好。先告知外站可能要登入／註冊，不要求一開始就替所有公司註冊。
2. 選定具體職缺：顯示實際公司、招募網站、申請模式、使用的 Email，以及目前可驗證的狀態。沒有 browser runner 的觀察，顯示「尚未檢查」，不能因為點過連結就顯示已連接。
3. 檢查帳戶：不需要帳戶→直接準備；已登入且確認身分→沿用；未登入→登入；無帳戶→協助註冊。帳戶已存在時轉登入／復原，不重複建立。
4. 協助註冊：只為本次選定職缺需要的招募入口建立帳戶；先顯示公司、網域、使用的 Email、預計送出的資料與站方條款。一般欄位可由已確認資料填入，必要的本人確認保留在頁面。
5. 驗證接手：等待驗證信／簡訊、CAPTCHA、MFA、密碼或條款處理時，清楚列出待辦與原站入口。未經另外授權不讀取整個信箱、不繞過驗證、不把缺少的工作權資訊填成肯定答案。
6. 回到原任務：確認站方帳戶建立成功與目前登入身分，再恢復同一個申請草稿。註冊成功不等於履歷已送出。
7. 檢查 PDF 與答案→取得此次申請授權→送出→驗證站方收件證據。沒有確定回條時顯示結果待查證，保持防重投紀錄。

## 狀態與資料邊界

已實作狀態：`waiting_client → working → login_required / registration_required / awaiting_email / awaiting_phone / captcha_required / password_required / terms_required / external_login_required / account_ready / no_account_needed / unsupported`，另可 `cancelled`。網站恢復會重新授權並回到 `waiting_client`，必須重新領取；不是直接改成登入成功。

職缺 URL 分類只提供預期需求，初始顯示尚未檢查。`account_ready` 是已授權 AI 客戶端回報的可見 Email 觀察，並非伺服器獨立驗證的 browser attestation，亦非持續有效的 session。UI 顯示「助理回報已登入」及觀察時間，真正投遞仍需重驗。

帳戶以 `(owner, provider, verified_origin, tenant, candidate_email)` 定位；不能把所有 Workday 網站視為同一個可共用帳號。公司／租戶必須由受信任 adapter 解析，不能直接採用職缺描述中的指令或任意重新導向。

資料庫只保存帳戶協助狀態、姓名／Email、授權範圍與 24 小時 TTL、觀察時間、事件及內部 claim；密碼、Cookie、OTP 不進入模型 prompt、MCP resource、履歷、截圖報告或一般 log。優先使用使用者自己的受控瀏覽器與密碼管理器；若需要託管 vault，須另做隔離、撤銷、輪替、刪除和部署驗收。

帳戶協助有持久 run ID、版本與單一領取權。網站取消、恢復、過期與職缺變更會讓舊 claim 失效。MCP 不能自行建立／擴大網站授權；只能列出、領取、讀 context、回報。每次瀏覽器動作前應重新讀 context。已開始的外部操作無法由資料庫回溯取消，助理恢復時必須先確認帳戶是否存在，不能盲目重播；此協定不保證外站 exactly-once 註冊。

## 使用方式

1. 「找職缺」或「投遞中心」→「登入／註冊準備」。LinkedIn／104 必須為單一職缺，動態牆或公司首頁不能建立任務；另支援部分 Workday、Lever、Greenhouse 職缺 URL 格式。允許 URL 格式不代表已驗收該平台的自動註冊。
2. 指定申請人姓名、Email；勾選是否允許無帳戶時協助註冊，再確認此網站 24 小時授權。
3. 將畫面提供的任務指令貼到已連接 MCP 且具備瀏覽器工具的 AI 對話。流程：`account_setup_list → account_setup_claim → account_setup_get_context → account_setup_report_observation`。
4. 助理檢查原站、協助填寫姓名／Email。密碼、验证码、Email／手機驗證及條款交给使用者在原站完成；跨 origin 登入也是本人接手，不把個資填到未授權網域。
5. 回網站點「已完成，請助理再檢查」，再讓助理讀取新任務，先確認是否已有帳戶，再繼續。進度保存在「網站帳戶準備」。

MCP server 本身沒有瀏覽器；缺少瀏覽器工具的客戶端必須回報 unsupported。這種接法不會消耗伺服器的 Anthropic／OpenAI API key；客戶端本身的訂閱／用量依其方案處理。

實作驗收使用 `tests/account-setup-e2e.ts` 的真實 MCP OAuth/PKCE、PostgreSQL 與 Chromium；所有外網請求被阻擋，不向真實公司建立假帳戶。獨立 review 與修正見 [ACCOUNT-SETUP-REVIEW.md](ACCOUNT-SETUP-REVIEW.md)。

## 正式開通前尚需完成

- 使用者實際 MCP／瀏覽器工具連接驗收；若要雲端全自動，需另做受控 runner 配對、session 隔離與 credential vault。
- LinkedIn Easy Apply／104 真實表單 adapter，包含平台履歷選擇和收件回條。
- 公司招募系統的專用帳戶 adapter 與本人帳戶實站驗收；驗證接手 UI 已完成，不能據此宣稱所有站點可自動註冊。
- 真實使用者選定的職缺與本人確認履歷驗收；假履歷只交給隔離 receiver，不能寄給真公司。
- 獨立持久 journal 與跨主機恢復；本機 marker 測試不替代已延期的異地備份門檻。
