# 台股與美股含息回測工具 — Yahoo 無 API Key 版

這是可以直接放到 GitHub Pages 的單檔版本。

## 已內建的 Cloudflare Worker

網站已直接使用：

`https://dark-snowflake-d965.jimmyshieh30.workers.dev`

訪客不需要輸入 Worker 網址，也不需要 API Key。

## 功能

- 台股 / 美股股票搜尋
- 單筆投入
- 每月定期定額
- 股息再投入
- Yahoo Finance 原始收盤價、股息與股票分割事件
- 美股每次投入依「買進當天 USD/TWD」換算美元
- 美股每日資產依「當天 USD/TWD」換回新台幣
- 含息損益
- 含息報酬率
- XIRR 年化報酬率
- 最大回撤
- 資產曲線
- 0050 / 00631L / SPY / ^TWII 比較

注意：`^TWII` 是台灣加權價格指數，不是官方含息報酬指數。

## GitHub Pages 上傳方式

建議把舊專案中不再需要的 React / Vite 檔案刪除，GitHub Repository 根目錄只需要：

- `index.html`
- `README.md`
- `cloudflare-worker.js`（備份用途，不會由 GitHub Pages 執行）

GitHub：

1. Repository → Add file → Upload files
2. 上傳本 ZIP 解壓縮後的三個檔案
3. 確認 `index.html` 位於 Repository 根目錄
4. Settings → Pages
5. Source 選 `Deploy from a branch`
6. Branch 選 `main`
7. Folder 選 `/ (root)`
8. Save

網站網址：

`https://jimmyache.github.io/stock-return-backtester/`

## Cloudflare Worker

`cloudflare-worker.js` 是你目前 Worker 的備份原始碼。

若未來要重新建立 Worker：

1. Cloudflare → Workers & Pages → Create application
2. Start with Hello World
3. Edit code
4. 刪除 Hello World
5. 貼上 `cloudflare-worker.js`
6. Deploy

Worker 不需要 API Key，也不需要 Secret。

## 資料與使用注意

Yahoo Finance 介面屬於非正式資料來源，可能受到流量限制、格式調整或服務中斷影響。
本工具僅供研究與教育用途，不構成投資建議。
