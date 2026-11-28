// ============================================================================
// check_versions.js — сверка версий: номер из version.json должен стоять во
// всех частях продукта, и нигде не должно остаться чужого номера.
//   node tools/check_versions.js                    → «версии согласованы»
//   node tools/check_versions.js --tag vX.Y.Z       → метка релиза = version.json
// Расхождение → код 1: выпуск останавливается до сборки.
// ============================================================================
const fs = require("fs");
const path = require("path");
const versions = require("./versions");

const FILES = versions.FILES;
const rel = function(abs){ return path.relative(versions.ROOT, abs); };
const problems = [];
const read = function(f){ return fs.readFileSync(f, "utf8"); };

let ver;
try { ver = versions.readVersion(); }
catch (e){ console.error("✗ " + e.message); process.exit(1); }
const v = ver.version;
const fix = "— исправление: node tools/build_bookmarklet.js";

// 1. страница: у каждого локального скрипта ?v=<версия>, метка = версия
const html = read(FILES.html);
if (versions.stampHtml(html, v) !== html) problems.push(rel(FILES.html) + ": адреса библиотек (?v=) или метка you-market-version не равны " + v + " " + fix);
const scripts = (html.match(/<script\s+src="[^"]*/g) || []).map(function(s){ return s.replace(/<script\s+src="/, ""); });
scripts.forEach(function(src){
  if (!/^[\w.-]+\.[a-z]+\?v=.+$/.test(src)) problems.push(rel(FILES.html) + ": у скрипта «" + src + "» нет номера версии (?v=)" + " " + fix);
  else if (!src.endsWith(".js?v=" + v)) problems.push(rel(FILES.html) + ": «" + src + "» — чужой номер версии" + " " + fix);
});
const meta = /<meta\s+name="you-market-version"\s+content="([^"]*)"/.exec(html);
if (!meta) problems.push(rel(FILES.html) + ": нет метки you-market-version " + fix);
else if (meta[1] !== v) problems.push(rel(FILES.html) + ": метка you-market-version = «" + meta[1] + "», а должно быть " + v + " " + fix);

// 2. пользовательский скрипт: @version и @require нашего сайта
const userjs = read(FILES.userjs);
if (versions.stampUserjs(userjs, v) !== userjs) problems.push(rel(FILES.userjs) + ": @version или @require не равны " + v + " " + fix);
const at = /^\/\/\s*@version\s+(\S+)/m.exec(userjs);
if (!at) problems.push(rel(FILES.userjs) + ": нет поля @version " + fix);
else if (at[1] !== v) problems.push(rel(FILES.userjs) + ": @version = «" + at[1] + "», а должно быть " + v + " " + fix);
(userjs.match(/^\/\/\s*@require\s+\S+/gm) || []).forEach(function(line){
  const url = line.replace(/^\/\/\s*@require\s+/, "");
  if (url.indexOf(versions.SITE) !== 0) return;             // чужая библиотека
  const q = /[?&]v=([^&]*)/.exec(url);
  if (!q || q[1] !== v) problems.push(rel(FILES.userjs) + ": @require «" + url + "» — чужой номер версии " + fix);
});

// 3. оба манифеста расширения
[[FILES.manifest, "Chromium"], [FILES.manifestFirefox, "Firefox"]].forEach(function(pair){
  let m;
  try { m = JSON.parse(read(pair[0])); }
  catch (e){ problems.push(rel(pair[0]) + ": не читается как JSON — " + e.message); return; }
  if (m.version !== v) problems.push(rel(pair[0]) + ": version = «" + m.version + "», а должно быть " + v + " " + fix);
});

// 5. библиотека моста в расширении — та же, что на сайте: расширение собирает
// выдачу тем же кодом, что букмарклет и скрипт, и копия не должна отставать
const extLib = require("path").join(versions.ROOT, "apps", "ext", "bridge-lib.js");
if (fs.existsSync(extLib) && read(extLib) !== read(path.join(versions.WEB, "bridge-lib.js")))
  problems.push("apps/ext/bridge-lib.js отличается от apps/web/bridge-lib.js — исправление: cp apps/web/bridge-lib.js apps/ext/bridge-lib.js");

// 6. метка релиза: vX.Y.Z — ровно номер из version.json
const ti = process.argv.indexOf("--tag");
if (ti >= 0){
  const tag = process.argv[ti + 1] || "";
  if (!tag) problems.push("--tag передан без имени метки");
  else if (!versions.VERSION_RE.test(tag.replace(/^v/, ""))) problems.push("метка «" + tag + "» не вида vX.Y.Z");
  else if (tag !== "v" + v) problems.push("метка «" + tag + "» не совпадает с version.json («" + v + "»): выпуск остановлен");
}

if (problems.length){
  problems.forEach(function(p){ console.error("✗ " + p); });
  console.error("СВЕРКА ВЕРСИЙ НЕ ПРОЙДЕНА: " + problems.length);
  process.exit(1);
}
console.log("версии согласованы: " + v + " (format " + ver.format + ") — страница, скрипт, манифесты расширения" +
            (ti >= 0 ? ", метка " + process.argv[ti + 1] : ""));
