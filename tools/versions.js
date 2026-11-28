// ============================================================================
// versions.js — единый номер версии (version.json) и его проставление во все
// части продукта. Читают сборщик закладки (tools/build_bookmarklet.js) и
// сверка версий (tools/check_versions.js) — одни и те же правила, поэтому
// «собрать» и «проверить» не могут разойтись.
//
// Номер хранится один раз — в version.json — вместе с номером формата данных.
// Сборщик подставляет его в четыре места: параметр ?v= у библиотек страницы,
// поле @version и адреса @require пользовательского скрипта, поле version
// обоих манифестов расширения. Для страницы адрес с новым номером —
// единственный способ обновить библиотеку у посетителя.
// ============================================================================
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const FILES = {
  html: path.join(WEB, "index.html"),
  userjs: path.join(WEB, "filter-search.user.js"),
  manifest: path.join(ROOT, "apps", "ext", "manifest.json"),
  manifestFirefox: path.join(ROOT, "apps", "ext", "manifest.firefox.json"),
  bookmarklet: path.join(WEB, "bookmarklet.js")
};
const SITE = "https://judgedikirsanov-dotcom.github.io/you.market/";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function readVersion(){
  var raw = JSON.parse(fs.readFileSync(path.join(ROOT, "version.json"), "utf8"));
  var v = String(raw.version == null ? "" : raw.version);
  if (!VERSION_RE.test(v))
    throw new Error("version.json: поле version должно быть вида X.Y.Z, получено «" + v + "»");
  if (!Number.isInteger(raw.format) || raw.format < 1)
    throw new Error("version.json: поле format — целое число от 1, получено " + JSON.stringify(raw.format));
  return { version: v, format: raw.format };
}

// страница: ?v= у каждого локального <script src> и метка you-market-version
// (её читает app.js — версия попадает в отчёт этапа 0); внешние библиотеки
// с полным адресом не трогаем — их версия не наша
function stampHtml(html, v){
  return html
    .replace(/(<script\s+src=")([\w.-]+\.[a-z]+)(\?v=[^"]*)?(")/g, function(_, a, file, old, c){
      return a + file + "?v=" + v + c;
    })
    .replace(/(<meta\s+name="you-market-version"\s+content=")([^"]*)(")/, function(_, a, old, c){
      return a + v + c;
    });
}

// пользовательский скрипт: @version и адреса @require библиотек нашего сайта
function stampUserjs(src, v){
  return src
    .replace(/^(\/\/\s*@version\s+)\S+/m, function(_, a){ return a + v; })
    .replace(/^(\/\/\s*@require\s+)(\S+)(\s*)$/gm, function(_, a, url, tail){
      if (url.indexOf(SITE) !== 0) return _;            // чужие библиотеки не трогаем
      var clean = url.replace(/\?v=[^&]*&/, "?").replace(/[?&]v=[^&]*/, "");
      return a + clean + (clean.indexOf("?") >= 0 ? "&" : "?") + "v=" + v + tail;
    });
}

// манифест расширения: поле version; остальной текст файла — как был
// (форматирование не трогаем, чтобы diff показывал только номер)
function stampManifest(text, v){
  JSON.parse(text);   // файл обязан оставаться валидным JSON
  var re = /("version"\s*:\s*)"[^"]*"/;
  if (!re.test(text)) throw new Error("манифест расширения не содержит поля version");
  return text.replace(re, function(_, a){ return a + '"' + v + '"'; });
}

// первая строка, где два текста расходятся, — для сообщений «пересобрать и сравнить»
function firstDiff(a, b){
  var la = a.split("\n"), lb = b.split("\n");
  for (var i = 0; i < Math.max(la.length, lb.length); i++){
    if (la[i] !== lb[i]){
      var cut = function(s){ return String(s == null ? "<конец файла>" : s).slice(0, 110); };
      return "строка " + (i + 1) + ": в репозитории «" + cut(la[i]) + "», при сборке «" + cut(lb[i]) + "»";
    }
  }
  return "";
}

module.exports = { ROOT: ROOT, WEB: WEB, FILES: FILES, SITE: SITE, VERSION_RE: VERSION_RE,
                   readVersion: readVersion, stampHtml: stampHtml, stampUserjs: stampUserjs,
                   stampManifest: stampManifest, firstDiff: firstDiff };
