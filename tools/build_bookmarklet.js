// ============================================================================
// build_bookmarklet.js — собирает самодостаточный букмарклет из
// apps/web/bridge-lib.js + tools/bm_action.js и
// инлайнит его в index.html между атрибутами тега <a id="bmLink" ...>.
// Инлайн обязателен: CSP страниц поисковиков запрещает внешние <script src>,
// а javascript:-URL закладок CSP не касается — код букмарклета не зависит
// ни от сети, ни от расширений, работает в Firefox/Chrome/Safari/Edge.
// ============================================================================
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "apps", "web");
const lib = fs.readFileSync(path.join(DIR, "bridge-lib.js"), "utf8");
const action = fs.readFileSync(path.join(__dirname, "bm_action.js"), "utf8");
const code = lib + "\n/* ==== действие закладки ==== */\n" + action;

// базовые проверки: код должен быть синтаксически валиден
new Function(code);
if (code.indexOf("fsBridge: 1") < 0) throw new Error("bridge-lib не содержит маркер payload");

const href = "javascript:" + encodeURIComponent(code);
let html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const re = /(<a[^>]*id="bmLink"[^>]*href=")([^"]*)(")/;
if (!re.test(html)) throw new Error("плейсхолдер bmLink не найден в index.html");
html = html.replace(re, function(_, a, old, c){
  if (old.length > 40 && old !== href) console.log("перезаписываю старый букмарклет (" + old.length + " симв)");
  return a + href + c;
});
fs.writeFileSync(path.join(DIR, "index.html"), html);
fs.writeFileSync(path.join(DIR, "bookmarklet.js"), code);   // исходник для тестов/правок
console.log("букмарклет собран: код " + code.length + " симв → href " + href.length +
            " симв (лимит закладок ~65K: " + (href.length < 65000 ? "ок" : "ПРЕВЫШЕН!") + ")");
