# 台股與美股含息回測工具 — 主標的 Yahoo / 固定基準 KV 架構

## 資料路徑

- 使用者主標的：`/chart` → 每次直接 Yahoo Finance。
- 固定比較基準：`/benchmark-chart` → 只讀 Workers KV。
- 固定 KV：0050.TW、00631L.TW、SPY、^TWII、TWD=X。
- 股票搜尋：`/search` → Yahoo Finance（搜尋字串只使用 Cache API 短暫快取）。

## 前端修改

- 移除美股 / USD-TWD 的 2 年分段 request。
- 一個主標的只送一次 `/chart`。
- 每個比較基準只送一次 `/benchmark-chart`。
- 今日匯率也從 `TWD=X` KV 讀取。
- 移除頁尾資料來源區塊。

## Worker 修改

- `/chart` 不讀 KV、不寫 KV。
- `/benchmark-chart` 不呼叫 Yahoo，不做 fallback。
- Cron 只更新固定 5 組 KV。
- 主標的即使恰好是 SPY / 0050，也仍以主標的身分走 Yahoo；比較列則讀 KV。
