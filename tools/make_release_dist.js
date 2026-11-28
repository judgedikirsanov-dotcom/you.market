// ============================================================================
// make_release_dist.js — сборщик папки выпуска dist/: архив расширения,
// пользовательский скрипт, суммы SHA-256 и манифест latest.json.
//
//   node tools/make_release_dist.js              — собрать в dist/
//   node tools/make_release_dist.js --out ПАПКА  — собрать в другую папку
//   node tools/make_release_dist.js --check      — ничего не писать: собрать
//        в памяти и сравнить с папкой; расхождение → код 1
//
// Архив собирается здесь же, без внешнего zip: записи без сжатия и с одной
// датой у всех файлов, поэтому байты архива зависят только от содержимого.
// Повторная сборка на другой машине или в другой версии Node даёт тот же
// файл: суммы из релиза можно проверить, пересобрав выпуск из исходников.
// Файлы расширения лежат в корне архива — распакованную папку браузер
// принимает как есть («Загрузить распакованное»).
//
// Сборка не начинается, если версии в репозитории не согласованы
// (tools/check_versions.js): в выпуск не может попасть файл со старым номером.
// Порядок выпуска описан в apps/web/README.md, раздел «Как выпустить версию».
// ============================================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const versions = require("./versions");
const checkVersions = require("./check_versions");

const ROOT = versions.ROOT;
const EXT_DIR = path.join(ROOT, "apps", "ext");

// что из apps/ext уходит в архив расширения — перечислено по именам, чтобы
// случайный файл из папки (черновик, ключ, резервная копия) не попал в выпуск;
// тесты сверяют список с содержимым папки
const EXT_FILES = ["bg.js", "bridge-lib.js", "content-serp.js", "content-site.js",
                   "manifest.firefox.json", "manifest.json", "serp_allow.js"];
const EXT_ZIP = "filter-search-ext.zip";
const USERJS = "filter-search.user.js";
const SUMS = "SHA256SUMS.txt";
const LATEST = "latest.json";
// минимальная версия страницы, которая понимает формат данных с этим номером
// (поле format в version.json; номер 1 существует с версии 3.0.0, когда поле
// и появилось). Страница старше этой версии манифест не поймёт.
const FORMAT_MIN_PAGE = { 1: "3.0.0" };

// ZIP-запись без сжатия. Дата у всех файлов одна — 1980-01-01 00:00 (самая
// ранняя допустимая в формате): часы сборки на архив не влияют.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const CRC_TABLE = (function(){
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf){
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, data: Buffer }] — имена относительные, порядок = порядок в архиве
function zipStored(files){
  const local = [], central = [];
  let offset = 0;
  for (const f of files){
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);           // сигнатура локального заголовка
    lh.writeUInt16LE(20, 4);                   // версия спецификации 2.0
    lh.writeUInt16LE(UTF8_FLAG, 6);
    lh.writeUInt16LE(0, 8);                    // метод: без сжатия
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);                   // без extra-поля
    local.push(lh, name, f.data);

    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0);           // сигнатура записи центрального каталога
    ce.writeUInt16LE(0x0314, 4);               // создан в Unix, спецификация 2.0
    ce.writeUInt16LE(20, 6);
    ce.writeUInt16LE(UTF8_FLAG, 8);
    ce.writeUInt16LE(0, 10);
    ce.writeUInt16LE(DOS_TIME, 12);
    ce.writeUInt16LE(DOS_DATE, 14);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(f.data.length, 20);
    ce.writeUInt32LE(f.data.length, 24);
    ce.writeUInt16LE(name.length, 28);
    ce.writeUInt16LE(0, 30);                   // extra
    ce.writeUInt16LE(0, 32);                   // комментарий
    ce.writeUInt16LE(0, 34);                   // номер диска
    ce.writeUInt16LE(0, 36);                   // внутренние атрибуты
    ce.writeUInt32LE((0o100644 << 16) >>> 0, 38);   // обычный файл, права 0644
    ce.writeUInt32LE(offset, 42);
    central.push(ce, name);
    offset += lh.length + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);           // сигнатура конца архива
  eocd.writeUInt16LE(files.length, 8);         // всего записей
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(local.concat([cd, eocd]));
}

function sha256(buf){
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// собирает все файлы выпуска в памяти → { version, format, files: { имя: Buffer } }
function build(){
  const res = checkVersions.check();
  if (res.problems.length)
    throw new Error("версии не согласованы — выпуск не собран:\n  " + res.problems.join("\n  "));

  const files = {};
  const ext = EXT_FILES.map(function(name){
    const file = path.join(EXT_DIR, name);
    if (!fs.existsSync(file)) throw new Error("нет файла расширения apps/ext/" + name);
    return { name: name, data: fs.readFileSync(file) };
  });
  files[EXT_ZIP] = zipStored(ext);
  files[USERJS] = fs.readFileSync(versions.FILES.userjs);

  // суммы в формате coreutils: <сумма>  <имя> — так файл принимает sha256sum -c
  const describe = function(name){ return { sha256: sha256(files[name]), size: files[name].length }; };
  const installables = [EXT_ZIP, USERJS];
  files[SUMS] = Buffer.from(installables.map(function(n){ return describe(n).sha256 + "  " + n; }).join("\n") + "\n", "utf8");

  const minPage = FORMAT_MIN_PAGE[res.format];
  if (!minPage) throw new Error("для формата данных " + res.format + " не задана минимальная версия страницы (FORMAT_MIN_PAGE)");
  const manifest = { version: res.version, format: res.format, minPageVersion: minPage, files: {}, sha256sums: SUMS };
  installables.forEach(function(n){
    const d = describe(n);
    manifest.files[n] = { path: n, sha256: d.sha256, size: d.size };
  });
  files[LATEST] = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { version: res.version, format: res.format, minPageVersion: minPage, files: files };
}

if (require.main === module){
  const argv = process.argv.slice(2);
  const CHECK = argv.includes("--check");
  const oi = argv.indexOf("--out");
  if (oi >= 0 && !argv[oi + 1]){ console.error("✗ --out передан без папки"); process.exit(2); }
  const out = path.resolve(oi >= 0 ? argv[oi + 1] : path.join(ROOT, "dist"));

  let built;
  try { built = build(); }
  catch (e){ console.error("✗ " + e.message); process.exit(1); }

  const names = Object.keys(built.files);
  const changed = [];
  for (const name of names){
    const file = path.join(out, name), want = built.files[name];
    const have = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (have && have.equals(want)) continue;
    if (!CHECK){
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(file, want);
    }
    changed.push(name);
  }
  if (CHECK){
    if (changed.length){
      console.error("✗ папка выпуска расходится со сборкой (" + built.version + "): " + changed.join(", "));
      console.error("   исправление: node tools/make_release_dist.js --out " + out);
      process.exit(1);
    }
    console.log("папка выпуска совпадает со сборкой: версия " + built.version + " (format " + built.format + "), " +
                names.length + " файла в " + path.relative(process.cwd(), out) + "/");
  } else {
    const total = names.reduce(function(s, n){ return s + built.files[n].length; }, 0);
    console.log("папка выпуска собрана: версия " + built.version + " (format " + built.format + ", мин. страница " +
                built.minPageVersion + ") → " + path.relative(process.cwd(), out) + "/ — " +
                (changed.length ? "записано " + changed.join(", ") : "все файлы уже актуальны") +
                " (" + names.length + " файла, " + total + " байт)");
    names.forEach(function(n){ console.log("  " + sha256(built.files[n]).slice(0, 16) + "…  " + n + "  " + built.files[n].length + " байт"); });
  }
}

module.exports = { build: build, zipStored: zipStored, crc32: crc32, sha256: sha256,
                   EXT_FILES: EXT_FILES, EXT_ZIP: EXT_ZIP, USERJS: USERJS, SUMS: SUMS, LATEST: LATEST,
                   FORMAT_MIN_PAGE: FORMAT_MIN_PAGE };
