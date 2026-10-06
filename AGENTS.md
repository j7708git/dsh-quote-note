# AGENTS.md — 給 coding agent 的操作說明

這個 repo 是一個 **DSH（DeepSeek Harness）client plugin**。
若使用者要你「把這個 repo 裝起來」，照下面做即可，**不需要先讀完所有原始碼**。

---

## 使用者說「幫我裝這個插件」時

### 步驟

1. **確認環境**：`dsh --version` 有回應、`node -v` ≥ 20。
2. **確認要裝進哪個 profile**（只問這一個問題，不要猜）：
   - 用 **DSH Desktop 應用** → `desktop`
   - 用 `dsh web` → `web`
   - 不確定 → 先看 `<DSH_HOME>/profiles/` 底下有哪些目錄，或直接問使用者。
3. **安裝**：
   ```sh
   node tools/install.mjs --profile desktop
   ```
   腳本會自己找 `DSH_HOME`（可用 `--dsh-home` 指定，或用 `DSH_PROFILE` 環境變數決定 profile）。
   先看它會做什麼可以加 `--dry-run`（不寫任何檔）。
4. **驗證**：
   ```sh
   node tools/install.mjs --verify --profile desktop
   ```
   退出碼：`0` 通過／`1` 有項目未通過／`2` 用法或環境錯誤。
5. **告訴使用者必須重啟該 profile** —— 新 bundle 不會熱載入。
   **不要**替他重啟 DSH：那會中斷他正在跑的 session。
6. 要移除時：`node tools/install.mjs --uninstall --profile desktop`

### 這個腳本做了什麼（你可以自行核對）

1. `<DSH_HOME>/profiles/<profile>/package.json`
   - `dsh.profile.bundles` 加入一列 `dsh-quote-note`
   - `dependencies["dsh-quote-note"] = "link:<本 repo 的絕對路徑>"`
2. `<DSH_HOME>/profiles/<profile>/node_modules/dsh-quote-note`
   → 指向本 repo 的 junction（Windows）／symlink（macOS、Linux）
3. 寫入前一定備份 `package.json`；腳本**冪等**，重跑不會重複加條目。
4. `--uninstall` 只刪「連結本身」，**不遞迴進目標目錄**。

### 禁止事項（踩到會壞事）

- **不要**用 `dsh plugin --profile desktop add` —— `desktop` profile 由 Electron 應用獨占管理，
  CLI 會直接拒絕（`profile "desktop" is managed exclusively by the Electron application`）。
  本腳本走的是 profile `package.json` ＋ `node_modules` 連結這條路，這是在該 profile 上
  唯一可行、也已實測的方式。
- **不要**對 `desktop` profile 跑 `pnpm install`／`pnpm add`：該 profile 可能有使用者手動建立的
  孤立 junction，pnpm 的 prune 會把它們清掉。
- **不要**覆蓋既有連結：腳本遇到指向別處的連結會停手，需 `--force` 才會換；不要主動加 `--force`。
- **不要**改任何 repo 的可見度、不要 `--force` push、不要改寫歷史。
- **不要**替使用者 commit 或 push，除非他明確要求。

---

## 這個插件是什麼

在 DSH 對話裡**反白選取文字** → 就地跳出小輸入框寫下你的想法 → 按「附加到輸入框」後，
引用與想法一起進入主輸入框 → 使用者照常送出時，模型同時看到「指涉哪一段」與「想說什麼」。

它**只有 client 半有行為**；`index.js` 是空的 `apply()`，存在的理由是 cordis loader 需要
套件主入口。沒有工具、沒有 route、沒有設定命名空間、不寫任何檔案。

---

## 改這個插件時要遵守的架構契約

這些是與 DSH 契約相關的硬規則，違反會在執行期才炸（或被 Guard 拒絕）：

1. **`client.js` 是手寫的 lazy-CJS bundle，不是建置產物。** 改它不需要任何 build 步驟。
   信封格式固定為 `window.__ModuleLoader__.load({ id: "dsh-quote-note", factory })`，
   且 `id` **必須**等於 `package.json` 的套件名。
2. **client 半必須宣告 `exports.inject = ["slots"]`。** cordis Guard 會拒絕未宣告的 `ctx.slots`
   存取（歷史事故：host 掛載全綠、client 半被 Guard 拒掉）。
3. **list slot 註冊必須帶 `id`**，且 slot 未宣告時註冊會丟錯 → 一律走 `ctx.slots.inject`
   （它會等宣告）。
4. **跨 slot 子樹溝通一律走 module 層 bus。** `shell.overlay`（root）與
   `conversation.input.right`（session）沒有共同父層，不要用 DOM 或全域事件硬串。
5. **寫入 composer 只能用官方 `InputActions`**：`captureInsertion()` + `insertText()` 首選
   （caret 錨定、單一 undo），失敗才退回 `setDraft()` 合併。
   **不得**直接改寫 DOM 輸入框、**不得**攔送出事件。
6. **不得引入任何 runtime 依賴**：`dependencies` 永遠保持為空（只有一個 optional peer）。
   這也讓 Dependabot 之類的機制對本 repo 無意義。
7. **純函式要 export 出來**，讓 `test/` 能用假 loader（`tools/load-client.mjs`）直接載入 bundle
   測試 —— 這是本專案刻意不引入建置鏈的原因，不要為了「方便」加打包器。
8. **DSH 專屬呼叫要集中並 feature-detect**：目前集中在 `client.js` 的 `insertIntoComposer()`
   與 `apply()`。DSH 仍是 developer preview，契約會在小版本之間漂移。
9. **失敗要如實回報**，不要靜默：`window.__dshQuoteNote` 是給排查用的診斷（只放計數與
   拒絕原因，**不得**放對話內容）。

---

## 驗證指令

```sh
node --test                                     # 單元測試（含 installer 的冪等與路徑安全）
node tools/install.mjs --verify --profile <p>   # 安裝驗證（唯讀，退出碼 0/1/2）
node tools/verify-served.mjs "<url含token>"      # 對已啟動實例驗證 bundle 真的被服務
node tools/verify-client.mjs "<url含token>"      # headless 瀏覽器端到端（真正會動，不只是掛載）
```

`verify-client.mjs` 需要 Chromium 系瀏覽器；會自動尋找常見路徑，可用 `--edge <path>`
或環境變數 `QN_BROWSER` 指定。

---

## 隱私（本 repo 是**公開**的）

不得寫入憑證、真名、私人 email、帳號 ID、內網位址或**個人**絕對路徑。
路徑請用 `<DSH_HOME>`、`<workspace-root>`、`~` 這類佔位符 —— 本 repo 內刻意不出現任何
使用者機器的真實路徑。文件裡的範例一律使用佔位符。

commit 前請確認 git 的 `user.email` 是 GitHub noreply 位址或你願意公開的位址，
**不要**用私人 email 提交到公開 repo。
