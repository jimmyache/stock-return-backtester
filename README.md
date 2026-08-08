# 台股與美股含息回測工具

可直接部署到 GitHub Pages 的單檔版本。

## 已完成

- 股票名稱或代號（台股或美股）搜尋
- 單筆投入 / 每月定期定額
- 股息再投入
- 台股與美股歷史回測
- 美股依各交易日 USD/TWD 匯率換算新台幣
- 首頁自動顯示「今日匯率：1 美元 = xx.xx 台幣」
  - 若今日沒有外匯交易資料，使用最近一個可用交易日，滑鼠停留可看到資料日期
- 比較基準固定自動加入：0050、00631L、SPY、^TWII
- 含息損益、含息報酬率、XIRR、最大回撤、資產曲線

## 已內建 Worker

`https://dark-snowflake-d965.jimmyshieh30.workers.dev`

使用者不需要輸入 Worker 網址。

## GitHub Pages

Repository 根目錄至少需要：

- `index.html`

設定：

- Settings → Pages
- Source：Deploy from a branch
- Branch：main
- Folder：/ (root)

網站：

`https://jimmyache.github.io/stock-return-backtester/`

## 注意

`^TWII` 是台灣加權價格指數，不是官方含息報酬指數。

Yahoo Finance 為非正式資料來源，可能受到流量限制、格式變更或服務中斷影響。
本工具僅供研究與教育用途，不構成投資建議。
