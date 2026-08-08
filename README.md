# 台股與美股含息回測工具 v0.5

## 本版更新

- 金額欄接受任何大於 0 的正整數
- 結果改為表格比較
- 資產曲線自動切成 20 個互動時間點
- 游標移到時間點時，右側顯示各標的當時資產
- 移除頁面上的美股換匯規則說明文字
- 所有買入價格改採當月可用交易日收盤價平均
- 拆股月份會先換到同一股數基準再計算月均價
- 每日資產市值仍使用當日收盤價

## GitHub Pages

將 `index.html` 放在 Repository 根目錄，Settings → Pages：

- Source：Deploy from a branch
- Branch：main
- Folder：/ (root)

網站：`https://jimmyache.github.io/stock-return-backtester/`

內建 Worker：`https://dark-snowflake-d965.jimmyshieh30.workers.dev`
