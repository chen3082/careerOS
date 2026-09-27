# 職缺雷達獨立設計審查

日期：2026-09-27。範圍：[JOB-RADAR-DESIGN.md](JOB-RADAR-DESIGN.md) 與既有 `server/catalog.ts`、migration 011、`server/worker.ts`、共用清單規格的相容性。由獨立 reviewer agent 唯讀審查；沒有登入正式環境、執行測試或修改程式。

## 發現與修正

| 優先級 | 發現 | 已納入設計的修正 |
| --- | --- | --- |
| P2 | 通知／配對歷史在 180 日後清理，會遺失首次提醒去重；baseline 不發通知也需要處理紀錄 | `radar_job_states` 的首次處理紀錄獨立保留至刪帳，包含 baseline、已投與已提醒；與通知／cursor 同交易落盤，補 R16 |
| P2 | 先回填公開版本、再替換舊 collector，期間舊 writer 可能只改 catalog_jobs 而未產生事件 | 明訂 CareerOS 舊 writer 排空、短暫寫入屏障、lease 作廢、持久 capture epoch gate；回退舊 collector 必須停雷達並標 history_gap，重新升級重建基準，補 R17 |
| P2 | 監測在來源首次抓取前對序號 0 建立空 baseline，第一批舊職缺可能全變成新通知 | 持久 `initialized_at`／`initial_feed_seq`，NULL 與成功空 feed 的 0 分開；未初始化維持 waiting_source，說明失敗／部分 feed 行為，補 R18 |

## 複查結果與限制

Reviewer 複查上述三項後回報：三項 P2 在設計層面均已解決，限定此次範圍內沒有剩餘阻擋。

主代理另檢查文件的相對連結、程式碼區塊、18 個唯一驗收 ID 及未實作標示。這些是文件一致性檢查，**不是 18 項產品測試已通過**。個人監測、事件捕捉增量、私人提醒及 AI 配對仍須實作並按 R01–R18 驗收；既有共用抓取的程式驗收不得替代本功能驗收。
