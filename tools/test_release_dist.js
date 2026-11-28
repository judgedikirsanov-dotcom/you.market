// ============================================================================
// test_release_dist.js — тесты выпуска (шаг 5): папка dist/, архив расширения,
// суммы SHA-256, манифест latest.json, воспроизводимость сборки, сверка версий
// и заметки о выпуске. Сеть не нужна.
//   node tools/test_release_dist.js → «ВСЕ ТЕСТЫ ВЫПУСКА ЗЕЛЁНЫЕ»
// Архив в тестах читается собственной читалкой (центральный каталог, CRC от
// zlib.crc32), суммы считаются crypto — то есть не тем кодом, что собирает.
// ============================================================================
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const versions = require("./versions");
const dist = require("./make_release_dist");
const notes = require("./release_notes");
const checkVersions = require("./check_versions");

let passedCount = 0, failedCount = 0;
function ok(cond, name, extra){
  if (cond){ passedCount++; console.log("  ✓ " + name); }
  else { failedCount++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}
function eq(got, want, name){
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w, name, "получено " + String(g).slice(0, 200) + ", ожидалось " + String(w).slice(0, 200));
}
const sha = function(buf){ return crypto.createHash("sha256").update(buf).digest("hex"); };
const sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
const has = function(cmd){ return spawnSync(cmd, ["--version"], { stdio: "ignore" }).error === undefined; };

// самостоятельная читалка ZIP: записи центрального каталога + данные
function readZip(buf){
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--){
    if (buf.readUInt32LE(i) === 0x06054b50){ eocd = i; break; }
  }
  if (eocd < 0) throw new Error("нет записи конца архива");
  const count = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++){
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("нет записи центрального каталога №" + i);
    const e = {
      method: buf.readUInt16LE(p + 10), time: buf.readUInt16LE(p + 12), date: buf.readUInt16LE(p + 14),
      crc: buf.readUInt32LE(p + 16), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24),
      nameLen: buf.readUInt16LE(p + 28), extraLen: buf.readUInt16LE(p + 30), commentLen: buf.readUInt16LE(p + 32),
      attrs: buf.readUInt32LE(p + 38), offset: buf.readUInt32LE(p + 42)
    };
    e.name = buf.toString("utf8", p + 46, p + 46 + e.nameLen);
    p += 46 + e.nameLen + e.extraLen + e.commentLen;
    if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("нет локального заголовка у " + e.name);
    const dataStart = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    const raw = buf.subarray(dataStart, dataStart + e.csize);
    e.data = e.method === 0 ? Buffer.from(raw) : e.method === 8 ? zlib.inflateRawSync(raw) : null;
    entries.push(e);
  }
  return { entries: entries, cdEnd: p, eocd: eocd, size: buf.length };
}

function run(args){
  const r = spawnSync(process.execPath, [path.join(__dirname, "make_release_dist.js")].concat(args), { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function runNotes(args){
  const r = spawnSync(process.execPath, [path.join(__dirname, "release_notes.js")].concat(args), { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function tmp(prefix){ return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rmrf(dir){ try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e){} }

(async function(){
  const ver = versions.readVersion();
  const built = dist.build();

  console.log("сборка папки выпуска");
  (function(){
    eq(built.version, ver.version, "версия выпуска = version.json");
    eq(Object.keys(built.files), [dist.EXT_ZIP, dist.USERJS, dist.SUMS, dist.LATEST], "четыре файла в фиксированном порядке");
    ok(built.files[dist.USERJS].equals(fs.readFileSync(versions.FILES.userjs)), "скрипт в выпуске — байт в байт файл репозитория");
    const sumLines = built.files[dist.SUMS].toString("utf8").split("\n");
    eq(sumLines[sumLines.length - 1], "", "файл сумм заканчивается переводом строки");
    const rows = sumLines.filter(Boolean).map(function(l){
      const m = /^([0-9a-f]{64})  ([\w.-]+)$/.exec(l);
      ok(!!m, "строка сумм в формате coreutils (два пробела, маленькие буквы)", l);
      return m ? { sha256: m[1], name: m[2] } : null;
    }).filter(Boolean);
    eq(rows.map(function(r){ return r.name; }), [dist.EXT_ZIP, dist.USERJS], "суммы даны для архива и скрипта, по алфавиту");
    rows.forEach(function(r){
      eq(r.sha256, sha(built.files[r.name]), "сумма «" + r.name + "» совпадает с файлом (crypto)");
      ok(r.sha256 === dist.sha256(built.files[r.name]), "внутренний sha256 сборщика согласован с crypto");
    });

    const latest = JSON.parse(built.files[dist.LATEST].toString("utf8"));
    eq([latest.version, latest.format, latest.minPageVersion],
       [ver.version, ver.format, dist.FORMAT_MIN_PAGE[ver.format]], "манифест: версия, формат, минимальная версия страницы");
    eq(Object.keys(latest.files), [dist.EXT_ZIP, dist.USERJS], "манифест описывает архив и скрипт");
    Object.keys(latest.files).forEach(function(n){
      eq(latest.files[n], { path: n, sha256: sha(built.files[n]), size: built.files[n].length }, "манифест: «" + n + "» — путь, сумма, размер");
    });
    eq(latest.sha256sums, dist.SUMS, "манифест называет файл сумм");
    ok(built.files[dist.LATEST].toString("utf8").endsWith("}\n"), "манифест — JSON с переводом строки в конце");
    ok(built.files[dist.LATEST].toString("utf8").indexOf("{\n  \"version\"") === 0, "манифест читаем: отступ 2 пробела");
  })();

  console.log("архив расширения");
  (function(){
    const z = readZip(built.files[dist.EXT_ZIP]);
    const names = z.entries.map(function(e){ return e.name; });
    const onDisk = fs.readdirSync(path.join(versions.ROOT, "apps", "ext")).sort();
    eq(dist.EXT_FILES.slice().sort(), onDisk, "в архив попадают все файлы apps/ext и только они");
    eq(names, onDisk, "записи архива — файлы apps/ext по алфавиту");
    eq(new Set(names).size, names.length, "имена в архиве не повторяются");
    ok(names.every(function(n){ return !/[\\\/]/.test(n) && /^[\w.-]+\.(js|json)$/.test(n); }), "файлы лежат в корне архива, имена без каталогов");
    z.entries.forEach(function(e){
      const src = fs.readFileSync(path.join(versions.ROOT, "apps", "ext", e.name));
      ok(e.data && e.data.equals(src), "содержимое «" + e.name + "» совпадает с репозиторием");
      eq(e.crc, zlib.crc32(src), "CRC-32 «" + e.name + "» (zlib.crc32)");
      eq([e.csize, e.usize], [src.length, src.length], "размеры «" + e.name + "»: сжатый = несжатый (без сжатия)");
    });
    const m = JSON.parse(z.entries.find(function(e){ return e.name === "manifest.json"; }).data.toString("utf8"));
    const mf = JSON.parse(z.entries.find(function(e){ return e.name === "manifest.firefox.json"; }).data.toString("utf8"));
    eq([m.version, mf.version], [ver.version, ver.version], "в обоих манифестах внутри архива — номер выпуска");
    eq(m.manifest_version, 3, "манифест Chromium внутри архива читается (Manifest V3)");
    ok(!!mf.browser_specific_settings, "манифест Firefox внутри архива читается (gecko id)");
    eq(new Set(z.entries.map(function(e){ return e.date + "/" + e.time; })).size, 1, "у всех записей одна дата — часы сборки не влияют");
    ok(z.cdEnd === z.eocd && z.eocd + 22 === z.size, "за центральным каталогом сразу конец архива, без мусора");
    if (has("unzip")){
      const t = tmp("ym-unzip-");
      fs.writeFileSync(path.join(t, "ext.zip"), built.files[dist.EXT_ZIP]);
      const r = spawnSync("unzip", ["-tq", path.join(t, "ext.zip")], { encoding: "utf8" });
      ok(r.status === 0 && /No errors detected/.test(r.stdout), "unzip -t: архив цел", (r.stdout + r.stderr).trim().slice(0, 120));
      rmrf(t);
    } else console.log("  · unzip не установлен — пропущено");
  })();

  console.log("воспроизводимость");
  (function(){
    const again = dist.build();
    Object.keys(built.files).forEach(function(n){
      ok(built.files[n].equals(again.files[n]), "повторная сборка в памяти: «" + n + "» байт в байт");
    });
  })();

  const dirA = tmp("ym-rel-a-"), dirB = tmp("ym-rel-b-"), dirC = tmp("ym-rel-c-");
  try {
    console.log("командная строка");
    let r = run(["--out", dirA]);
    ok(r.code === 0, "--out: код 0", r.err.trim().slice(0, 160));
    ok(/папка выпуска собрана/.test(r.out), "--out: сообщение о сборке");
    eq(fs.readdirSync(dirA).sort(), [dist.SUMS, dist.EXT_ZIP, dist.USERJS, dist.LATEST].sort(), "в папке ровно четыре файла");
    ok(fs.readFileSync(path.join(dirA, dist.EXT_ZIP)).equals(built.files[dist.EXT_ZIP]), "архив на диске = архив в памяти");
    r = run(["--check", "--out", dirA]);
    ok(r.code === 0, "--check на свежей папке: код 0", r.err.trim().slice(0, 160));

    // вторая сборка двумя секундами позже: у записей фиксированная дата, архив тот же
    await sleep(2100);
    r = run(["--out", dirB]);
    ok(r.code === 0, "вторая сборка в другую папку: код 0", r.err.trim().slice(0, 160));
    [dist.EXT_ZIP, dist.USERJS, dist.SUMS, dist.LATEST].forEach(function(n){
      ok(fs.readFileSync(path.join(dirA, n)).equals(fs.readFileSync(path.join(dirB, n))), "через 2 секунды «" + n + "» байт в байт");
    });

    const sumsFile = path.join(dirA, dist.SUMS);
    fs.writeFileSync(sumsFile, fs.readFileSync(sumsFile, "utf8").replace(/^[0-9a-f]/, "0"));
    r = run(["--check", "--out", dirA]);
    ok(r.code === 1 && r.err.indexOf(dist.SUMS) > 0, "--check ловит испорченный файл сумм (код 1, назван файл)", r.err.trim().slice(0, 160));
    fs.unlinkSync(path.join(dirA, dist.LATEST));
    r = run(["--check", "--out", dirA]);
    ok(r.code === 1 && r.err.indexOf(dist.LATEST) > 0, "--check ловит отсутствующий манифест", r.err.trim().slice(0, 160));
    r = run(["--out"]);
    ok(r.code === 2, "--out без папки: код 2", "код " + r.code);
    r = run(["--check", "--out", dirC]);
    ok(r.code === 1, "--check пустой папки: код 1", "код " + r.code);

    console.log("заметки о выпуске");
    const tag = "v" + ver.version;
    const body = runNotes(["--tag", tag, "--dist", dirB]);
    ok(body.code === 0, "тело заметок: код 0", body.err.trim().slice(0, 200));
    ok(body.out.indexOf("## Что изменилось") > 0, "в заметках есть раздел «Что изменилось»");
    [ "## Установка", "«Загрузить распакованное расширение»", "## Проверка файлов", "sha256sum -c SHA256SUMS.txt",
      "gh attestation verify " + dist.EXT_ZIP + " --repo " + versions.REPO, "## Файлы", "## Суммы SHA-256" ].forEach(function(s){
      ok(body.out.indexOf(s) >= 0, "в заметках есть: " + s.slice(0, 60));
    });
    built.files[dist.SUMS].toString("utf8").trim().split("\n").forEach(function(line){
      ok(body.out.indexOf(line) >= 0, "в заметках строка сумм: " + line.slice(0, 16) + "…");
    });
    ok(body.out.indexOf("undefined") < 0 && body.out.indexOf("NaN") < 0 && body.out.indexOf("null") < 0, "в заметках нет undefined / NaN / null");
    ok(body.out.split("\n").filter(function(l){ return /^\| \[/.test(l); }).length === 4, "таблица файлов: 4 строки");
    ok(body.out.indexOf("releases/download/" + tag + "/" + dist.USERJS) > 0, "ссылки на файлы ведут на эту метку");
    const title = runNotes(["--tag", tag, "--title", "--dist", dirB]);
    const heading = notes.changelogSection(fs.readFileSync(path.join(versions.ROOT, "CHANGELOG.md"), "utf8"), ver.version).heading;
    ok(title.code === 0 && title.out === heading + "\n", "заголовок = строка раздела CHANGELOG.md", JSON.stringify(title.out));
    r = runNotes(["--tag", "v9.9.9", "--dist", dirB]);
    ok(r.code === 1 && /не совпадает с version.json/.test(r.err), "чужая метка → код 1", r.err.trim().slice(0, 120));
    fs.writeFileSync(path.join(dirB, dist.USERJS), fs.readFileSync(path.join(dirB, dist.USERJS), "utf8") + "// лишняя строка\n");
    r = runNotes(["--tag", tag, "--dist", dirB]);
    ok(r.code === 1 && /не согласована/.test(r.err), "изменённый файл выпуска → заметки не собираются", r.err.trim().slice(0, 160));

    console.log("сверка версий");
    const real = checkVersions.check();
    eq(real.problems, [], "репозиторий согласован (это же проверяет конвейер)");
    const T = tmp("ym-ver-");
    try {
      const copies = ["apps/web/index.html", "apps/web/shuttle.js", "apps/web/channels.js", "apps/web/bridge-lib.js",
                      "apps/web/filter-search.user.js", "apps/ext/manifest.json", "apps/ext/manifest.firefox.json",
                      "apps/ext/bridge-lib.js"];
      copies.forEach(function(rel){
        const to = path.join(T, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(versions.ROOT, rel), to);
      });
      // остальные скрипты страницы — чтобы сверка видела их рядом со страницей
      fs.readdirSync(versions.WEB).filter(function(f){ return /\.js$/.test(f) && copies.indexOf("apps/web/" + f) < 0; }).forEach(function(f){
        fs.copyFileSync(path.join(versions.WEB, f), path.join(T, "apps", "web", f));
      });
      const F = {
        html: path.join(T, "apps/web/index.html"), userjs: path.join(T, "apps/web/filter-search.user.js"),
        manifest: path.join(T, "apps/ext/manifest.json"), manifestFirefox: path.join(T, "apps/ext/manifest.firefox.json"),
        extLib: path.join(T, "apps/ext/bridge-lib.js")
      };
      eq(checkVersions.check({ root: T, files: F }).problems, [], "копия дерева согласована");
      eq(checkVersions.check({ root: T, files: F, tag: "v" + ver.version }).problems, [], "метка = version.json");
      eq(checkVersions.check({ root: T, files: F, tag: "" }).problems, ["--tag передан без имени метки"], "метка без имени");
      const wrong = checkVersions.check({ root: T, files: F, tag: "v9.9.9" });
      eq(wrong.problems, ["метка «v9.9.9» не совпадает с version.json («" + ver.version + "»): выпуск остановлен"], "чужая метка останавливает выпуск");
      eq(checkVersions.check({ root: T, files: F, tag: "v" + ver.version.slice(0, -2) }).problems.length, 1, "метка не вида vX.Y.Z");
      const bumped = checkVersions.check({ root: T, files: F, version: { version: "9.9.9", format: 1 } });
      ok(bumped.problems.length >= 5, "новый номер без пересборки: замечания по каждому файлу (" + bumped.problems.length + ")");
      ["index.html", "filter-search.user.js", "manifest.json", "manifest.firefox.json"].forEach(function(f){
        ok(bumped.problems.some(function(p){ return p.indexOf(f) > 0; }), "…назван " + f);
      });
      fs.unlinkSync(path.join(T, "apps/web/shuttle.js"));
      ok(checkVersions.check({ root: T, files: F }).problems.some(function(p){ return /shuttle\.js.*не лежит рядом/.test(p); }),
         "скрипт страницы без файла замечен");
      fs.copyFileSync(path.join(versions.WEB, "shuttle.js"), path.join(T, "apps/web/shuttle.js"));
      eq(checkVersions.check({ root: T, files: F }).problems, [], "возвращённый файл снимает замечание");
      fs.appendFileSync(F.extLib, "// правка\n");
      ok(checkVersions.check({ root: T, files: F }).problems.some(function(p){ return /отличается от/.test(p); }),
         "копия моста в расширении отстала — замечено");
    } finally { rmrf(T); }
  } finally { rmrf(dirA); rmrf(dirB); rmrf(dirC); }

  console.log("читалка CHANGELOG");
  (function(){
    const text = ["# Журнал", "", "## v1.2.0 — новое", "", "строка А", "", "## v1.1.0 — старое", "строка Б", "## v1.1.01 — похожее", "строка В"].join("\n");
    eq(notes.changelogSection(text, "1.2.0"), { heading: "v1.2.0 — новое", body: "строка А" }, "раздел версии и только он");
    eq(notes.changelogSection(text, "1.1.0").body, "строка Б", "похожий номер (v1.1.01) не подтягивается");
    eq(notes.changelogSection(text, "1.1.01").body, "строка В", "последний раздел читается до конца файла");
    eq(notes.changelogSection(text, "9.9.9"), null, "нет раздела — null");
    eq(notes.human(176), "176 Б", "размер в байтах");
    eq(notes.human(35043), "34,2 КБ", "размер в килобайтах, запятая");
  })();

  console.log("");
  if (failedCount){ console.log("ПРОВАЛЕНО: " + failedCount); process.exit(1); }
  console.log("ВСЕ ТЕСТЫ ВЫПУСКА ЗЕЛЁНЫЕ (" + passedCount + " проверок)");
})().catch(function(e){
  console.error("тест выпуска упал с ошибкой: " + (e && e.stack || e));
  process.exit(1);
});
