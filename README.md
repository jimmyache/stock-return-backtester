# 台股與美股含息回測工具 v1.2

本版重點：

- 首頁移除「Yahoo Finance 已連線 · vX.X」，只保留今日 USD/TWD 匯率。
- 回測主流程若失敗，畫面只顯示「回測失敗」。
- 比較標的若失敗，只顯示「資料取得失敗」。
- 取消前端 `/batch-chart` 批次比較，改為各標的依序請求。
- 主標的與比較標的之間加入等待，降低 Yahoo 短時間密集請求。
- Worker 不再自行做長區間切割，避免「Worker 分段 + 前端分段」重疊造成請求過久。
- 前端若長區間失敗，自動改用 2 年一段重新取得並合併。
- Worker 每次 Yahoo 嘗試的 timeout 從 22 秒降到 10 秒，最多 2 次，避免瀏覽器先於 Worker 中止。

## 這次兩個檔案都要更新

1. Cloudflare Worker：重新貼上 `cloudflare-worker.js` 並 Deploy。
2. `/health` 應回傳 `"version":"v1.2"`。
3. GitHub Pages：用新版 `index.html` 覆蓋舊檔。
