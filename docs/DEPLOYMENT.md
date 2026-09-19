# 部署與營運

本版本是單一主機、邀請制部署。HTTPS 在現有 nginx 終止，CareerOS 網站只綁定 `127.0.0.1:3100`；PostgreSQL 不發布主機埠。網站和 worker 為非 root、唯讀 root filesystem、移除 capabilities、有記憶體／程序數限制。Playwright 只用於受控、HTML escape 且封鎖外連的履歷渲染；容器中的 Chromium 使用 Playwright 預設 sandbox 設定，不用它開任意職缺網站。

## 環境與首次使用

完整範例見 `.env.example`。`PUBLIC_URL` 必須與 nginx 路徑一致，正式環境必須為 HTTPS。`ENCRYPTION_KEY` 是 64 位十六進位金鑰，負責附件、第三方 credential 與本機備份加密；必須另外保存，遺失後不能恢復。不要將密鑰放進 README、issue 或 repository。

初始管理員在網站選建立帳號，填入主機 `.env` 的 `BOOTSTRAP_TOKEN`。建立成功後管理員可從設定頁產生七天內、僅一次有效的工作台邀請。小組邀請獨立管理。

nginx 加入 `/careeros`、`/.well-known/oauth-authorization-server/careeros/oauth` 和 `/.well-known/oauth-protected-resource/careeros/mcp` 的代理，轉向 3100。保留原本其他 location。設定 `client_max_body_size 21m`、正確 Host／X-Forwarded-Proto／X-Forwarded-For，`proxy_read_timeout 120s`，MCP 關閉 buffering。修改前備份，`nginx -t` 通過後 reload。

## MCP 與 AI

Claude 的自訂 connector 填入 `${PUBLIC_URL}/mcp`。使用者登入 CareerOS 後，可選擇核准 scopes。MCP 是 client 驅動，網站不能自行喚醒使用者的 Claude。啟用 BYOK 才會使用該使用者加密保存的 API key；沒有平台 key 後備。

每日用量按照使用者設定時區計算。文字生成採保守 token 預留；語音轉錄為獨立 OpenAI BYOK，先轉成有上限的 WAV 並預留 10,000 token 單位。此欄位是執行上限，不是精確金額報表；供應商計費以供應商帳單為準。逾時等結果未知保留預留，不自動重試。語音目前無說話者辨識與時間戳 UI。

Google 整合需填 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`，redirect URI 是 `${PUBLIC_URL}/google/callback`。使用 Gmail readonly 和 Calendar events readonly。需完成 Google 對營運用途所要求的設定／驗證；目前未用真實 Gmail 帳戶驗收。連接後每 15 分鐘取得最近 30 天最多 50 封相关信件及未來 30 天最多 100 個日曆事件，屬有界樣本，非完整信箱同步；訊號需本人確認。

## 備份與還原

`sudo bash scripts/backup.sh` 建立 PostgreSQL custom dump 與加密附件 tar，AES-256-GCM 加密後保留七天。執行中的附件皆為不可變新增檔，資料庫先 dump、附件後備份可包含額外未引用檔，恢復後由資料庫決定哪些檔可讀取。並非跨檔案系統原子快照，需由驗收確認所有被引用附件存在。主機停機、磁碟故障會同時失去本機備份；私有 bucket / 異地 journal 已由使用者要求延後。

恢復時先關閉公開流量與 worker，還原至隔離環境：

1. 保存備份之外的**最新** `data/deletions.log`；不能用舊備份內的 ledger 取代。
2. `node server/backup-stream.mjs decrypt` 使用相同 `ENCRYPTION_KEY` 解密。驗證 GCM 成功後才输出明文；解密串流先寫到私有 scratch，GCM 驗證成功後才輸出。大檔案需將 `BACKUP_TMP_DIR` 指向隔離環境中有足夠空間的 scratch volume；不要使用預設 256 MB 容器 tmpfs 來恢復大備份。
3. `pg_restore --exit-on-error` 到新建立的隔離 DB；附件解密後解壓到隔離 data volume，設定 node UID 1000 可讀寫。
4. 指向恢復環境執行 `node --import tsx server/replay-deletions.ts /path/to/latest-deletions.log`，套用所有刪除要求並移除對應附件。
5. 撤銷所有 sessions、OAuth tokens 和未消耗 authorizations，將在執行中的 task 標成失敗；核對附件 hash、owner 與 DB 可讀取性。檢查 `SUBMISSIONS_ENABLED=false`。
6. 完成登入、附件與核心流程 smoke test 後才恢復流量。**沒有最新 deletion ledger 或無法證明刪除要求已套用時，不得恢復登入或公開流量；沒有獨立送出 journal 時也不得啟動自動投遞。**

## 更新與回退

先備份；建置新的 image tag；在獨立 `*_test` database 跑 migrations 和整合測試；正式 migration 完成後替換 web／worker，再檢查 `/careeros/health` 與登入。資料庫 schema 不自動降版；若需回退，使用相容舊版程式或在隔離環境還原，不對正式資料庫直接 drop table。

查看 `docker-compose ps`、`docker-compose logs --tail=100 web worker`，不要輸出 `.env`。JSON request logs 不記錄 body、Cookie、Authorization 或 URL query；database exceptions 只記錄 code。保留容器日誌上限 3 × 10 MB。建議正式公開上線前增加獨立 uptime／錯誤告警、供應商 key 輪換、password recovery、負載與滲透測試。
