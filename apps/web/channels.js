// ============================================================================
// channels.js — выбор канала сбора. Шаг 8 «Честного поиска 2.0».
//
// Канал — способ, которым выдачи источников добираются до страницы:
//   helper      локальный помощник (этап 3): страница сама читает поисковики
//               через программу на 127.0.0.1 — кликов нет;
//   extension   расширение-мост: фоновые вкладки отчитываются сами — кликов нет;
//   shuttle     «Шаттл» (этап 2): одна вкладка, закладка на каждой выдаче;
//   windows     каскад окон источников (прежний режим) — окно на источник.
//
// Пользователь канал не настраивает: страница проверяет, что доступно прямо
// сейчас, и берёт лучший. Селектор в панели («технические детали») — только
// запасной выход, он хранится в localStorage под ключом fsChannel.
// Модуль без зависимостей: браузер → window.FSChannels, Node → module.exports.
// ============================================================================
(function(root){
"use strict";

var PREF_KEY = "fsChannel";

var LABELS = {
  helper: "локальный помощник",
  extension: "расширение-мост",
  shuttle: "«Шаттл»",
  windows: "окна источников"
};

// Помощник — этап 3, его пока нет. Проверка выключена намеренно: запрос с
// публичной страницы в локальную сеть с Chrome 142 требует от браузера
// разрешения пользователя (вопрос «разрешить доступ к локальной сети»), и он
// не должен появляться раньше, чем появится сам помощник.
var HELPER = { enabled: false, base: "http://127.0.0.1:8765", probeMs: 900 };

var LOCAL_NET_HINT = "браузер спросит разрешение на обращение к локальной сети — оно нужно странице, " +
  "чтобы увидеть помощника на этом компьютере; даётся один раз на сайт";

// o: { helperEnabled, helperReady, extensionReady, shuttlePossible, pref }
//   pref — значение селектора: "auto" | "shuttle" | "windows"
function pick(o){
  o = o || {};
  var pref = (o.pref === "shuttle" || o.pref === "windows") ? o.pref : "auto";
  if (pref === "windows") return { channel: "windows", why: "выбрано в панели" };
  if (pref === "shuttle"){
    return o.shuttlePossible
      ? { channel: "shuttle", why: "выбрано в панели" }
      : { channel: "windows", why: "«Шаттл» выбран в панели, но хранилище вкладки недоступно" };
  }
  if (o.helperEnabled && o.helperReady) return { channel: "helper", why: "помощник ответил на 127.0.0.1" };
  if (o.extensionReady) return { channel: "extension", why: "расширение-мост отозвалось" };
  if (o.shuttlePossible) return { channel: "shuttle", why: "расширения нет — одна вкладка с очередью источников" };
  return { channel: "windows", why: "хранилище вкладки недоступно — окна источников" };
}

function label(channel){ return LABELS[channel] || String(channel); }

function pref(){
  try { return root.localStorage.getItem(PREF_KEY) || "auto"; } catch(e){ return "auto"; }
}

function setPref(v){
  var val = (v === "shuttle" || v === "windows") ? v : "auto";
  try {
    if (val === "auto") root.localStorage.removeItem(PREF_KEY);
    else root.localStorage.setItem(PREF_KEY, val);
  } catch(e){}
  return val;
}

var Channels = {
  PREF_KEY: PREF_KEY, LABELS: LABELS, HELPER: HELPER, LOCAL_NET_HINT: LOCAL_NET_HINT,
  pick: pick, label: label, pref: pref, setPref: setPref
};

if (typeof module !== "undefined" && module.exports) module.exports = Channels;
else root.FSChannels = Channels;
})(typeof window !== "undefined" ? window : globalThis);
