// ============================================================================
// shuttle_tests.js — офлайн-тесты канала «Шаттл» (этап 2) и выбора канала
// сбора (шаг 8). Проверяют очередь источников, порядок обхода, маркер в адресе,
// хранилище вкладки и таблицу выбора канала. Сеть не нужна.
//   node tests/shuttle_tests.js   → «ВСЕ ТЕСТЫ ШАТТЛА И КАНАЛОВ ЗЕЛЁНЫЕ»
// ============================================================================
"use strict";
var Sh = require("../shuttle.js");
var Ch = require("../channels.js");

var passed = 0, failed = 0;
function ok(cond, name, extra){
  if (cond){ passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}
function eq(got, want, name){
  var g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w, name, "получено " + g + ", ожидалось " + w);
}

console.log("маркер шаттла в адресе");
(function(){
  eq(Sh.addMarker("https://yandex.ru/search/?text=a"), "https://yandex.ru/search/?text=a&fsh=1", "вопрос уже есть → &fsh=1");
  eq(Sh.addMarker("https://example.ru/catalog"), "https://example.ru/catalog?fsh=1", "вопроса нет → ?fsh=1");
  eq(Sh.addMarker("https://example.ru/?a=1&fsh=1"), "https://example.ru/?a=1&fsh=1", "маркер ставится один раз");
  eq(Sh.addMarker("https://example.ru/p?x=1#frag"), "https://example.ru/p?x=1&fsh=1#frag", "маркер ставится до #");
  eq(Sh.addMarker("javascript:alert(1)"), "javascript:alert(1)", "не http(s)-адрес не помечается");
  eq(Sh.addMarker(""), "", "пустой адрес остаётся пустым");
  ok(Sh.isShuttleUrl("https://www.google.com/search?q=a&fsx=1&fsh=1"), "fsx=1&fsh=1 — адрес шаттла");
  ok(Sh.isShuttleUrl("https://www.google.com/search?q=a&fsh=1#top"), "маркер перед # замечен");
  ok(!Sh.isShuttleUrl("https://www.google.com/search?q=a&fsx=1"), "без маркера — не шаттл");
  ok(!Sh.isShuttleUrl("https://www.google.com/search?q=fsh=1x"), "fsh=1x — не маркер");
  ok(!Sh.isShuttleUrl(null), "null — не шаттл");
})();

console.log("очередь источников: сборка и разбор");
(function(){
  var sh = Sh.pack({ sid: "s1", q: "sava a7l carbon", at: 5, entries: [
    { id: "yandex", url: "https://yandex.ru/search/?text=a&fsx=1" },
    { id: "ozon", url: "https://www.ozon.ru/search/?text=a&fsx=1" },
    { id: "yandex", url: "https://yandex.ru/search/?text=duplicate" },
    { id: "", url: "https://example.ru/" },
    { id: "bad", url: "javascript:alert(1)" },
    { url: "https://example.ru/" }
  ]});
  ok(!!sh, "очередь собралась");
  eq(sh.entries.map(function(e){ return e.id; }), ["yandex", "ozon"], "повторы и источники без адреса отсеяны");
  ok(Sh.isShuttleUrl(sh.entries[0].url), "маркер проставлен в адреса очереди");
  eq(sh.entries[0].url, "https://yandex.ru/search/?text=a&fsx=1&fsh=1", "существующие параметры сохранены");
  eq(sh.done, {}, "в начале ничего не пройдено");
  eq([sh.sid, sh.q, sh.at, sh.v], ["s1", "sava a7l carbon", 5, 1], "идентификатор, запрос и время перенесены");
  eq(Sh.pack(null), null, "без очереди — null");
  eq(Sh.pack({ entries: [] }), null, "пустая очередь — null");
  eq(Sh.pack({ entries: [{ id: "x", url: "javascript:alert(1)" }] }), null, "только опасные адреса — null");
  eq(Sh.pack({ entries: [{ id: 7, url: "https://example.ru/" }] }).entries[0].id, "7", "идентификатор приводится к строке");

  var back = Sh.parse(Sh.serialize(sh));
  eq(back, sh, "parse(serialize(x)) возвращает очередь");
  back.done.ozon = 1;
  ok(sh.done.ozon === undefined, "разобранная очередь — независимая копия");
  eq(Sh.parse(""), null, "пустая строка — null");
  eq(Sh.parse("{not json"), null, "битый JSON — null");
  eq(Sh.parse("42"), null, "не объект — null");
  eq(Sh.parse({"entries": []}), null, "не строка — null");
  eq(Sh.parse(JSON.stringify({ v: 1, entries: [{ id: "a", url: "https://example.ru/" }], done: {} })),
     null, "очередь без маркера в адресе не принимается");
  eq(Sh.parse(JSON.stringify({ v: 1, entries: [{ id: "a", url: "https://example.ru/?fsh=1" }] })), null, "очередь без списка пройденных не принимается");
  ok(!Sh.valid(null) && !Sh.valid({}) && !Sh.valid({ entries: [] }), "valid отклоняет пустое");
})();

function queue(){ return Sh.pack({ sid: "s", q: "q", entries: [
  { id: "yandex", url: "https://yandex.ru/search/?text=a" },
  { id: "ozon", url: "https://www.ozon.ru/search/?text=a" },
  { id: "google", url: "https://www.google.com/search?q=a" }
]}); }

console.log("обход очереди");
(function(){
  var sh = queue();
  eq(Sh.nextEntry(sh, null).id, "yandex", "начало — первый источник");
  eq(Sh.nextEntry(sh, "yandex").id, "ozon", "после Яндекса — Ozon");
  eq(Sh.nextEntry(sh, "ozon").id, "google", "после Ozon — Google");
  eq(Sh.nextEntry(sh, "google").id, "yandex", "после последнего — снова первый непройденный");
  Sh.markDone(sh, "yandex");
  eq(Sh.nextEntry(sh, "google").id, "ozon", "пройденный источник пропускается");
  Sh.markDone(sh, "ozon");
  eq(Sh.nextEntry(sh, "yandex").id, "google", "позади отмеченных ищем до конца очереди");
  Sh.markDone(sh, "google");
  eq(Sh.nextEntry(sh, "yandex"), null, "всё пройдено — следующего нет");
  eq(Sh.progress(sh), { total: 3, done: 3 }, "прогресс: 3 из 3");

  var out = queue();
  eq(Sh.nextEntry(out, "google").id, "yandex", "выдача пришла не по порядку — начинаем с первого");
  Sh.markDone(out, "google");
  eq(Sh.nextEntry(out, "google").id, "yandex", "не по порядку: после Google идёт Яндекс");
  Sh.markDone(out, "yandex");
  eq(Sh.nextEntry(out, "yandex").id, "ozon", "не по порядку: затем Ozon");
  eq(Sh.progress(out), { total: 3, done: 2 }, "прогресс: 2 из 3");

  var own = queue();
  eq(Sh.nextEntry(own, "bing").id, "yandex", "источника нет в очереди — с первого непройденного");
  Sh.markDone(own, "yandex");
  Sh.markDone(own, "yandex");
  eq(Sh.remaining(own), ["ozon", "google"], "повторная отметка ничего не ломает");
  eq(Sh.markDone(own, "bing"), ["ozon", "google"], "источник вне очереди не отмечается");
  Sh.markDone(own, "ozon"); Sh.markDone(own, "google");
  eq(Sh.nextEntry(own, "bing"), null, "свой источник в шаттле не продлевает очередь");
  eq(Sh.nextEntry(null, "yandex"), null, "без очереди следующего нет");
  eq(Sh.remaining(null), [], "без очереди список пуст");
  eq(Sh.progress(null), { total: 0, done: 0 }, "прогресс без очереди — нули");
})();

console.log("хранилище вкладки");
(function(){
  eq(Sh.load(), null, "без sessionStorage очереди нет");
  ok(Sh.save(queue()) === false, "без sessionStorage очередь не сохраняется");
  ok(Sh.storageOk() === false, "без sessionStorage шаттл недоступен");
  ok(Sh.clear() === undefined, "clear без хранилища не бросает исключение");

  var mem = {};
  globalThis.sessionStorage = {
    getItem: function(k){ return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function(k, v){ mem[k] = String(v); },
    removeItem: function(k){ delete mem[k]; }
  };
  ok(Sh.storageOk() === true, "хранилище доступно");
  var sh = queue();
  ok(Sh.save(sh) === true, "очередь сохранена");
  eq(Sh.load(), sh, "очередь читается обратно");
  var copy = Sh.load();
  Sh.markDone(copy, "yandex");
  Sh.save(copy);
  eq(Sh.remaining(Sh.load()), ["ozon", "google"], "отметка читается из хранилища");
  Sh.clear();
  eq(Sh.load(), null, "после clear очереди нет");
  ok(Object.keys(mem).length === 0, "проба хранилища не оставляет ключей");
  ok(Sh.save(null) === false, "пустую очередь не сохраняем");
  delete globalThis.sessionStorage;
})();

console.log("выбор канала");
(function(){
  eq(Ch.pick({}), { channel: "windows", why: "хранилище вкладки недоступно — окна источников" }, "ничего нет → окна");
  eq(Ch.pick({ shuttlePossible: true }).channel, "shuttle", "без расширения → «Шаттл»");
  eq(Ch.pick({ shuttlePossible: true, extensionReady: true }).channel, "extension", "расширение лучше «Шаттла»");
  eq(Ch.pick({ shuttlePossible: true, helperEnabled: true, helperReady: true }).channel, "helper", "помощник лучше всех");
  eq(Ch.pick({ shuttlePossible: true, extensionReady: true, helperEnabled: true, helperReady: true }).channel, "helper", "помощник лучше расширения");
  eq(Ch.pick({ shuttlePossible: true, helperEnabled: true, helperReady: false }).channel, "shuttle", "помощник включён, но не ответил → «Шаттл»");
  eq(Ch.pick({ shuttlePossible: true, extensionReady: true, helperEnabled: true, helperReady: false }).channel, "extension", "помощник не ответил → расширение");
  eq(Ch.pick({ shuttlePossible: true, helperReady: true }).channel, "shuttle", "помощник выключен (этапа 3 ещё нет) → «Шаттл»");
  eq(Ch.pick({ shuttlePossible: false, extensionReady: false }).channel, "windows", "нет хранилища → окна");
  eq(Ch.pick({ shuttlePossible: false, extensionReady: true }).channel, "extension", "нет хранилища, но есть расширение → расширение");

  eq(Ch.pick({ pref: "shuttle", shuttlePossible: true, extensionReady: true }).channel, "shuttle", "селектор: «Шаттл» важнее расширения");
  eq(Ch.pick({ pref: "shuttle", shuttlePossible: false }).channel, "windows", "селектор: «Шаттл» недоступен → окна");
  eq(Ch.pick({ pref: "windows", shuttlePossible: true, extensionReady: true }).channel, "windows", "селектор: окна важнее всего");
  eq(Ch.pick({ pref: "auto", shuttlePossible: true }).channel, "shuttle", "селектор: «авто» — как без селектора");
  eq(Ch.pick({ pref: "erunda", shuttlePossible: true }).channel, "shuttle", "селектор: чужое значение = «авто»");
  ok(Ch.pick({ shuttlePossible: true }).why.length > 0, "к выбору приложена причина (для журнала)");
  ok(Ch.pick() && Ch.pick(null), "pick без аргументов не бросает исключение");

  ["helper", "extension", "shuttle", "windows"].forEach(function(c){
    ok(Ch.label(c) !== c, "у канала «" + c + "» есть название");
  });
  ok(Ch.HELPER.enabled === false, "помощник выключен до этапа 3 (иначе браузер спросит про локальную сеть)");
  ok(Ch.LOCAL_NET_HINT.indexOf("локальн") > 0, "подсказка про локальную сеть подготовлена");
})();

console.log("селектор канала в панели");
(function(){
  eq(Ch.pref(), "auto", "без localStorage — «авто»");
  eq(Ch.setPref("shuttle"), "shuttle", "выбор «Шаттл» возвращается даже без хранилища");
  eq(Ch.pref(), "auto", "без localStorage выбор не запоминается");

  var mem = {};
  globalThis.localStorage = {
    getItem: function(k){ return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function(k, v){ mem[k] = String(v); },
    removeItem: function(k){ delete mem[k]; }
  };
  eq(Ch.setPref("shuttle"), "shuttle", "выбор «Шаттл» сохранён");
  eq(Ch.pref(), "shuttle", "…и читается");
  eq(mem[Ch.PREF_KEY], "shuttle", "ключ селектора — fsChannel");
  eq(Ch.setPref("windows"), "windows", "выбор «окна» сохранён");
  eq(Ch.setPref("erunda"), "auto", "чужое значение = «авто»");
  eq(Ch.pref(), "auto", "…и читается как «авто»");
  ok(!Object.prototype.hasOwnProperty.call(mem, Ch.PREF_KEY), "«авто» не хранится в хранилище");
  delete globalThis.localStorage;
})();

console.log("");
if (failed){ console.log("ПРОВАЛЕНО: " + failed); process.exit(1); }
console.log("ВСЕ ТЕСТЫ ШАТТЛА И КАНАЛОВ ЗЕЛЁНЫЕ (" + passed + " проверок)");
