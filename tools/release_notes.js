// ============================================================================
// release_notes.js — заметки о выпуске (Markdown) для страницы релиза GitHub.
// Собираются из трёх источников и печатаются в stdout:
//   • CHANGELOG.md   — раздел текущей версии (что изменилось);
//   • папка выпуска  — суммы SHA-256, размеры файлов, манифест latest.json;
//   • git            — коммит метки и предыдущая метка (ссылка «что изменилось
//                     с прошлого выпуска»); git читается только когда
//                     репозиторий — это сама папка продукта.
//
//   node tools/release_notes.js                      → тело заметок
//   node tools/release_notes.js --title              → только заголовок релиза
//   node tools/release_notes.js --tag vX.Y.Z --dist dist
//
// Код 1, если метка не равна version.json, в CHANGELOG.md нет раздела для
// текущей версии или файлы в папке выпуска не совпадают с SHA256SUMS.txt:
// релиз не должен публиковаться с пустыми или неверными заметками.
// ============================================================================
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const versions = require("./versions");
const dist = require("./make_release_dist");

// раздел «## vX.Y.Z — …» до следующего заголовка того же уровня
function changelogSection(text, v){
  const lines = text.split("\n");
  const head = new RegExp("^##\\s+v?" + v.replace(/\./g, "\\.") + "(?=\\s|$)");
  const start = lines.findIndex(function(l){ return head.test(l); });
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++){
    if (/^#{1,2}\s/.test(lines[i])){ end = i; break; }
  }
  const body = lines.slice(start + 1, end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { heading: lines[start].replace(/^##\s+/, "").trim(), body: body.join("\n") };
}

// git в папке продукта; null — если git нет или папка лежит внутри чужого
// репозитория (тогда метки и коммиты относятся не к продукту)
function git(args){
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: versions.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (fs.realpathSync(top) !== fs.realpathSync(versions.ROOT)) return null;
    return execFileSync("git", args, { cwd: versions.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e){ return null; }
}

function versionNumbers(tag){
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareVersions(a, b){
  for (let i = 0; i < 3; i++){ if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}

// предыдущая метка выпуска: старше по номеру и входит в историю текущей
function previousTag(tag, v){
  const list = git(["tag", "--list", "v*.*.*", "--sort=-v:refname"]);
  if (list === null) return null;
  const cur = versionNumbers(v);
  for (const t of list ? list.split("\n") : []){
    const nums = versionNumbers(t);
    if (!nums || compareVersions(nums, cur) >= 0) continue;
    if (git(["merge-base", "--is-ancestor", t, tag]) !== null) return t;
  }
  return null;
}

function human(bytes){
  return bytes < 1024 ? bytes + " Б" : (bytes / 1024).toFixed(1).replace(".", ",") + " КБ";
}

// тело заметок; throw с описанием, когда выпуск описывать нечем или нечем доверять
function buildNotes(opts){
  const ver = versions.readVersion();
  const v = ver.version;
  const tag = opts.tag || "v" + v;
  if (tag !== "v" + v)
    throw new Error("метка «" + tag + "» не совпадает с version.json («" + v + "»)");

  const section = changelogSection(fs.readFileSync(path.join(versions.ROOT, "CHANGELOG.md"), "utf8"), v);
  if (!section || !section.body)
    throw new Error("в CHANGELOG.md нет раздела для версии " + v + " — выпуск без описания не публикуется");

  // папка выпуска: манифест и суммы обязаны описывать именно те файлы, что лежат рядом
  const dir = opts.dist;
  const read = function(name){ return fs.readFileSync(path.join(dir, name)); };
  let latest;
  try { latest = JSON.parse(read(dist.LATEST).toString("utf8")); }
  catch (e){ throw new Error("в папке выпуска не читается " + dist.LATEST + " — " + e.message); }
  const problems = [];
  if (latest.version !== v) problems.push(dist.LATEST + ": version = «" + latest.version + "», а выпускается " + v);
  const installables = [dist.EXT_ZIP, dist.USERJS];
  installables.forEach(function(n){
    const have = fs.existsSync(path.join(dir, n)) ? dist.sha256(read(n)) : null;
    const f = latest.files && latest.files[n];
    if (!have) problems.push("в папке выпуска нет файла " + n);
    else if (!f) problems.push(dist.LATEST + " не описывает " + n);
    else if (f.sha256 !== have || f.size !== read(n).length) problems.push(dist.LATEST + " не совпадает с файлом " + n);
  });
  const sumLines = read(dist.SUMS).toString("utf8").trim().split("\n").map(function(line){
    const m = /^([0-9a-f]{64})  (\S+)$/.exec(line);
    if (!m){ problems.push(dist.SUMS + ": строка не формата coreutils — «" + line + "»"); return null; }
    const file = path.join(dir, m[2]);
    if (!fs.existsSync(file)) problems.push(dist.SUMS + ": файла " + m[2] + " нет в папке выпуска");
    else if (dist.sha256(fs.readFileSync(file)) !== m[1]) problems.push(dist.SUMS + ": сумма не совпадает с файлом " + m[2]);
    return m[2];
  }).filter(Boolean);
  // суммы не описывают сами себя — в файле ровно две строки: архив и скрипт
  installables.forEach(function(n){
    if (sumLines.indexOf(n) < 0) problems.push(dist.SUMS + " не содержит строку для " + n);
  });
  if (sumLines.length !== installables.length) problems.push(dist.SUMS + ": строк " + sumLines.length + ", а должно быть " + installables.length);
  if (problems.length) throw new Error("папка выпуска не согласована — пересоберите её (node tools/make_release_dist.js):\n  " + problems.join("\n  "));

  if (opts.titleOnly) return section.heading + "\n";

  const base = "https://github.com/" + versions.REPO;
  const asset = function(n){ return base + "/releases/download/" + tag + "/" + n; };
  const commit = git(["rev-parse", "--short", tag + "^{commit}"]);
  const prev = previousTag(tag, v);
  const WHAT = {};
  WHAT[dist.EXT_ZIP] = "расширение-мост для браузеров на Chromium";
  WHAT[dist.USERJS] = "скрипт-мост для менеджеров скриптов (Violentmonkey, Tampermonkey)";
  WHAT[dist.SUMS] = "суммы SHA-256 файлов выпуска";
  WHAT[dist.LATEST] = "манифест: номер версии, формат данных, минимальная версия страницы, суммы и размеры файлов";
  const rows = installables.concat([dist.SUMS, dist.LATEST]).map(function(n){
    return "| [" + n + "](" + asset(n) + ") | " + human(read(n).length) + " | " + WHAT[n];
  }).join("\n");

  return [
    "Выпуск " + tag + (commit ? " собран сценарием `release` из коммита `" + commit + "`." : " собирает сценарий `release` по метке.") +
      " К файлам приложен аттестат сборки — свидетельство, что они собраны этим сценарием в репозитории " +
      versions.REPO + ". Как проверить файлы и аттестат — ниже.",
    "",
    "## Что изменилось",
    "",
    section.body,
    "",
    prev ? "Все коммиты с прошлого выпуска (" + prev + "): " + base + "/compare/" + prev + "..." + tag
         : "Это первый выпуск с журналом изменений: разделы более ранних версий — в [CHANGELOG.md](" +
           "https://github.com/" + versions.REPO + "/blob/" + tag + "/CHANGELOG.md).",
    "",
    "## Установка",
    "",
    "### Расширение — Chrome, Edge и другие браузеры на Chromium",
    "",
    "1. Скачайте `filter-search-ext.zip` и распакуйте в отдельную папку.",
    "2. Откройте страницу расширений — `chrome://extensions` (в Edge — `edge://extensions`) — и включите «Режим разработчика».",
    "3. Нажмите «Загрузить распакованное расширение» и выберите распакованную папку.",
    "",
    "Расширение ставится только так: в магазинах браузеров его нет. Для обновления распакуйте новый архив вместо старого и нажмите «Обновить» на карточке расширения.",
    "",
    "### Скрипт — Firefox, Chrome",
    "",
    "1. Поставьте менеджер скриптов: Violentmonkey (Firefox) или Tampermonkey (Chrome).",
    "2. Откройте [filter-search.user.js из этого выпуска](" + asset(dist.USERJS) + ") и подтвердите установку.",
    "",
    "Менеджер скриптов берёт обновления по адресу, записанному в скрипте: сайт публикует текущую версию из ветки `main`.",
    "",
    "### Страница",
    "",
    versions.SITE + " — обновляется с каждым изменением `main`. Открытая вкладка сама предупредит, что вышла новая версия.",
    "",
    "## Проверка файлов",
    "",
    "Положите `SHA256SUMS.txt` в одну папку с файлами выпуска.",
    "",
    "- Linux: `sha256sum -c SHA256SUMS.txt`",
    "- macOS: `shasum -a 256 -c SHA256SUMS.txt`",
    "- Windows (PowerShell): `Get-FileHash .\\" + dist.EXT_ZIP + " -Algorithm SHA256` — сравните с суммой ниже.",
    "",
    "Аттестат сборки (нужен GitHub CLI): `gh attestation verify " + dist.EXT_ZIP + " --repo " + versions.REPO + "`.",
    "",
    "### Суммы SHA-256",
    "",
    "```",
    read(dist.SUMS).toString("utf8").trim(),
    "```",
    "",
    "## Файлы",
    "",
    "| Файл | Размер | Что это |",
    "| --- | --- | --- |",
    rows,
    "",
    "Последний выпуск — всегда здесь: " + versions.RELEASES + "/latest. Постоянные ссылки на файлы: `" +
      versions.RELEASES + "/latest/download/<имя-файла>`.",
    ""
  ].join("\n");
}

if (require.main === module){
  const argv = process.argv.slice(2);
  const di = argv.indexOf("--dist");
  const ti = argv.indexOf("--tag");
  try {
    const out = buildNotes({
      tag: ti >= 0 ? (argv[ti + 1] || "") : null,
      titleOnly: argv.includes("--title"),
      dist: path.resolve(di >= 0 ? (argv[di + 1] || "") : path.join(versions.ROOT, "dist"))
    });
    process.stdout.write(out);
  } catch (e){
    console.error("✗ " + e.message);
    process.exit(1);
  }
}

module.exports = { changelogSection: changelogSection, previousTag: previousTag, human: human, buildNotes: buildNotes };
