/**
 * dsh-quote-note — host half.
 *
 * 原型階段刻意留空：本插件所有行為都在 client 半（反白選取 → 想法輸入框 →
 * 插入主輸入框），不需要任何 host 服務、路由、工具或設定命名空間。
 *
 * 這個檔案仍然必須存在：cordis loader 會 import 套件主入口並呼叫 apply()，
 * 缺了它整個 bundle 會在 boot 時失敗（而不是安靜地不啟用）。
 *
 * 相關設計與後續候選（host 半的 pending 合併）見 notes 專案的 plan.md。
 */

/** cordis plugin entry. 目前無 host 側副作用。 */
export function apply() {}
