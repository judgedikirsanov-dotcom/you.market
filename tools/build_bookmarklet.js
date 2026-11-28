// ============================================================================
// build_bookmarklet.js — собирает самодостаточный букмарклет из
// apps/web/bridge-lib.js + tools/bm_action.js и
// инлайнит его в index.html между атрибутами тега <a id="bmLink" ...>.
// Инлайн обязателен: CSP страниц поисковиков запрещает внешние <script src>,
// а javascript:-URL закладок CSP не касается — код букмарклета не зависит
// ни от сети, ни от расширений, работает в Firefox/Chrome/Safari/Edge.
//
// Заодно сборщик проставляет номер версии из version.json во все части
// продукта (правила — в tools/versions.js): ?v= у библиотек страницы, метка
// you-market-version, @version и @require пользовательского скрипта, поле
// version обоих манифестов расширения. Номер хранится один раз.
//
//   node tools/build_bookmarklet.js           — собрать и записать
//   node tools/build_bookmarklet.js --check   — ничего не писать: собрать
//        в памяти и сравнить с файлами репозитория; расхождение → код 1
//        (так конвейер ловит страницу, закладку или версию, поправленные руками)
// ============================================================================
const fs = require("fs");
const path = require("path");
const versions = require("./versions");

const CHECK = process.argv.includes("--check");
const DIR = path.join(__dirname, "..", "apps", "web");
const FILES = versions.FILES;
const rel = function(abs){ return path.relative(versions.ROOT, abs); };

const lib = fs.readFileSync(path.join(DIR, "bridge-lib.js"), "utf8");
const action = fs.readFileSync(path.join(__dirname, "bm_action.js"), "utf8");
const code = lib + "\n/* ==== действие закладки ==== */\n" + action;

// базовые проверки: код должен быть синтаксически валиден
new Function(code);
if (code.indexOf("fsBridge: 1") < 0) throw new Error("bridge-lib не содержит маркер payload");

const href = "javascript:" + encodeURIComponent(code);
let html = fs.readFileSync(FILES.html, "utf8");
const re = /(<a[^>]*id="bmLink"[^>]*href=")([^"]*)(")/;
if (!re.test(html)) throw new Error("плейсхолдер bmLink не найден в index.html");
const oldHref = re.exec(html)[2];
if (oldHref.length > 40 && oldHref !== href && !CHECK)
  console.log("перезаписываю старый букмарклет (" + oldHref.length + " симв)");
html = html.replace(re, function(_, a, old, c){ return a + href + c; });

const ver = versions.readVersion();
// [файл, каким он должен быть, что это] — порядок = порядок сборки
const targets = [
  [FILES.html, versions.stampHtml(html, ver.version), "страница: закладка, адреса библиотек, метка версии"],
  [FILES.bookmarklet, code, "исходник закладки"],
  [FILES.userjs, versions.stampUserjs(fs.readFileSync(FILES.userjs, "utf8"), ver.version), "скрипт: @version и @require"],
  [FILES.manifest, versions.stampManifest(fs.readFileSync(FILES.manifest, "utf8"), ver.version), "манифест расширения (Chromium)"],
  [FILES.manifestFirefox, versions.stampManifest(fs.readFileSync(FILES.manifestFirefox, "utf8"), ver.version), "манифест расширения (Firefox)"]
];

const changed = [];
for (const [file, want] of targets){
  const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (have === want) continue;
  if (CHECK){
    console.error("✗ " + rel(file) + " расходится со сборкой (" + ver.version + "): " + versions.firstDiff(have || "", want));
    console.error("   исправление: node tools/build_bookmarklet.js — и закоммитить результат");
    process.exit(1);
  }
  fs.writeFileSync(file, want);
  changed.push(rel(file));
}

console.log("букмарклет собран: код " + code.length + " симв → href " + href.length +
            " симв (лимит закладок ~65K: " + (href.length < 65000 ? "ок" : "ПРЕВЫШЕН!") + ")");
if (CHECK){
  console.log("сборка совпадает с репозиторием: версия " + ver.version + " (format " + ver.format + ") проставлена во все 5 файлов");
} else {
  console.log("версия " + ver.version + " (format " + ver.format + "): " +
              (changed.length ? "обновлено — " + changed.join(", ") : "все файлы уже актуальны"));
}
