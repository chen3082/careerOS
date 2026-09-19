# CareerOS 部署待辦

## 使用者已要求延後：GCP 私有 bucket 與異地備份

2026-09-18（美西），使用者指示「先記到 to-do list，之後再來搞」。

- [ ] 為 CareerOS 建立 private Cloud Storage bucket，設定 uniform bucket-level access 與 public access prevention。
- [ ] 給 VM／工作負載身分最小必要的 bucket 讀寫權限及合適 OAuth access scope；目前建立 bucket 回 403。
- [ ] 連接加密文件儲存、異地主機備份、提交 journal 及 deletion ledger。
- [ ] 35 天備份淘汰、刪除高水位、恢復先隔離再對帳流程。
- [ ] 實測備份還原、提交後斷線與還原後不重投，再開正式自動提交。

在以上完成前，`SUBMISSIONS_ENABLED=false`；網站必須清楚標示，不能把準備完成當成已送出。正式發布狀態與其他整合需求另見部署及驗收報告。

## 其他尚未交付／正式公開上線前的工作

- [ ] 104、Cake、Yourator 原生搜尋；目前可以手動匯入這些平台的職缺，企業公開 API 可搜尋台灣與美國職缺。
- [ ] 各站 autofill／submit adapter、使用者投遞規則 UI、表單接手、回條與 submission_unknown 對帳。資料表不是已完成的功能；自動送出目前不可啟用。
- [ ] Google 登入：2026-09-19 已套用使用者提供的 `GOOGLE_LOGIN_CLIENT_ID`，正式網站按鈕已確認顯示；仍需本人完成 Google 登入以驗收 Console origin／audience 設定。登入程式／合成身分測試與操作說明見 `GOOGLE-LOGIN.md`。
- [ ] 投遞前帳戶檢查、公司帳戶協助註冊、Email／手機／CAPTCHA 接手與恢復。產品流程見 `APPLICATION_ACCOUNTS.md`；CareerOS Google 登入不會自動登入外站。
- [ ] Gmail／Calendar OAuth client 設定、必要驗證、真實帳戶 acceptance；與 Google 登入分開，僅登入不會授權讀取信箱或日曆。
- [ ] 使用者 Anthropic／OpenAI key 的實際生成／語音品質驗收，以及 Claude／ChatGPT／Codex MCP 連接的使用者端驗收；HTTP MCP 已使用官方 SDK 實測。
- [ ] 履歷 claim 細粒度語義核對與差異 UI；目前 fact ID／版本／有效性檢查加上本人逐段確認，不能宣稱機器已證明每句話都正確。
- [ ] Markdown round-trip 差異合併、可編輯結構化日期與聯絡資料、更多履歷版型、求職信。現有 Markdown 上傳會保留為原始素材。
- [ ] 更大規模搜尋排序與跨站同職缺去重、O*NET／ESCO 正式職涯資料及發證機關 connector。当前分析只引用使用者已保存的職缺樣本。
- [ ] 自助密碼復原／管理員移轉、郵箱驗證、公開註冊防濫用、獨立 uptime 和錯誤告警、負載與滲透測試、多區高可用。

## 已驗證的基礎能力

- [x] 真實 PostgreSQL 核心整合測試；MCP PKCE、scope、refresh reuse；跨帳號隔離與版本一致性。
- [x] Chromium 桌面與手機端到端流程；有資料頁面切換與不同帳戶切換的獨立 review 回歸。
- [x] 固定 PDF／DOCX／Markdown 匯出及聯絡 email；私人附件加密。
- [x] 本機加密 dump／附件恢復、hash 驗證與較新刪除要求重播；520 MB 串流解密測試。
