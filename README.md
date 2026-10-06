# dsh-quote-note

> **反白對話裡的文字，就地寫下你的想法；按送出時，模型同時看到「你指的是哪一段」與「你想說什麼」。**
> Select text in a DSH conversation, write what you think about it, and hand the model both the quote and your note.

---

## 為什麼需要它

| 沒有這個插件 | 有了這個插件 |
|---|---|
| 「**這裡**的推論我看不懂」→ 模型得猜「這裡」是哪一段 | 插件把被反白的原文以 `>` 引用區塊附進訊息，模型直接知道指涉範圍 |
| 想精確只能複製貼上原文，再手打「針對上面這段…」 | 反白 → 打字 → 附加，兩步完成，且不覆蓋你已打到一半的草稿 |

同一族問題的另一半（**圖片**上的標註）由獨立的 `dsh-annotate` 處理，兩者互不相干、可並存。

## 使用流程

1. **反白** — 在對話中選取任意文字（agent 回覆、你自己的訊息、任何可選取的文字）。
2. **點按鈕** — 選取處浮出「¶ 加想法」。
3. **寫想法** — 跳出的小輸入框可寫下針對這段文字的想法；`Ctrl/⌘+Enter` 附加、`Esc` 取消。
4. **送給模型** — 確認後，下列區塊被寫進主輸入框（可再編輯）：

   ```text
   [引用你先前的回覆]
   > 被反白的原文
   > 逐行以 > 標示

   [我對這段的想法]
   你在小輸入框寫的內容
   ```

5. 照常在主輸入框按送出即可。

輸入框下方靠右會出現一顆狀態 chip，回報「已附加引用（insertText／setDraft）」或失敗原因，約 6 秒後消失。

## 安裝

### 最快：把這個 repo 丟給你的 agent

對你的 coding agent 說一句：

> 把這個 repo 裝進我的 DSH（我在用 DSH Desktop）

它會讀 [`AGENTS.md`](./AGENTS.md) 並執行：

```sh
node tools/install.mjs --profile desktop            # 安裝
node tools/install.mjs --verify --profile desktop   # 驗證（唯讀，0=通過／1=未通過／2=用法或環境錯）
```

你也可以自己跑同一支腳本。`--profile` 省略時會先取環境變數 `DSH_PROFILE`，再退回 `desktop`；
想看它要做什麼而不寫任何檔，加 `--dry-run`。

**裝完必須重啟該 profile**（DSH Desktop 就重啟 Desktop）—— 新 bundle 不會熱載入。

腳本實際做的三件事、以及**不要**踩的坑（例如 `desktop` profile 不能用 `dsh plugin add`、
不要對它跑 pnpm），都寫在 [`AGENTS.md`](./AGENTS.md)。

### 手動（等同上面腳本做的事）

本插件設計為安裝在**單一 profile**。以 `desktop` profile（DSH Desktop 應用）為例：

```text
1) profile 的 package.json：
   - dependencies 加  "dsh-quote-note": "link:<workspace-root>/dsh-quote-note"
   - dsh.profile.bundles 加一列 "dsh-quote-note"
2) 在 profile 的 node_modules 下建立指向本目錄的目錄 junction／symlink：
   <DSH_HOME>/profiles/desktop/node_modules/dsh-quote-note -> <workspace-root>/dsh-quote-note
3) 重啟 DSH Desktop
```

**為什麼不用 `dsh plugin --profile desktop add`：** 該 profile 由 Electron 應用獨占管理，
CLI 會直接拒絕（`error: profile "desktop" is managed exclusively by the Electron application`）。
非 desktop 的 profile（例如 web）可以用官方指令：

```sh
dsh plugin --profile web add "<workspace-root>/dsh-quote-note"
```

## 移除

```sh
node tools/install.mjs --uninstall --profile desktop
```

只刪「連結本身」，不遞迴進目標目錄；`package.json` 會先備份再還原成安裝前的內容。
手動等價步驟：

```text
1) profile 的 package.json：從 dsh.profile.bundles 移除 "dsh-quote-note"，並移除對應的 dependencies 條目
2) 刪除 profile 的 node_modules/dsh-quote-note 連結本身（不要遞迴進目標目錄）
3) 重啟
```

本插件不寫任何檔案、不建任何資料目錄，移除後不留殘骸。

## 設計

**只有 client 半有行為**，host 半（`index.js`）是空的 `apply()` —— 存在的理由是 cordis loader 會
import 套件主入口並呼叫它；缺了它整個 bundle 會在開機時失敗。

| 位置 | slot | 用途 |
|---|---|---|
| `shell.overlay`（root, list） | `id: dsh-quote-note:floating` | 浮動按鈕與想法輸入框；選取處定位，夾在視窗內 |
| `conversation.input.right`（session, list） | `id: dsh-quote-note:bridge` | 取得 composer 的 `inputActions`，顯示結果 chip |

兩個 slot 子樹沒有共同父層，所以用 **module 層 bus** 串接（與 `dsh-annotate` 同法）。

寫入 composer 走官方 `InputActions`，兩條路依序嘗試：

1. `captureInsertion()` + `insertText(text, span)` — caret 錨定、單一 undo 步驟（首選）
2. `setDraft(composeDraftText(current, text))` — 整份草稿合併，**永不覆蓋**既有文字（後備）

不碰 DOM 改寫輸入框、不攔送出事件、不存取任何未公開 API。選取偵測用 `Selection` / `Range` 標準 API，
並排除落在 `contenteditable` / `input` / `textarea`（含 composer 自身與本插件 UI）的選取。

自我診斷：client 半會把計數與最後一次拒絕原因掛在 `window.__dshQuoteNote`（不含任何對話內容），
供驗證腳本與排查使用。

## 驗證

```sh
npm test                                        # 單元測試（node:test，直接載入 bundle 測純函式）
node tools/install.mjs --verify --profile <p>   # 安裝驗證（唯讀；0=通過／1=未通過／2=用法或環境錯）
node tools/verify-served.mjs "<url含token>"      # 對已啟動的實例驗證 bundle 真的被服務
node tools/verify-client.mjs "<url含token>"      # headless Edge + CDP 驗證 client 半真的會動
```

`verify-client.mjs` 會在真瀏覽器裡跑完整鏈：模組物化 → 反白 → 浮出按鈕 → 開面板 → 輸入 →
按附加 → 產生可觀測結果，並讀 `window.__dshQuoteNote` 回報失敗原因。
瀏覽器由常見路徑自動尋找（Edge／Chrome），找不到時用 `--edge <path>` 或環境變數 `QN_BROWSER` 指定。
兩支驗證腳本都需要 Node 20 以上。

## 已知限制（原型階段）

1. **沒有 pending 狀態**：想法按「附加」就立刻進主輸入框，沒有「先掛著、送出時才合併」的模式。
2. **不帶來源定位**：引用區塊只有原文，沒有訊息 id、行號或時間戳；模型靠文字比對定位。
3. **一次一則**：沒有多則引用的列表管理（面板關閉即結束）。
4. **引用上限 2000 字**：超過會截斷並標示「引用過長，已截斷」。
5. **不做持久化與工具**：沒有 host 資料、沒有給模型呼叫的 tool、沒有設定命名空間。
6. **反白範圍不區分來源**：不判斷是 agent 回覆或使用者訊息，只看是否為可選取的非編輯區文字。

## 相容性

實機驗證於 **DSH 0.1.7-alpha.2**（`@deepseek-ai/cordis` 4.0.4、Chromium 154 / Edge 154）。
`peerDependencies` 宣告 `@deepseek-ai/cordis: ">=4.0.0"`（optional）。

DSH 仍是 developer preview，client 契約會在小版本之間漂移。本插件把 DSH 專屬呼叫集中在
`client.js` 的 `insertIntoComposer()` 與 `apply()` 兩處並以 feature-detect 保護，契約變動時只需改這兩處。

## 開發

```text
dsh-quote-note/
├─ AGENTS.md             # 給別的 coding agent 的安裝／架構契約說明（「一句話裝好」的入口）
├─ package.json          # dsh.bundle.patch + dsh.client.platform（缺一不可）
├─ cordis.patch.yml      # 安裝時套用的 loader row
├─ index.js              # host 半（空 apply）
├─ client.js             # client 半：手寫 lazy-CJS bundle，零建置鏈，唯一真實來源
├─ test/                 # 單元測試（信封、兩條寫入路徑、installer 的冪等與路徑安全）
└─ tools/                # install.mjs（安裝／驗證／移除）＋ 兩個真機驗證腳本
```

`client.js` 是手寫產物，不是建置輸出；改它不需要任何 build 步驟，測試會直接載入同一份檔案
（因此不存在「原始碼改了、瀏覽器載到舊 bundle」的新鮮度問題）。

License: MIT
