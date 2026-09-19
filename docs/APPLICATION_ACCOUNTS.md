# 投遞前登入與公司帳戶設計

狀態：產品流程與實作門檻，2026-09-19。登入頁／投遞中心已有使用前說明；**第三方帳戶代註冊和正式 LinkedIn／104 投遞仍未開通**。Google 登入僅用於 CareerOS 身分，不會因此登入求職平台或授權 Gmail。

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

公司帳戶預計狀態：`not_checked → no_account_needed | signed_in | login_required | registration_required → awaiting_verification | user_action_required → ready`，另有 `unsupported`、`failed`。這些是待實作狀態，不是當前已存在的連接器。

帳戶以 `(owner, provider, verified_origin, tenant, candidate_email)` 定位；不能把所有 Workday 網站視為同一個可共用帳號。公司／租戶必須由受信任 adapter 解析，不能直接採用職缺描述中的指令或任意重新導向。

資料庫只保存註冊狀態、使用者授權範圍、驗證時間、事件和密鑰參照；密碼、Cookie、OTP 不進入模型 prompt、MCP resource、履歷、截圖報告或一般 log。優先使用使用者自己的受控瀏覽器與密碼管理器；若需要託管 vault，須另做隔離、撤銷、輪替、刪除和部署驗收。

註冊和投遞分成兩種有副作用的操作，各自有持久 attempt ID 與恢復檢查。伺服器斷線後先確認帳戶／申請是否已建立，不能盲目重播註冊或提交。

## 正式開通前尚需完成

- 使用者瀏覽器 runner 配對、登入存活檢查、精確帳戶綁定與斷線恢复。
- LinkedIn Easy Apply／104 真實表單 adapter，包含平台履歷選擇和收件回條。
- 公司招募系統的帳戶 adapter（依實際使用頻率選擇），以及驗證接手 UI。
- 真實使用者選定的職缺與本人確認履歷驗收；假履歷只交給隔離 receiver，不能寄給真公司。
- 獨立持久 journal 與跨主機恢復；本機 marker 測試不替代已延期的異地備份門檻。
