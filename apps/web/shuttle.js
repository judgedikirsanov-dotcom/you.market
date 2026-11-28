// ============================================================================
// shuttle.js — канал «Шаттл». Этап 2 «Честного поиска 2.0».
//
// Вместо каскада из 3–4 окон источников — одна вкладка, которая проходит
// очередь по порядку:
//   1) агрегатор записывает очередь в sessionStorage и открывает вкладку с
//      первым источником (вкладка получает копию sessionStorage открывателя
//      и хранит её для нашего происхождения при любых переходах на чужие);
//   2) на каждой выдаче пользователь один раз нажимает закладку «📨 в фильтр
//      товаров» (или это делает скрипт-мост) — выдача уходит на наш сайт
//      страницей-релеем (#fsRelay=…&fsh=1);
//   3) релей передаёт выдачу агрегатору через BroadcastChannel, отмечает
//      источник пройденным и ведёт ту же вкладку к следующему;
//   4) после последнего источника релей показывает «готово» и закрывает вкладку.
//
// Очередь живёт только в sessionStorage вкладки: ни сервера, ни таймеров —
// когда выдача готова, решает человек (нажатием закладки).
// Модуль без зависимостей: браузер → window.FSShuttle, Node → module.exports.
// ============================================================================
(function(root){
"use strict";

var KEY = "fsShuttle";     // ключ sessionStorage
var FLAG = "fsh";          // маркер шаттла в адресе источника: …&fsx=1&fsh=1
var FLAG_RE = /[?&]fsh=1(?=&|#|$)/;

function isShuttleUrl(url){ return FLAG_RE.test(String(url || "")); }

// маркер ставится только на http(s)-адрес и всегда до «#»
function addMarker(url){
  url = String(url || "");
  if (isShuttleUrl(url) || !/^https?:\/\//i.test(url)) return url;
  var hash = "", i = url.indexOf("#");
  if (i >= 0){ hash = url.slice(i); url = url.slice(0, i); }
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + FLAG + "=1" + hash;
}

// очередь: { v, sid, q, entries:[{id,url}], done:{id:1}, at }
function pack(o){
  if (!o || !o.entries || !o.entries.length) return null;
  var entries = [], seen = {};
  for (var i = 0; i < o.entries.length; i++){
    var e = o.entries[i];
    if (!e || !e.id || !e.url || seen[e.id]) continue;
    var url = addMarker(e.url);
    if (!isShuttleUrl(url)) continue;         // не http(s) — в очередь не берём
    seen[e.id] = 1;
    entries.push({ id: String(e.id), url: url });
  }
  if (!entries.length) return null;
  return { v: 1, sid: String(o.sid || ""), q: String(o.q || ""), entries: entries, done: {}, at: o.at || 0 };
}

function valid(sh){
  if (!sh || typeof sh !== "object" || !Array.isArray(sh.entries) || !sh.entries.length) return false;
  if (!sh.done || typeof sh.done !== "object") return false;
  for (var i = 0; i < sh.entries.length; i++){
    var e = sh.entries[i];
    if (!e || !e.id || typeof e.url !== "string" || !isShuttleUrl(e.url)) return false;
  }
  return true;
}

function serialize(sh){ return JSON.stringify(sh); }

function parse(s){
  if (!s || typeof s !== "string") return null;
  var sh = null;
  try { sh = JSON.parse(s); } catch(e){ return null; }
  return valid(sh) ? sh : null;
}

function indexOf(sh, id){
  for (var i = 0; i < sh.entries.length; i++) if (sh.entries[i].id === id) return i;
  return -1;
}

// следующий непройденный источник после afterId; правее него ничего не осталось —
// идём с начала очереди (источник мог прийти не по порядку). afterId нет в
// очереди (в шаттле открыли что-то своё) — начинаем с первого непройденного.
function nextEntry(sh, afterId){
  if (!valid(sh)) return null;
  var n = sh.entries.length, start = 0, idx = indexOf(sh, afterId);
  if (idx >= 0) start = idx + 1;
  for (var k = 0; k < n; k++){
    var e = sh.entries[(start + k) % n];
    if (!sh.done[e.id]) return e;
  }
  return null;
}

// отметить источник пройденным (если он есть в очереди) и вернуть оставшиеся
function markDone(sh, id){
  if (!valid(sh)) return [];
  if (id && indexOf(sh, id) >= 0) sh.done[id] = 1;
  return remaining(sh);
}

function remaining(sh){
  if (!valid(sh)) return [];
  var ids = [];
  for (var i = 0; i < sh.entries.length; i++) if (!sh.done[sh.entries[i].id]) ids.push(sh.entries[i].id);
  return ids;
}

// { total, done } — сколько источников пройдено; для строки статуса
function progress(sh){
  var total = valid(sh) ? sh.entries.length : 0;
  var left = remaining(sh).length;
  return { total: total, done: total - left };
}

// ---- хранилище вкладки ------------------------------------------------------
function save(sh){
  if (!valid(sh)) return false;
  try { root.sessionStorage.setItem(KEY, serialize(sh)); return true; } catch(e){ return false; }
}

function load(){
  try { return parse(root.sessionStorage.getItem(KEY)); } catch(e){ return null; }
}

function clear(){
  try { root.sessionStorage.removeItem(KEY); } catch(e){}
}

// хранилище доступно? (приватный режим, блокировка cookies — тогда шаттл не работает)
function storageOk(){
  try {
    root.sessionStorage.setItem("__fs_probe", "1");
    root.sessionStorage.removeItem("__fs_probe");
    return true;
  } catch(e){ return false; }
}

var Shuttle = {
  KEY: KEY, FLAG: FLAG,
  isShuttleUrl: isShuttleUrl, addMarker: addMarker,
  pack: pack, parse: parse, serialize: serialize, valid: valid,
  nextEntry: nextEntry, markDone: markDone, remaining: remaining, progress: progress,
  save: save, load: load, clear: clear, storageOk: storageOk
};

if (typeof module !== "undefined" && module.exports) module.exports = Shuttle;
else root.FSShuttle = Shuttle;
})(typeof window !== "undefined" ? window : globalThis);
