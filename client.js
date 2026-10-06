/**
 * dsh-quote-note — client half（lazy-CJS bundle；手寫，零構建鏈）。
 *
 * 信封格式：window.__ModuleLoader__.load({ id: <套件名>, factory })
 * 執行本檔只註冊 factory；模組本體在物化時才跑（見 @deepseek-ai/dsh-client-modules）。
 *
 * 功能（原型，設計 (a)「附加即插入」）：
 *   1. 在對話中反白選取文字 → 選取處浮出「¶ 加想法」
 *   2. 點擊 → 小輸入框（可寫下對這段文字的想法）
 *   3. 確認 → 以官方 InputActions 把「引用 + 想法」放進主輸入框
 *   4. 使用者照常在主輸入框按送出 → 模型同時看到引用與想法
 *
 * 兩個 slot 子樹沒有共同父層，所以用 module 層 bus 串接（與 dsh-annotate 同法）：
 *   - shell.overlay            （root，list）→ 浮動按鈕與想法輸入框
 *   - conversation.input.right （session，list）→ 橋接，取得 inputActions 並顯示結果
 *
 * 純函式（normalizeQuote / formatQuoteBlock / composeDraftText）一併 export，
 * 供 test/ 以假 loader 載入本 bundle 後直接測試，不需建置步驟。
 */
if (typeof window !== "undefined" && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {
  window.__ModuleLoader__.load({
    id: "dsh-quote-note",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      var React = require("react");
      var h = React.createElement;

      var PLUGIN = "dsh-quote-note";
      var MAX_QUOTE_CHARS = 2000;

      /* ── 自我診斷（給驗證腳本與使用者排查用；只讀計數，不含對話內容） ───── */
      var diag = {
        applied: false,
        inject: { requested: [], registered: [] },
        mounted: { floating: 0, bridge: 0 },
        syncs: 0,
        lastPick: null,
        lastReject: null,
        inserts: [],
        errors: [],
      };
      if (typeof window !== "undefined") window.__dshQuoteNote = diag;

      /* ── 主題 token（沿用 DSH 既有別名，附後備值） ───────────────────────── */
      var T = {
        bg: "var(--dsw-alias-bg-layer-3, #2b2b2f)",
        fg: "var(--dsw-alias-label-primary, #e8e8ea)",
        fg2: "var(--dsw-alias-label-secondary, #b9b9c0)",
        fg3: "var(--dsw-alias-label-tertiary, #8e8e96)",
        border: "var(--dsw-alias-border-l4, rgba(140,140,150,.45))",
        brand: "var(--dsw-alias-brand-primary, #4f8cff)",
        err: "var(--dsw-alias-label-error, #ff6b6b)",
        shadow: "0 6px 24px rgba(0,0,0,.32)",
      };

      /* ══ 純函式（可測） ══════════════════════════════════════════════════ */

      /** 正規化引用文字：統一換行、收斂空白、去掉頭尾空白行。 */
      function normalizeQuote(text) {
        if (typeof text !== "string") return "";
        return text
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t\u00a0]+/g, " ")
          .replace(/ *\n */g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      /**
       * 把「引用」與「我的想法」組成要放進主輸入框的純文字區塊。
       * 回傳空字串代表沒有任何可附加的內容。
       */
      function formatQuoteBlock(quote, note) {
        var q = normalizeQuote(quote);
        var n = typeof note === "string" ? note.replace(/\r\n?/g, "\n").trim() : "";
        if (!q && !n) return "";

        var truncated = false;
        if (q.length > MAX_QUOTE_CHARS) {
          q = q.slice(0, MAX_QUOTE_CHARS);
          truncated = true;
        }
        var quoted = q
          .split("\n")
          .map(function (line) {
            return line ? "> " + line : ">";
          })
          .join("\n");
        if (truncated) quoted += "\n> …（引用過長，已截斷）";

        var out = "[引用你先前的回覆]\n" + quoted;
        if (n) out += "\n\n[我對這段的想法]\n" + n;
        return out;
      }

      /** 把新區塊併到既有草稿後面，不覆蓋使用者已打的字。 */
      function composeDraftText(existing, addition) {
        var extra = typeof addition === "string" && addition.length > 0 ? addition : null;
        if (!extra) return typeof existing === "string" ? existing : null;
        if (typeof existing !== "string" || existing.trim().length === 0) return extra;
        return existing.replace(/\s+$/, "") + "\n\n" + extra;
      }

      /** 讀目前草稿文字（InputActions.state 是 SnapshotStore）。 */
      function currentDraft(inputActions) {
        try {
          var state = inputActions && inputActions.state;
          if (!state || typeof state.getSnapshot !== "function") return null;
          var snap = state.getSnapshot();
          var draft = snap && (snap.draft !== undefined ? snap.draft : snap.text);
          return typeof draft === "string" ? draft : null;
        } catch (e) {
          return null;
        }
      }

      /**
       * 把區塊寫進 composer。首選官方的 caret 錨定插入（單一 undo 步驟），
       * 失敗才退回「整份草稿合併」。永不覆蓋使用者已打好的字。
       */
      function insertIntoComposer(inputActions, text) {
        if (!inputActions) return { ok: false, reason: "no-session" };

        if (typeof inputActions.captureInsertion === "function" && typeof inputActions.insertText === "function") {
          try {
            var span = inputActions.captureInsertion();
            if (inputActions.insertText(text, span) !== false) {
              return { ok: true, via: "insertText" };
            }
          } catch (e) {
            /* 契約有漂移或鎖定時退回下一條路 */
          }
        }

        if (typeof inputActions.setDraft === "function") {
          try {
            inputActions.setDraft(composeDraftText(currentDraft(inputActions), text));
            return { ok: true, via: "setDraft" };
          } catch (e2) {
            return { ok: false, reason: "threw", detail: String((e2 && e2.message) || e2) };
          }
        }

        return { ok: false, reason: "no-api" };
      }

      /* ══ DOM：選取偵測 ══════════════════════════════════════════════════ */

      /** 選取是否落在可編輯區（composer 的 contenteditable / textarea / 本插件 UI）。 */
      function isEditableNode(node) {
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        while (el && el.nodeType === 1) {
          var tag = (el.tagName || "").toLowerCase();
          if (tag === "input" || tag === "textarea" || tag === "select") return true;
          var ce = el.getAttribute && el.getAttribute("contenteditable");
          if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
          if (el.hasAttribute && el.hasAttribute("data-dsh-quote-note")) return true;
          el = el.parentElement;
        }
        return false;
      }

      /** 讀目前的非空選取；不可用時回 null，並把原因記進 diag。 */
      function readSelection() {
        function reject(reason) {
          diag.lastReject = reason;
          return null;
        }
        try {
          var sel = document.getSelection && document.getSelection();
          if (!sel) return reject("no-selection-api");
          if (sel.rangeCount === 0) return reject("no-range");
          if (sel.isCollapsed) return reject("collapsed");
          var text = sel.toString();
          if (!text || !text.trim()) return reject("empty-text");
          var range = sel.getRangeAt(0);
          if (isEditableNode(range.startContainer) || isEditableNode(range.endContainer)) return reject("inside-editable");
          var rect = range.getBoundingClientRect();
          if (!rect || (rect.width === 0 && rect.height === 0)) return reject("zero-rect");
          diag.lastReject = null;
          return {
            text: text,
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          };
        } catch (e) {
          diag.errors.push("readSelection: " + String((e && e.message) || e));
          return reject("threw:" + String((e && e.message) || e));
        }
      }

      /** 把浮動元素夾在視窗內；優先放在選取上方，放不下就放下方。 */
      function clampPos(rect, width, height) {
        var vw = window.innerWidth || 1024;
        var vh = window.innerHeight || 768;
        var left = Math.min(Math.max(8, rect.left), Math.max(8, vw - width - 8));
        var top = rect.top - height - 10;
        if (top < 8) top = rect.bottom + 10;
        if (top + height > vh - 8) top = Math.max(8, vh - height - 8);
        return { left: left, top: top };
      }

      /* ══ module 層 bus：串接兩個 slot 子樹 ═══════════════════════════════ */

      var bus = (function () {
        var source = null;
        var listeners = [];
        return {
          /** 由 bridge 註冊 composer 的 inputActions；回傳解除函式。 */
          setSource: function (inputActions) {
            source = inputActions || null;
            return function () {
              if (source === (inputActions || null)) source = null;
            };
          },
          hasSource: function () {
            return source !== null;
          },
          subscribe: function (fn) {
            listeners.push(fn);
            return function () {
              var i = listeners.indexOf(fn);
              if (i >= 0) listeners.splice(i, 1);
            };
          },
          emit: function (payload) {
            listeners.slice().forEach(function (fn) {
              try {
                fn(payload);
              } catch (e) {
                /* 監聽者壞掉不影響其他人 */
              }
            });
          },
          insert: function (text) {
            var result;
            try {
              result = insertIntoComposer(source, text);
            } catch (e) {
              result = { ok: false, reason: "threw", detail: String((e && e.message) || e) };
            }
            this.emit(result);
            return result;
          },
        };
      })();

      function resultText(result) {
        if (result.ok) {
          return "已附加引用（" + result.via + "）";
        }
        if (result.reason === "no-session") return "還沒有輸入框：請先開啟一個 session";
        if (result.reason === "no-api") return "這個版本的輸入框不支援寫入";
        if (result.reason === "threw") return "寫入失敗：" + (result.detail || "未知錯誤");
        return "附加失敗：" + result.reason;
      }

      /* ══ 浮動層：反白 → 按鈕 → 想法輸入框 ═══════════════════════════════ */

      function FloatingAnnotator() {
        var pickState = React.useState(null);
        var pick = pickState[0];
        var setPick = pickState[1];

        var editingState = React.useState(null);
        var editing = editingState[0];
        var setEditing = editingState[1];

        var noteState = React.useState("");
        var note = noteState[0];
        var setNote = noteState[1];

        var msgState = React.useState(null);
        var msg = msgState[0];
        var setMsg = msgState[1];

        var frozen = React.useRef(false);

        React.useEffect(function () {
          diag.mounted.floating += 1;
          function sync() {
            if (frozen.current) return;
            diag.syncs += 1;
            var next = readSelection();
            diag.lastPick = next ? next.text.slice(0, 60) : null;
            setPick(function (prev) {
              if (!next) return prev ? null : prev;
              if (
                prev &&
                prev.text === next.text &&
                Math.abs(prev.rect.top - next.rect.top) < 2 &&
                Math.abs(prev.rect.left - next.rect.left) < 2
              ) {
                return prev;
              }
              return next;
            });
          }
          document.addEventListener("selectionchange", sync);
          document.addEventListener("mouseup", sync);
          document.addEventListener("keyup", sync);
          window.addEventListener("scroll", sync, true);
          window.addEventListener("resize", sync);
          return function () {
            diag.mounted.floating -= 1;
            document.removeEventListener("selectionchange", sync);
            document.removeEventListener("mouseup", sync);
            document.removeEventListener("keyup", sync);
            window.removeEventListener("scroll", sync, true);
            window.removeEventListener("resize", sync);
          };
        }, []);

        function openEditor(event) {
          if (event && event.preventDefault) event.preventDefault();
          if (!pick) return;
          frozen.current = true;
          setMsg(null);
          setNote("");
          setEditing(pick);
        }

        function closeEditor() {
          frozen.current = false;
          setEditing(null);
          setNote("");
          setMsg(null);
          setPick(readSelection());
        }

        function confirm() {
          if (!editing) return;
          var block = formatQuoteBlock(editing.text, note);
          if (!block) {
            setMsg("沒有可附加的內容");
            return;
          }
          var result = bus.insert(block);
          if (result.ok) {
            closeEditor();
          } else {
            setMsg(resultText(result));
          }
        }

        function onKeyDown(event) {
          if (event.key === "Escape") {
            event.preventDefault();
            closeEditor();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            confirm();
          }
        }

        if (editing) {
          var panelW = 360;
          var panelH = 216;
          var p = clampPos(editing.rect, panelW, panelH);
          var preview = normalizeQuote(editing.text);
          if (preview.length > 160) preview = preview.slice(0, 160) + "…";

          return h(
            "div",
            {
              "data-dsh-quote-note": "panel",
              onMouseDown: function (event) {
                event.stopPropagation();
              },
              style: {
                position: "fixed",
                left: p.left + "px",
                top: p.top + "px",
                width: panelW + "px",
                boxSizing: "border-box",
                zIndex: 2147483000,
                background: T.bg,
                color: T.fg,
                border: "1px solid " + T.border,
                borderRadius: "10px",
                boxShadow: T.shadow,
                padding: "10px",
                font: "inherit",
                fontSize: "13px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              },
            },
            h(
              "div",
              { style: { fontSize: "11px", color: T.fg3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
              "引用：" + preview
            ),
            h("textarea", {
              "data-dsh-quote-note": "textarea",
              autoFocus: true,
              value: note,
              placeholder: "針對這段文字，你想說什麼？（例如：這裡的推論我看不懂、這段請展開）",
              onKeyDown: onKeyDown,
              onChange: function (event) {
                setNote(event.target.value);
              },
              style: {
                minHeight: "76px",
                resize: "vertical",
                boxSizing: "border-box",
                background: "transparent",
                color: T.fg,
                border: "1px solid " + T.border,
                borderRadius: "8px",
                padding: "6px 8px",
                font: "inherit",
                fontSize: "13px",
                outline: "none",
              },
            }),
            msg ? h("div", { style: { fontSize: "12px", color: T.err } }, msg) : null,
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "8px" } },
              h("span", { style: { flex: "1", fontSize: "11px", color: T.fg3 } }, "Ctrl/⌘+Enter 附加 · Esc 取消"),
              h(
                "button",
                {
                  type: "button",
                  onClick: closeEditor,
                  style: {
                    font: "inherit",
                    fontSize: "12px",
                    padding: "4px 10px",
                    borderRadius: "8px",
                    cursor: "pointer",
                    background: "transparent",
                    color: T.fg2,
                    border: "1px solid " + T.border,
                  },
                },
                "取消"
              ),
              h(
                "button",
                {
                  type: "button",
                  onClick: confirm,
                  style: {
                    font: "inherit",
                    fontSize: "12px",
                    padding: "4px 12px",
                    borderRadius: "8px",
                    cursor: "pointer",
                    background: "transparent",
                    color: T.brand,
                    border: "1px solid " + T.brand,
                  },
                },
                "附加到輸入框"
              )
            )
          );
        }

        if (!pick) return null;

        var b = clampPos(pick.rect, 104, 30);
        return h(
          "button",
          {
            "data-dsh-quote-note": "button",
            type: "button",
            title: "為這段反白文字加想法，附加到主輸入框",
            onMouseDown: function (event) {
              event.preventDefault();
            },
            onClick: openEditor,
            style: {
              position: "fixed",
              left: b.left + "px",
              top: b.top + "px",
              zIndex: 2147483000,
              font: "inherit",
              fontSize: "12px",
              lineHeight: "1",
              padding: "7px 10px",
              borderRadius: "999px",
              cursor: "pointer",
              background: T.bg,
              color: T.fg,
              border: "1px solid " + T.border,
              boxShadow: T.shadow,
              whiteSpace: "nowrap",
            },
          },
          "¶ 加想法"
        );
      }

      /* ══ 橋接：取得 composer 的 inputActions，並回報最近一次結果 ═════════ */

      function ComposerBridge(props) {
        var statusState = React.useState(null);
        var status = statusState[0];
        var setStatus = statusState[1];

        React.useEffect(
          function () {
            diag.mounted.bridge += 1;
            var off = bus.setSource(props && props.inputActions);
            return function () {
              diag.mounted.bridge -= 1;
              off();
            };
          },
          [props && props.inputActions]
        );

        React.useEffect(function () {
          var off = bus.subscribe(function (result) {
            setStatus(resultText(result));
          });
          return off;
        }, []);

        React.useEffect(
          function () {
            if (!status) return undefined;
            var timer = setTimeout(function () {
              setStatus(null);
            }, 6000);
            return function () {
              clearTimeout(timer);
            };
          },
          [status]
        );

        if (!status) return null;
        return h(
          "span",
          {
            "data-dsh-quote-note": "chip",
            title: status,
            style: {
              fontSize: "11px",
              color: T.fg2,
              border: "1px solid " + T.border,
              borderRadius: "999px",
              padding: "1px 8px",
              whiteSpace: "nowrap",
              maxWidth: "220px",
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
          },
          status
        );
      }

      /* ══ 進入點 ══════════════════════════════════════════════════════════ */

      /**
       * 註冊進 slot。LIST slot 必須帶 id，且 slot 未宣告時註冊會丟錯，
       * 所以一律走 slots.inject（等宣告）。
       */
      function registerSlot(ctx, slotName, component, options) {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") {
          throw new Error(PLUGIN + ": ctx.slots 不可用 —— exports.inject 必須宣告 \"slots\"");
        }
        var opts = options || {};
        diag.inject.requested.push(slotName);
        return ctx.slots.inject(slotName, function () {
          var registration = { name: slotName, id: opts.id || PLUGIN + ":" + slotName };
          if (opts.order !== undefined) registration.order = opts.order;
          var disposer = ctx.slots.register(registration, component);
          diag.inject.registered.push(slotName);
          return disposer;
        });
      }

      function apply(ctx) {
        var registered = [];

        try {
          registerSlot(ctx, "shell.overlay", FloatingAnnotator, { id: PLUGIN + ":floating", order: 20 });
          registered.push("shell.overlay");
        } catch (error) {
          console.error("[" + PLUGIN + "] 無法註冊 shell.overlay", error);
        }

        try {
          registerSlot(ctx, "conversation.input.right", ComposerBridge, { id: PLUGIN + ":bridge", order: 20 });
          registered.push("conversation.input.right");
        } catch (error) {
          console.error("[" + PLUGIN + "] 無法註冊 conversation.input.right", error);
        }

        console.log("[" + PLUGIN + "] client half applied", { slots: registered });
        diag.applied = true;
      }

      exports.apply = apply;
      /** 硬依賴：slot registry。未宣告而存取 ctx.slots 會被 cordis Guard 拒絕。 */
      exports.inject = ["slots"];
      /* 給驗證腳本／使用者排查用（見 tools/verify-client.mjs）。 */
      exports.__diag = diag;
      /* 供 test/ 以假 loader 載入後直接測試（見 test/format.test.js）。 */
      exports.__pure = {
        normalizeQuote: normalizeQuote,
        formatQuoteBlock: formatQuoteBlock,
        composeDraftText: composeDraftText,
        insertIntoComposer: insertIntoComposer,
        readSelection: readSelection,
      };
      return module.exports;
    },
  });
}
