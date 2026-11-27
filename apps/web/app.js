// ============================================================================
// app.js — логика одностраничника «честный поиск товаров» (клиентская v6).
//
// ФИЛОСОФИЯ: мы не конкуренты поисковикам — мы их продвинутые пользователи.
// Всё выполняется ОТ ЛИЦА ПОЛЬЗОВАТЕЛЯ: его браузер, его IP, его куки, его
// вкладки. Никаких прокси-серверов и публичных CORS-релеев — выдача с чужих
// IP капчилась бы как спамботная, а здесь антибот видит живого человека.
//
// Конвейер после «искать» (без iframe):
//   ① страница открывает popup-окна поисковиков каскадом «друг под другом»
//     (Google, Яндекс — русский запрос, Bing, DDG) и последним — окно-анимацию
//     (#fsWorker): оно перекрывает всю стопку и показывает живой прогресс;
//   ② в каждом окне выдача исследуется прямо на месте — букмарклетом
//     (один клик по закладке «📨 в фильтр», работает в любом браузере) или
//     пользовательским скриптом (Violentmonkey — сам, ноль кликов);
//     парсеры вынимают результаты И ИИ-ответы поисковика (AI Overview /
//     Нейро / Copilot / Brave AI);
//   ③ данные летят на наш сайт через window.opener.postMessage (если opener
//     жив) или через «вкладку-почтальон»: окно навигируется на наш сайт с
//     данными в адресе (#fsRelay), передаёт их агрегатору по BroadcastChannel
//     (тот же origin) и закрывается; если браузер не даёт закрыть — честно
//     показывает «Ctrl+W». Окно-анимация на «готово» закрывается само;
//   ④ сайт принимает, пересобирает карточки с источниками, считает медиану.
//
// Резервные каналы приёма: Ctrl+V (HTML или JSON), файл, кнопка «забрать из
// буфера» (permission clipboard-read), расширение-мост в Chrome (FS_BRIDGE_*,
// вообще без вкладок). Магазины Shopify и подсказки Google — напрямую с твоего
// IP (у них CORS открыт — прокси не нужен).
// ============================================================================
"use strict";
(function(){
var FC = window.FilterCore, FS = window.FSCore, FB = window.FSBridge;
var $ = function(id){ return document.getElementById(id); };

var SERP_IDS = ["google", "yandex", "bing", "ddg", "mojeek", "brave", "marginalia"];
// маркетплейсы: цены в рублях, отчёты принимаем как источники карточек
var MARKET_IDS = ["ozon", "avito", "ali"];
// окна, открываемые сразу при поиске: v14 — ВСЕ источники (каскад), включая
// Brave/Mojeek/Marginalia и маркетплейсы; чипы остались для повторного поиска
var TAB_ENGINES = ["google", "yandex", "bing", "ddg", "brave", "mojeek", "ozon", "avito", "ali", "marginalia"];
var EXTRA_ENGINES = [];

// ---- состояние ---------------------------------------------------------------
var state = {
  query: "", translated: null,
  pages: [],            // источники: {id, name, query, items, via, block, isProductPage, html}
  aiAnswers: [],        // ИИ-ответы поисковиков: {src, text, guess, ts, key}
  shopReports: [], shopOffers: [], shopsPromise: null,
  offers: [], usedFallback: false,
  searching: false,
  finalized: false,
  queue: [],            // порядок поисковиков для чипов и ручных кнопок
  pastedIds: [],        // id уже принесённых источников
  openedIds: [],        // какие движки уже открывали вкладкой (не дёргать дважды)
  extMode: false,       // расширение-мост подключено: вкладки открывает оно (tabs.create)
  tabsOpened: false,    // вкладки уже открывали в этом поиске
  lastPayloadTs: 0,     // дедуп отчётов вкладок
  bridge: { ready: false, version: null },   // расширение-мост (Chrome, опционально)
  autos: {}             // id канала -> {state: wait|ok|err, n, msg, blocked}
};

// ---- утилиты -----------------------------------------------------------------
function esc(s){ var d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }
function fmtPrice(p, cur){
  if (!p) return "—";
  var sym = cur === "USD" ? "$" : cur === "EUR" ? "€" : cur === "RUB" ? " ₽" : " " + (cur || "");
  return (cur === "RUB" ? String(p).replace(/\B(?=(\d{3})+(?!\d))/g, " ") : p) + sym;
}
function normQ(q){ return String(q || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function now(){ return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function addLog(msg, cls){
  var box = $("log");
  var d = document.createElement("div");
  d.className = "logline " + (cls || "");
  d.innerHTML = "<span class='t'>" + now() + "</span> " + msg;
  box.appendChild(d);
  box.hidden = false;
  box.scrollTop = box.scrollHeight;
}
function engineName(id){
  var def = FS.ENGINE_DEFS.filter(function(e){ return e.id === id; })[0];
  if (def) return def.name;
  return { ddg: "DuckDuckGo", bing: "Bing", mojeek: "Mojeek", brave: "Brave" }[id] || id;
}

// ---- мост в расширение (Chrome, опционально) ----------------------------------
// Расширение фетчит поисковики сетевым стеком браузера: куки и IP пользователя,
// без вкладок. Протокол FS_BRIDGE_* сохранён для обратной совместимости.
var FS_bridge = window.FS_bridge = window.FS_bridge || {};
(function initBridge(){
  var reqSeq = 0, pending = {};
  function onMessage(ev){
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "FS_BRIDGE_READY"){
      var first = !state.bridge.ready;
      state.bridge.ready = true; state.bridge.version = m.version;
      if (first){
        addLog("мост с расширением найден (v" + esc(m.version) + ") — поисковики пойдут под капотом с твоими куками, вкладки не нужны");
        var ind = $("bridgeInd");
        if (ind){ ind.hidden = false; ind.textContent = "🔌 расширение-мост v" + m.version + " активно: поисковики — под капотом (твои куки и IP), вкладки не открываются"; }
        var off = $("bridgeOff");
        if (off) off.hidden = true;
        renderChips();
      }
      return;
    }
    if (m.type === "FS_BRIDGE_SERP" && m.reqId && pending[m.reqId]){
      var cb = pending[m.reqId];
      delete pending[m.reqId];
      cb({ ok: !!m.ok, html: m.html, error: m.error });
    }
  }
  window.addEventListener("message", onMessage);
  FS_bridge.fetchSerp = function(url, cb){
    var reqId = "r" + (++reqSeq) + "_" + Date.now();
    pending[reqId] = cb;
    window.postMessage({ type: "FS_BRIDGE_FETCH_SERP", url: url, reqId: reqId },
      location.protocol === "file:" ? "*" : location.origin);
    setTimeout(function(){
      if (pending[reqId]){ delete pending[reqId]; cb({ ok: false, error: "мост не ответил за 45 с" }); }
    }, 45000);
  };
})();

// ---- приём данных со вкладок (букмарклет / пользовательский скрипт) -----------
// Вкладка выдачи, открытая сайтом, присылает payload через
// window.opener.postMessage. Валидируем payload fsBridge (v2); origin логируем
// для прозрачности — самих себя поисковики не пришлют, это делают наши же
// букмарклет/скрипт, работающие В КОНТЕКСТЕ вкладки пользователя.
// расширение-мост: готовность (fsExtReady) и подтверждения открытия вкладок.
// Расширение знает свои вкладки по tabId — отчёты приходят только от них,
// обычные поиски пользователя оно не читает и не трогает.
window.addEventListener("message", function(ev){
  if (ev.origin !== location.origin) return;
  var m = ev.data;
  if (!m || typeof m !== "object") return;
  if (m.fsExtReady){
    if (!state.extMode){
      state.extMode = true;
      addLog("расширение-мост подключено: вкладки выдачи откроет оно — только свои, обычные поиски не трогает");
    }
    return;
  }
  if (m.fsExtOpened){
    if (m.fsExtOpened.ok === false){
      state.extMode = false;
      addLog("расширение не открыло вкладку (" + esc(String(m.fsExtOpened.error || "ошибка")) + ") — откатываюсь на окна", "warn");
      courier("расширение-мост не открыло вкладку — открываю окна сам. Разреши всплывающие окна для этого сайта или переустанови расширение");
    } else {
      addLog("расширение: вкладка №" + esc(String(m.fsExtOpened.tabId || "?")) + " открыта и помечена как наша");
    }
    return;
  }
});

window.addEventListener("message", function(ev){
  var m = ev.data;
  if (!m || typeof m !== "object" || m.fsBridge !== 1) return;
  if (!FB.validatePayload(m)){
    addLog("мост: payload не распознан (v" + esc(m.v) + ", src=" + esc(m.src) + ")", "warn");
    return;
  }
  acceptBridgePayload(m, ev.origin || "?");
});

function acceptBridgePayload(p, origin){
  if (state.lastPayloadTs === p.ts) return;   // тот же отчёт не вливаем дважды
  state.lastPayloadTs = p.ts;
  var src = (SERP_IDS.concat(MARKET_IDS)).indexOf(p.src) >= 0 ? p.src : null;
  if (!src) return;
  // дедуп по источнику+запросу: скрипт-мост и расширение могут отчитаться
  // об одном окне одновременно (ts у них разные — по ts дубль не ловится)
  var dk = src + "|" + (normQ(p.q || "") || "-");
  state.dedupTs = state.dedupTs || {};
  if (state.dedupTs[dk] && Date.now() - state.dedupTs[dk] < 15000){
    addLog("дубль отчёта от " + esc(engineName(src)) + " — пропущен (уже влит)");
    return;
  }
  state.dedupTs[dk] = Date.now();
  if (!state.query && p.q){
    state.query = String(p.q).trim();
    if (state.query){ $("q").value = state.query; ensureQuery(false); }
  }
  // вкладка отчитывается запросом КАК ОН ВВЕДЁН в поисковик: оригинал или
  // перевод — считаем валидными оба
  var qOk = !state.query || !p.q ||
            normQ(p.q) === normQ(state.query) ||
            (state.translated && normQ(p.q) === normQ(state.translated.query));
  if (!qOk){
    addLog("вкладка " + esc(engineName(src)) + " пришла с другим запросом («" +
      esc(String(p.q).slice(0, 40)) + "») — игнорирую", "warn");
    return;
  }
  addLog("принято от " + esc(engineName(src)) + " (origin " + esc(origin) + ")");
  var had = false;
  if (Array.isArray(p.items) && p.items.length){
    absorbItems(src, p.items, "вкладка");
    had = true;
  } else if (p.html){
    var page = addPage(String(p.html), "relay", src);
    onSourceArrived(page);
    had = true;
  } else {
    addLog(engineName(src) + ": вкладка отчиталась, но результатов не распознала — вёрстка изменилась?", "warn");
  }
  if (p.ai && p.ai.text){
    pushAiAnswer(p.ai.src || src, String(p.ai.text), !!p.ai.guess);
    had = true;
  }
  if (had) maybeFinishOnArrival();
}

// ---- вкладка-почтальон: универсальный транспорт выдачи ------------------------
// Букмарклет навигирует вкладку выдачи на наш сайт с данными в адресе
// (#fsRelay=…). Эта копия страницы: расшифровывает payload, передаёт его
// агрегатору в другой вкладке через BroadcastChannel (тот же origin — COOP
// не мешает) и закрывается, если была открыта скриптом. COOP Google/Яндекса/
// Bing рвёт window.opener, но навигации и BroadcastChannel он не запрещает.
function b64urlToUtf8(s){
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  var bin = atob(s), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
var relayChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("fs-relay") : null;
if (relayChannel){
  relayChannel.onmessage = function(ev){
    var p = ev.data;
    if (!p || typeof p !== "object" || p.fsBridge !== 1 || !FB.validatePayload(p)) return;
    addLog("релей: вкладка-почтальон передала выдачу " + esc(engineName(p.src)));
    acceptBridgePayload(p, "BroadcastChannel");
  };
}
function handleRelayHash(){
  var m = /(?:^|&)[?]?fsRelay=([A-Za-z0-9_-]+)/.exec(location.hash.slice(1));
  if (!m) return;
  var payload = null, srcName = "?";
  try {
    payload = JSON.parse(b64urlToUtf8(m[1]));
    srcName = engineName(payload && payload.src);
  } catch(e){
    addLog("релей: не удалось расшифровать данные — " +
      esc(String(e && e.stack || e).split("\n").slice(0, 2).join(" | ").slice(0, 180)), "bad");
    return;
  }
  if (!payload || !FB.validatePayload(payload)){
    addLog("релей: payload не распознан", "warn");
    return;
  }
  // 1) главное: отдать агрегатору в другой вкладке (BroadcastChannel, тот же origin)
  var delivered = false;
  try {
    if (relayChannel){ relayChannel.postMessage(payload); delivered = true; }
  } catch(e){
    addLog("релей: BroadcastChannel не прошёл — " + esc(String(e && e.message || e).slice(0, 80)), "warn");
  }
  // 2) показать здесь же (file:// без агрегатора) — сбой не влияет на передачу
  try {
    if (!state.searching && !state.finalized){
      addLog("релей: принята выдача " + esc(srcName) + " (вкладка-почтальон)");
      if (!state.query && payload.q){
        state.query = String(payload.q).trim();
        if (state.query){ $("q").value = state.query; ensureQuery(false); }
      }
      if (Array.isArray(payload.items) && payload.items.length)
        absorbItems(payload.src, payload.items, "вкладка");
      else if (payload.html)
        ingest(String(payload.html), "relay");
      if (payload.ai && payload.ai.text)
        pushAiAnswer(payload.ai.src || payload.src, String(payload.ai.text), !!payload.ai.guess);
    } else {
      acceptBridgePayload(payload, "релей #hash");
    }
  } catch(e){
    addLog("релей: локальный показ не удался (данные уже переданы) — " +
      esc(String(e && e.stack || e).split("\n").slice(0, 2).join(" | ").slice(0, 180)), "warn");
  }
  // чистим адрес, чтобы сброс/обновление не вливали отчёт повторно (есть и дедуп по ts)
  try { history.replaceState(null, "", location.pathname + location.search); } catch(e){}
  // закрываем окно ВСЕГДА, а не только при history.length > 1: после location.replace
  // у него одна запись истории, а по правилам браузеров окно можно закрыть, если
  // оно открыто скриптом ИЛИ история состоит из одной записи. Прежнее условие как
  // раз пропускало этот случай — окна-почтальоны и оставались открытыми.
  setTimeout(function(){ try { window.close(); } catch(e){} }, 250);
  setTimeout(function(){
    try { window.close(); } catch(e){}
    if (window.closed) return;
    // браузер всё же не дал (флаг «открыто скриптом» потерялся при COOP-переходе) —
    // честная подсказка вместо тихого зомби-окна
    document.title = "✓ передано — окно можно закрыть (Ctrl+W)";
    courier(delivered ?
      "✓ выдача " + esc(srcName) + " передана на вкладку агрегатора. Закрой это окно — <b>Ctrl+W</b> (браузер не позволяет странице закрыть саму себя после перехода с поисковика)" :
      "выдача показана здесь; окно можно закрыть (Ctrl+W)");
  }, 800);
}
handleRelayHash();
window.addEventListener("hashchange", handleRelayHash);

// ИИ-ответ поисковика — отдельная сводка, в карточки товаров не попадает
function pushAiAnswer(src, text, guess){
  var key = src + "|" + normQ(text).slice(0, 80);
  for (var i = 0; i < state.aiAnswers.length; i++)
    if (state.aiAnswers[i].key === key) return;
  state.aiAnswers.push({ src: src, text: text, guess: guess, ts: Date.now(), key: key });
  addLog("🤖 ИИ-ответ " + esc(engineName(src)) + " принят" + (guess ? " (эвристика)" : ""));
  renderAiCards();
}
function renderAiCards(){
  var out = $("out");
  if (!out) return;
  // ИИ-карточки всегда сверху; товары не трогаем
  Array.prototype.forEach.call(out.querySelectorAll(".ai-card"), function(n){ n.remove(); });
  var ref = out.firstChild;
  state.aiAnswers.slice().reverse().forEach(function(a){
    var d = document.createElement("div");
    d.className = "card ai-card";
    d.innerHTML = "<div class='shop'>🤖 ИИ-ответ · " + esc(engineName(a.src)) +
      (a.guess ? " (найден эвристикой)" : "") + "</div>" +
      "<div class='aitext'>" + esc(a.text).slice(0, 1200) + "</div>" +
      "<div class='meta'>это сводка поисковика с твоей вкладки, а не предложение товара — в медиану рынка не входит. " +
      "Ссылки на источники поисковик приводит внутри ответа.</div>";
    out.insertBefore(d, ref);
    ref = d.nextSibling;
  });
}

// подкапотный fetch поисковика через расширение (Chrome, если стоит)
var bridgeTried = {};
// окна поиска, открытые страницей: на «готово» главная страница пробует закрыть
// их сама (закроются те, где флаг «открыто скриптом» не порван COOP-переходом)
var popupRefs = {}, workerRef = null;
function bridgeFetchEngine(id){
  var url = FS.buildEngineUrl(id, (state.translated && state.translated.query) || state.query);
  if (!url){ bridgeSettle(id, "нет URL"); return; }
  bridgeTried[id] = true;
  state.autos[id + ":bridge"] = { state: "wait" };
  renderChips();
  addLog(engineName(id) + ": запрашиваю под капотом (через расширение)…");
  FS_bridge.fetchSerp(url, function(res){
    if (!state.searching) return;
    if (res && res.ok && res.html){
      var page = addPage(res.html, "bridge", id);
      detLine(2, "✓ " + esc(engineName(id)) + " (под капотом, твои куки): HTML получен через мост");
      if (page.items.length){
        state.autos[id + ":bridge"] = { state: "ok", n: page.items.length };
        onSourceArrived(page);
      } else bridgeSettle(id, "пустая выдача");
    } else {
      bridgeSettle(id, (res && res.error) || "нет ответа");
    }
    renderChips();
  });
}
function bridgeSettle(id, why){
  delete state.autos[id + ":bridge"];
  state.autos[id] = { state: "err", msg: why || "", blocked: true };
  detLine(2, "<span class='warn'>• " + esc(engineName(id)) + " (мост): " + esc(String(why).slice(0, 70)) + " — можно открыть вкладкой</span>");
  addLog(engineName(id) + ": мост не смог (" + esc(String(why).slice(0, 60)) + ")", "warn");
}

// ---- стадии ①-⑥ --------------------------------------------------------------
var STAGES = [
  { n: 1, key: "query",   label: "запрос и перевод" },
  { n: 2, key: "paste",   label: "поисковики (твои окна)" },
  { n: 3, key: "compare", label: "сравнение выдач" },
  { n: 4, key: "product", label: "карточки товаров" },
  { n: 5, key: "shops",   label: "магазины напрямую (твой IP)" },
  { n: 6, key: "result",  label: "фильтр и итог" }
];
var stageEls = {};
function buildStages(){
  var prog = $("prog");
  prog.innerHTML = ""; stageEls = {};
  STAGES.forEach(function(s){
    var d = document.createElement("div");
    d.className = "stage";
    d.innerHTML = "<div class='num'>" + s.n + "</div><div class='lbl'>" + esc(s.label) + "</div><div class='det'></div>";
    prog.appendChild(d);
    stageEls[s.n] = { row: d, det: d.querySelector(".det") };
  });
  prog.hidden = false;
}
function stage(n, cls){
  var e = stageEls[n]; if (!e) return;
  e.row.classList.remove("active", "done", "skip", "error");
  if (cls) e.row.classList.add(cls);
}
function det(n, html){
  var e = stageEls[n]; if (e) e.det.innerHTML = html;
}
function detLine(n, html){
  var e = stageEls[n]; if (!e) return;
  var d = document.createElement("div");
  d.className = "evline"; d.innerHTML = html;
  e.det.appendChild(d);
}

// ---- чипы источников ----------------------------------------------------------
function renderChips(){
  var box = $("chips");
  var html = "";
  state.queue.forEach(function(id){
    if (state.pastedIds.indexOf(id) >= 0){
      html += "<span class='chip ok'>" + esc(engineName(id)) + " ✓</span>";
      return;
    }
    var a = state.autos[id + ":bridge"] || state.autos[id];
    if (a && a.state === "wait"){
      var via = state.autos[id + ":bridge"] ? " — под капотом (мост)…" : " — жду окно…";
      html += "<span class='chip wait'>" + esc(engineName(id) + via) + "</span>";
      return;
    }
    if (a && a.state === "ok"){
      html += "<span class='chip ok'>" + esc(engineName(id) + ": " + a.n) + "</span>";
      return;
    }
    // err или ещё не начинали: кнопка «вкладкой»
    var why = a && a.msg ? String(a.msg).slice(0, 24) : "открыть окно";
    html += "<button type='button' class='chip btn' data-engine='" + id +
            "' title='" + esc(why + " — окно с твоим запросом; там жми закладку «📨 в фильтр»") + "'>" +
            esc(engineName(id) + " — вкладкой") + "</button>";
  });
  // маркетплейсы: кнопки (открываем по желанию — оттуда приходят цены)
  ["ozon", "avito", "ali"].forEach(function(id){
    var got = state.pastedIds.indexOf(id) >= 0;
    var cls = "chip btn" + (got ? " ok" : "");
    var lbl = engineName(id) + (got ? " ✓" : " — цены");
    html += "<button type='button' class='" + cls + "' data-engine='" + id + "'>" + esc(lbl) + "</button>";
  });
  box.innerHTML = html;
  box.hidden = false;
  Array.prototype.forEach.call(box.querySelectorAll("button[data-engine]"), function(b){
    b.addEventListener("click", function(){ openEngineTab(b.getAttribute("data-engine")); });
  });
}

// ---- курьер-подсказка ----------------------------------------------------------
function courier(html){
  var c = $("courier");
  c.innerHTML = html;
  c.hidden = !html;
}

// ---- ① запрос и перевод ------------------------------------------------------
function ensureQuery(auto){
  if (!state.query) state.query = ($("q").value || "").trim();
  if (!state.query && auto) return false;
  if (state.query){
    var tr = FC.translateQuery(state.query);
    state.translated = tr;
    stage(1, "done");
    det(1, "«" + esc(state.query) + "»" +
      (tr.translated ? " → <b>" + esc(tr.query) + "</b> (как напечатал бы в англоязычном магазине)" : ""));
  }
  return !!state.query;
}

// ---- ② источники: вкладки / вставка / файл / буфер / мост ---------------------
function addPage(html, via, forcedId){
  var src = FS.detectSource(html);
  if (forcedId){
    var viaName = via === "bridge" ? " (под капотом)" : via === "relay" ? " (вкладка/буфер)" : "";
    src = { id: forcedId, name: engineName(forcedId) + viaName, query: state.query };
  }
  var items = [];
  var block = FS.detectBlock(html);
  var isProductPage = false;

  if (!forcedId && src.id === "unknown"){
    var card = FS.productHtmlToOffer("", html, []);
    if (card.title && (card.price || card.notProductPage === undefined)){
      isProductPage = !card.notProductPage;
    }
  }
  if (!forcedId && src.id !== "unknown")
    items = FS.parseBySource(src.id, html);
  if (forcedId && (via === "bridge" || via === "relay"))
    items = FS.parseBySource(forcedId, html);

  var page = {
    name: src.name, id: src.id, query: src.query, items: items,
    via: via, block: block, isProductPage: isProductPage, html: html
  };
  state.pages.push(page);
  window.__fsDebug = makeDebugHook();   // отладочный хук: window.__fsDebug().pages / .ai

  if (!forcedId && src.query && !state.query){
    state.query = src.query;
    $("q").value = src.query;
    addLog("запрос подхвачен из вставки: «" + esc(src.query) + "» (" + esc(src.name) + ")");
  }

  if (stageEls[2] && !state.finalized) stage(2, "active");
  if (block){
    detLine(2, "<span class='bad'>✗ " + esc(src.name) + ": " + esc(block) + "</span>");
    addLog(esc(src.name) + ": страница-заглушка (" + esc(block) + ")", "bad");
  } else if (isProductPage){
    detLine(2, "• карточка товара — пойдёт в стадию ④");
    addLog("вставлена карточка товара");
  } else if (items.length){
    var viaLbl = via === "bridge" ? " (под капотом)" : via === "relay" ? " (вкладка/буфер)" : "";
    // имя источника уже содержит суффикс канала (addPage форсирует id) —
    // второй раз дописывать нельзя, иначе «(вкладка/буфер) (вкладка/буфер)»
    if (viaLbl && src.name.indexOf(viaLbl.trim()) >= 0) viaLbl = "";
    detLine(2, "✓ " + esc(src.name) + viaLbl + ": " + items.length + " результатов");
    addLog(esc(src.name) + ": распознано " + items.length + " результатов" + viaLbl);
  } else {
    detLine(2, "<span class='warn'>• " + esc(src.name) + ": результаты не распознаны — вёрстка могла измениться</span>");
    addLog(esc(src.name) + ": 0 результатов (вёрстка не распознана)", "warn");
  }
  updatePasteHint();
  return page;
}

// готовые результаты (от букмарклета/скрипта): влить в конвейер
// отладочный хук для обоих путей приёма (вставка страницы и payload-релей):
// window.__fsDebug().pages — страницы с первыми items (цена/происхождение цены)
function makeDebugHook(){
  return function(){
    return { pages: state.pages.map(function(p){
      return { id: p.id, via: p.via, n: p.items.length, block: p.block,
               items: p.items.slice(0, 3).map(function(it){
                 return { t: String(it.title || "").slice(0, 40), price: it.price != null ? it.price : null,
                          via: it.priceVia || null, st: it.sourceType || null }; }),
               head: String(p.html || "").slice(0, 400), html: String(p.html || "") };
    }), ai: state.aiAnswers,
      searching: state.searching, finalized: state.finalized,
      serpCount: serpCount(), queue: state.queue.slice(),
      query: state.query, translated: state.translated && state.translated.query,
      autos: JSON.parse(JSON.stringify(state.autos)) };
  };
}

function absorbItems(src, items, label){
  if (!stageEls[1]) buildStages();
  // страховка цены: старые букмарклеты/скрипты-мосты шлют payload без цены —
  // вынимаем из заголовка/сниппета сами (та же логика, что в bridge-lib v8),
  // помечая «≈ из выдачи»; новые скрипты шлют цену готовой и эта ветка молчит
  items.forEach(function(it){
    if (it.price != null) return;
    var p = FS.priceFromText(it.title, it.snippet);
    if (p){ it.price = p.price; it.currency = p.currency; it.priceVia = "snippet"; }
  });
  var page = { id: src, name: engineName(src) + " (" + label + ")", query: state.query,
               items: items, via: "relay", block: null, isProductPage: false, html: "" };
  state.pages.push(page);
  if (stageEls[2] && !state.finalized) stage(2, "active");
  state.autos[src] = { state: "ok", n: items.length };
  detLine(2, "✓ " + esc(page.name) + ": " + items.length + " результатов");
  addLog(esc(page.name) + ": " + items.length + " результатов — влито в конвейер");
  updatePasteHint();
  window.__fsDebug = makeDebugHook();
  onSourceArrived(page);
  return page;
}

// payload скрипт-моста из текста (буфер/Ctrl+V/файл)
function absorbFromText(t, label){
  if (!t) return false;
  var s = String(t).trim();
  if (s[0] !== "{") return false;
  try {
    var j = JSON.parse(s);
    if (!j || j.fsBridge !== 1 || !FB.validatePayload(j)) return false;
    acceptBridgePayload(j, "буфер/" + label);
    return true;
  } catch(e){ return false; }
}

function handlePasteEvent(e){
  var dt = e && e.clipboardData;
  if (!dt) return;
  var txt = dt.getData("text/plain");
  if (txt && /^\s*\{/.test(txt) && txt.indexOf("fsBridge") >= 0){
    if (absorbFromText(txt, "Ctrl+V")) e.preventDefault();
    return;
  }
  var html = dt.getData("text/html");
  if (html && /<a\s|<html|<!doctype/i.test(html)){
    e.preventDefault();
    ingest(html, "paste");
    return;
  }
  if (txt && /<(a|html|body|meta|script|link)\b/i.test(txt) && txt.length > 500){
    e.preventDefault();
    ingest(txt, "paste");
  }
}
function handleFiles(files){
  Array.prototype.slice.call(files).forEach(function(f){
    if (f.size > 30 * 1024 * 1024){ addLog("файл " + esc(f.name) + " больше 30 МБ — пропущен", "warn"); return; }
    var r = new FileReader();
    r.onload = function(){ var t = String(r.result); if (!absorbFromText(t, "файл")) ingest(t, "file"); };
    r.onerror = function(){ addLog("не прочитался файл " + esc(f.name), "bad"); };
    r.readAsText(f, "utf-8");
  });
}
function ingest(html, via){
  if (!stageEls[1]) buildStages();
  ensureQuery(true);
  var page = addPage(html, via);
  onSourceArrived(page);
}

// кнопка «забрать из буфера» — настоящий permission-запрос браузера
function grabClipboard(){
  if (!navigator.clipboard || !navigator.clipboard.readText){
    courier("этот браузер не умеет читать буфер напрямую — просто нажми <kbd>Ctrl+V</kbd> на странице (выдача от букмарклета вставится сама)");
    return;
  }
  addLog("запрашиваю доступ к буферу обмена…");
  navigator.clipboard.readText().then(function(t){
    if (absorbFromText(t, "кнопка буфера")){
      courier("забрал выдачу из буфера — конвейер пересобран");
      addLog("буфер: выдача принята");
    } else {
      courier("в буфере нет выдачи от букмарклета. Открой вкладку выдачи → жми закладку «📨 в фильтр» → вернись сюда");
      addLog("буфер: полезной выдачи нет", "warn");
    }
  }).catch(function(e){
    courier("браузер не дал читать буфер (" + esc(String(e && e.name || "ошибка")) + "). Разреши доступ для этого сайта — или просто вставь <kbd>Ctrl+V</kbd>");
    addLog("буфер: доступ запрещён — " + esc(String(e && e.message || e).slice(0, 60)), "warn");
  });
}

// новое данное → пересобрать конвейер
function onSourceArrived(page){
  if (page.id && SERP_IDS.indexOf(page.id) >= 0){
    if (page.block && !page.items.length){
      // страница-заглушка: не «✓», а честная кнопка «вкладкой» с причиной
      state.autos[page.id] = { state: "err", msg: page.block, blocked: true };
      var i = state.pastedIds.indexOf(page.id);
      if (i >= 0) state.pastedIds.splice(i, 1);
    } else if (state.pastedIds.indexOf(page.id) < 0){
      state.pastedIds.push(page.id);
    }
  }
  renderChips();
  if (state.searching){
    if (serpCount() >= 2) finishSearch();
  } else if (state.finalized){
    rerunFinal();   // поздний источник (Ozon с ценами, ещё одна вкладка) — пересобрать
  }
}

function serpCount(){
  var seen = {};
  state.pages.forEach(function(p){ if (SERP_IDS.indexOf(p.id) >= 0 && p.items.length) seen[p.id] = 1; });
  return Object.keys(seen).length;
}
function maybeFinishOnArrival(){
  var sc = serpCount();
  addLog("конвейер: источников=" + sc + ", searching=" + state.searching +
    ", страниц=" + state.pages.length);
  if (state.searching && sc >= 2) finishSearch();
}

// ---- окна поиска: открыть / принять / закрыть ---------------------------------
// Popup-окна без панели вкладок, каскадом «друг под другом»; последним
// открывается окно-анимация (#fsWorker) — оно перекрывает всю стопку.
function engineQuery(id){
  // Яндексу и русским маркетплейсам — исходный запрос (родной язык даёт лучшую
  // выдачу), англоязычным поисковикам — переведённый
  var useOriginal = (id === "yandex" || id === "ozon" || id === "avito" || id === "ali");
  return useOriginal ? state.query :
         ((state.translated && state.translated.query) || state.query);
}
function cascadeFeatures(i, w, h){
  var aw = (screen && screen.availWidth) || 1280, ah = (screen && screen.availHeight) || 800;
  w = Math.min(w || 1080, aw - 120); h = Math.min(h || 780, ah - 120);
  var L = Math.max(0, Math.min(24 + i * 46, aw - w - 8));
  var T = Math.max(0, Math.min(24 + i * 46, ah - h - 8));
  return "popup=yes,width=" + Math.round(w) + ",height=" + Math.round(h) +
         ",left=" + Math.round(L) + ",top=" + Math.round(T);
}
function openSearchWindow(id, i){
  var url = FS.buildEngineUrl(id, engineQuery(id));
  if (!url) return null;
  // маркер «нашего» окна: скрипт-мост v2.3 авто-отчитывается только на выдачах
  // с этим параметром (или с нашим referrer) — обычные поиски пользователя из
  // адресной строки он больше не перехватывает (менеджеры юзерскриптов сами не
  // отличают окно сайта от ручного поиска, поэтому различение — в URL)
  url += (url.indexOf("?") >= 0 ? "&" : "?") + "fsx=1";
  if (state.extMode){
    // расширение-мост: вкладку откроет tabs.create и пометит как «нашу» —
    // отчёт придёт, вкладку расширение закроет само; постмесседж-подтверждение
    // вернётся fsExtOpened (при отказе — откат на окна)
    try {
      window.postMessage({ fsExtOpen: { url: url, id: id } }, location.origin);
    } catch(e){ state.extMode = false; return openSearchWindow(id, i); }
    var stub = { ext: true, closed: false, postMessage: function(){}, close: function(){} };
    popupRefs[id] = stub;
    if (state.openedIds.indexOf(id) < 0) state.openedIds.push(id);
    state.autos[id] = { state: "wait" };
    return stub;
  }
  var w = window.open(url, "_blank", cascadeFeatures(i));
  if (!w){
    // каскад не удался (блокер) — хотя бы обычная вкладка
    w = window.open(url, "_blank");
    if (!w){
      addLog("браузер заблокировал окно " + engineName(id) + " — открой его кнопкой в чипах", "warn");
      return null;
    }
  }
  popupRefs[id] = w;
  if (state.openedIds.indexOf(id) < 0) state.openedIds.push(id);
  state.autos[id] = { state: "wait" };
  return w;
}
function openWorkerWindow(q){
  var base = location.href.split("#")[0].split("?")[0];
  var url = base + "?q=" + encodeURIComponent(q) + "#fsWorker";
  if (state.extMode){
    // окно-анимация — тоже вкладкой через расширение (активной, поверх)
    try { window.postMessage({ fsExtOpen: { url: url, active: true } }, location.origin); return true; }
    catch(e){ state.extMode = false; }
  }
  var aw = (screen && screen.availWidth) || 1280, ah = (screen && screen.availHeight) || 800;
  var f = "popup=yes,width=780,height=640,left=" + Math.round(Math.max(0, (aw - 780) / 2)) +
          ",top=" + Math.round(Math.max(0, (ah - 640) / 2));
  workerRef = window.open(url, "_blank", f);
  return !!workerRef;
}
function closeOurWindows(){
  Object.keys(popupRefs).forEach(function(id){
    try { if (popupRefs[id] && !popupRefs[id].closed) popupRefs[id].close(); } catch(e){}
  });
  try { if (workerRef && !workerRef.closed) workerRef.close(); } catch(e){}
}
function openEngineTab(id){
  // ручной канал: окно по кнопке в чипах
  var w = openSearchWindow(id, state.openedIds.length);
  if (w){
    courier("открыл <b>" + esc(engineName(id)) + "</b> с твоим запросом → там один клик по закладке «📨 в фильтр товаров» — окно само передаст результат и закроется" +
      (state.finalized ? "; итог пересоберётся автоматически" : ""));
    addLog("открыл окно " + engineName(id) + " по кнопке");
  } else {
    courier("браузер не дал открыть окно. Разреши всплывающие окна для этого сайта (значок в адресной строке) и нажми кнопку в чипах снова");
  }
  renderChips();
}

// ---- ③ сравнение выдач -------------------------------------------------------
function runCompare(){
  var serpPages = state.pages.filter(function(p){
    return p.items.length && (SERP_IDS.concat(MARKET_IDS)).indexOf(p.id) >= 0; });
  var hits = [];
  serpPages.forEach(function(p){
    var isMarket = MARKET_IDS.indexOf(p.id) >= 0;
    p.items.forEach(function(it){
      // происхождение цены: парсер площадки → market, из текста выдачи → snippet,
      // из payload скрипта-моста → it.priceVia; иначе честный null
      var via = it.priceVia || (it.price != null ? (isMarket ? "market" : "snippet") : null);
      hits.push({ engine: p.id, engineName: p.name, title: it.title, url: it.url,
                  snippet: it.snippet || "", price: it.price != null ? it.price : null,
                  currency: it.currency || null, priceVia: via,
                  img: it.img || it.image || null,
                  sourceType: isMarket ? "market" : "serp" });
    });
  });
  var q = (state.translated && state.translated.query) || state.query || "";
  var cmp = FS.compareHits(hits, q);
  stage(3, "done");
  det(3, "ссылок " + cmp.stats.links + " · уникальных товаров " + cmp.stats.uniqueTargets +
    " · подтверждено несколькими источниками: " + cmp.stats.confirmed);
  return cmp;
}

// ---- ④ карточки товаров (вставленные страницы товаров) -----------------------
function runProductPages(){
  var cards = [];
  state.pages.forEach(function(p){
    if (p.id !== "unknown") return;
    var m = /<link[^>]*rel=["']canonical["'][^>]*href="([^"]+)"/i.exec(p.html) ||
            /<link[^>]*href="([^"]+)"[^>]*rel=["']canonical["']/i.exec(p.html);
    var url = m ? m[1] : "";
    var card = FS.productHtmlToOffer(url, p.html, []);
    if (card.title && (card.price > 0)){
      card.flags.push("вставлена вручную со страницы товара");
      cards.push(card);
      detLine(4, "✓ " + esc(card.title.slice(0, 60)) + " — " + fmtPrice(card.price, card.currency));
    } else if (card.title){
      detLine(4, "<span class='warn'>• страница без цены (не карточка товара?) — " + esc(card.title.slice(0, 50)) + "</span>");
    }
  });
  if (cards.length) stage(4, "done");
  else { stage(4, "skip"); det(4, "нет вставленных карточек — стадия необязательна"); }
  return cards;
}

// ---- ⑤ Shopify-канал (твой IP) ------------------------------------------------
function runShops(){
  var q = (state.translated && state.translated.query) || state.query || "";
  var terms = FC.significantTerms(q);
  var chosen = FS.orderShops(terms).filter(function(s){
    return (s.cats || []).some(function(c){ return terms.indexOf(c) >= 0; });
  });
  if (!chosen.length){
    stage(5, "skip");
    det(5, "в каталоге нет магазинов этой категории (есть: велосипеды, клавиатуры) — стадия пропущена");
    return Promise.resolve([]);
  }
  stage(5, "active");
  det(5, "спрашиваю " + chosen.length + " магазин(ов) напрямую — запросы идут с твоего IP (CORS открыт)");
  var reports = [];
  var seq = Promise.resolve();
  chosen.forEach(function(shop){
    seq = seq.then(function(){
      return FS.shopifyChannel(shop, q).then(function(rep){
        reports.push(rep);
        state.shopReports = reports;
        if (rep.error) detLine(5, "<span class='bad'>✗ " + esc(shop.name) + ": " + esc(rep.error) + "</span>");
        else detLine(5, "✓ " + esc(shop.name) + ": " + rep.offers.length + " карточек");
      });
    });
  });
  return seq.then(function(){
    stage(5, reports.some(function(r){ return !r.error; }) ? "done" : "error");
    var offers = [];
    reports.forEach(function(r){ offers.push.apply(offers, r.offers); });
    return offers;
  });
}

// ---- ⑥ фильтр и итог ----------------------------------------------------------
function runFilter(cmp, productCards, shopOffers){
  // фильтруем по ОРИГИНАЛЬНОМУ запросу: русский «детский велосипед» не должен
  // требовать в русских названиях английские термины перевода («kids, bike»);
  // если по оригиналу пусто — запасной прогон по переводу (англоязычная выдача)
  var qOrig = state.query || (state.translated && state.translated.query) || "";
  var qTr = (state.translated && state.translated.query) || "";
  var offers = [];
  offers.push.apply(offers, shopOffers);
  offers.push.apply(offers, productCards);

  var marketOffers = [], fallback = [];
  if (cmp) cmp.candidates.forEach(function(c){
    if (c.sourceType === "market" && c.price){
      marketOffers.push(FS.marketCardToOffer(c, c.engines[0], c.currency || "RUB"));
    } else if (c.price && c.priceVia === "snippet"){
      // цена вынута из текста выдачи — полноценное предложение с ценой (≈),
      // а не фолбэк: ec-строка получит источник с ценой из выдачи
      marketOffers.push(FS.serpCandidateToOffer(c));
    } else {
      fallback.push(c);
    }
  });
  offers.push.apply(offers, marketOffers);

  // v15: прогонов несколько — берём первый, оставивший хотя бы одно предложение
  // с ценой. Карточки площадок/магазинов/вставленных страниц — доверенные
  // (площадка сама искала по нашему запросу): пропуск слова в названии не прячет
  // их, а лишь помечает флагом. Строгая проверка слов остаётся для веб-сниппетов
  // (google/яндекс/youtube). Именно строгая проверка прятала карточки Ozon/Ali
  // с ценами: в запросе «велосипед sava al pro» слово «велосипед» жёсткое, а в
  // названии магазина «Sava AL Pro 27.5» его нет — в итог попадали одни ролики
  // YouTube с дословным названием («карточки только с youtube»).
  var TRUSTED = function(o){ return o.platform !== "web" || o.verified === true; };
  var passes = [
    { q: qOrig, mode: "all" },
    { q: qOrig, mode: "any" },
    { q: qTr, mode: "all" },
    { q: qTr, mode: "any" }
  ].filter(function(p){ return p.q; });
  var f = null, chosenIdx = -1;
  for (var pi = 0; pi < passes.length; pi++){
    var cand = FC.filterOffers(offers, passes[pi].q, { termMode: passes[pi].mode, trustedFn: TRUSTED });
    if (!f) f = cand;   // первый (строгий) — запасной вариант, если ничего не пройдёт
    if (cand.kept.some(function(o){ return o.price > 0; })){ chosenIdx = pi; f = cand; break; }
  }
  if (chosenIdx < 0 && !f && offers.length)
    f = FC.filterOffers(offers, qOrig, { termMode: "any", trustedFn: TRUSTED });
  state.looseMatch = chosenIdx > 0;   // выиграл не-строгий прогон

  var resultOffers = f.kept;
  if (!resultOffers.length && fallback.length){
    resultOffers = fallback.filter(function(c){
      return !((c.missingTerms || []).filter(FC.isStrictToken).length);
    }).slice(0, 8).map(function(c){
      return FS.serpCandidateToOffer(c);
    });
    state.usedFallback = true;
  } else state.usedFallback = false;

  stage(6, "done");
  det(6, "проверено карточек " + f.stats.total + " · прошло " + f.stats.kept + " · скрыто с причинами " + f.stats.hidden +
    (state.usedFallback ? " · непроверенных ссылок (фолбэк): " + resultOffers.length : ""));

  renderResults(resultOffers, f);
}

// ---- рендер итогов -------------------------------------------------------------
// домен-источник в одну строку
function hostShort(u){
  var m = /^https?:\/\/([^\/"']+)/.exec(String(u || ""));
  return m ? m[1].replace(/^www\./, "") : String(u || "");
}

function renderResults(offers, f){
  var out = $("out");
  out.innerHTML = "";
  var statsEl = $("stats");
  statsEl.innerHTML = "";

  // ИИ-ответы поисковиков — сводкой сверху (в медиану не входят)
  state.aiAnswers.forEach(function(a){
    var d = document.createElement("div");
    d.className = "card ai-card";
    d.innerHTML = "<div class='shop'>🤖 ИИ-ответ · " + esc(engineName(a.src)) +
      (a.guess ? " (найден эвристикой)" : "") + "</div>" +
      "<div class='aitext'>" + esc(a.text).slice(0, 1200) + "</div>" +
      "<div class='meta'>это сводка поисковика с твоей вкладки, а не предложение товара — в медиану рынка не входит</div>";
    out.appendChild(d);
  });

  if (!offers.length){
    var why = (f.hidden || []).map(function(h){
      return "<div class='hid'><div class='r'>✗ " + esc(h.reason) + "</div>" +
        "<a href='" + esc(h.offer.url) + "' target='_blank' rel='noopener noreferrer'>" +
        esc((h.offer.title || "").slice(0, 90)) + "</a></div>";
    }).join("");
    if (!state.aiAnswers.length){
      out.innerHTML = "<div class='fatal'>ничего не нашлось" + (why ? " — фильтр скрыл все найденные предложения с причина́ми ниже" : "") +
        ". Чипы показывают статус окон: «жду окно» — открой кнопкой в чипе и нажми там закладку «📨 в фильтр». Две выдачи → итог соберётся сам.</div>" + why;
    }
    return;
  }

  // ecatalog-стиль: один товар — одна строка. Слева название (самое полное из
  // источников), справа — список источников с ценами; один и тот же товар из
  // разных выдач и магазинов склеивается в одну строку по значимым словам.
  var groups = {}, order = [];
  offers.forEach(function(o){
    // три значимых слова: «детский велосипед sava» vs «детский велосипед стелс» —
    // разные товары не склеиваются, а разные магазины одного товара — склеиваются
    var key = FC.significantTerms(o.title).slice(0, 3).join(" ") ||
              String(o.title || "").toLowerCase().slice(0, 80);
    if (!groups[key]){ groups[key] = { title: o.title, flags: [], srcs: [] }; order.push(groups[key]); }
    var g = groups[key];
    if ((o.title || "").length > g.title.length) g.title = o.title;
    if (!g.img && (o.image || o.img)) g.img = o.image || o.img;   // v14: картинка товара из выдачи
    g.srcs.push(o);
    (o.flags || []).forEach(function(fl){ if (g.flags.indexOf(fl) < 0) g.flags.push(fl); });
  });
  // релевантность запросу: сколько значимых слов запроса есть в названии
  // кластера. «sava al pro» → 3/3 сверху; «обзор велосипедов» → 0/3 — в
  // свёрнутый блок внизу, а не в лицо (в v13 такие лезли в первые карточки
  // через фолбэк — отсюда «карточки, никак не связанные с поиском»)
  var qTokens = FC.significantTerms(state.query || (state.translated && state.translated.query) || "");
  order.forEach(function(g){
    var lt = " " + String(g.title || "").toLowerCase() + " ";
    g._score = qTokens.filter(function(t){ return lt.indexOf(String(t).toLowerCase()) >= 0; }).length;
  });
  var hasPrice = function(g){ return g.srcs.some(function(x){ return x.price; }); };
  order.sort(function(a, b){
    if (b._score !== a._score) return b._score - a._score;
    var ha = hasPrice(a) ? 1 : 0, hb = hasPrice(b) ? 1 : 0;   // при равной релевантности — с ценой выше
    if (hb !== ha) return hb - ha;
    if (b.srcs.length !== a.srcs.length) return b.srcs.length - a.srcs.length;
    var pa = Math.min.apply(null, a.srcs.map(function(x){ return x.price || Infinity; }));
    var pb = Math.min.apply(null, b.srcs.map(function(x){ return x.price || Infinity; }));
    return pa - pb;
  });
  // основные: всё с совпадением по запросу ИЛИ с ценой; в свёрнутый блок —
  // только пустышки (ни одного слова запроса и ни одной цены). В v14 порог был
  // жёстче (≥2 слов) — карточки с ценами уезжали в свёрнутый блок, наверху
  // оставались одни дословные совпадения (youtube)
  var mainCards = order.filter(function(g){ return g._score > 0 || hasPrice(g); });
  var restCards = order.filter(function(g){ return !(g._score > 0 || hasPrice(g)); });

  var medLine = document.createElement("div");
  medLine.className = "stats";
  var meds = Object.keys(f.medians || {}).map(function(cur){
    return "<span class='b ok'>медиана " + cur + ": " + fmtPrice(f.medians[cur], cur) + "</span>";
  });
  medLine.innerHTML = meds.join(" ") +
    "<span class='b'>товаров: " + order.length + "</span>" +
    "<span class='b'>предложений: " + offers.length + "</span>" +
    (state.looseMatch ? "<span class='b warn'>частичное совпадение с запросом</span>" : "") +
    (state.usedFallback ? "<span class='b warn'>непроверенные ссылки (фолбэк)</span>" : "");
  statsEl.appendChild(medLine);

  function ecCardEl(g){
    var c = document.createElement("div");
    c.className = "card ec";
    var srcs = g.srcs.map(function(o){
      var approx = o.priceVia === "snippet" ? "≈" : "";
      var tag = o.priceVia === "market" ? "<span class='ec-tag'>маркетплейс</span>" :
                o.priceVia === "snippet" ? "<span class='ec-tag dim'>≈ из выдачи</span>" : "";
      return "<a class='ec-src' href='" + esc(o.url) + "' target='_blank' rel='noopener noreferrer'>" +
        "<span class='ec-shop'>" + esc(hostShort(o.url)) + "</span>" +
        (o.price ? "<span class='ec-price'>" + approx + " " + esc(fmtPrice(o.price, o.currency)) + "</span>" : "<span class='ec-price dim'>—</span>") +
        tag + "</a>";
    }).join("");
    var verified = g.srcs.some(function(x){ return x.verified; });
    // v14: картинка товара (из выдачи), если не загрузилась — плейсхолдер
    var th = g.img
      ? "<img class='ec-th' src='" + esc(g.img) + "' alt='' loading='lazy'>"
      : "<div class='ec-th ph'>" + esc((g.title || "?").charAt(0).toUpperCase()) + "</div>";
    c.innerHTML =
      th +
      "<div class='ec-name'>" +
        "<a class='t' href='" + esc(g.srcs[0].url) + "' target='_blank' rel='noopener noreferrer'>" + esc(g.title) + "</a>" +
        "<div class='ec-meta'>источников: " + g.srcs.length + (verified ? " · есть проверенная карточка товара" : "") +
          (state.usedFallback ? " · фолбэк" : "") +
          (state.looseMatch && qTokens.length && g._score < qTokens.length ?
            " · частичное совпадение: " + g._score + "/" + qTokens.length + " слов запроса" : "") + "</div>" +
        (g.flags.length ? "<div class='badges'>" + g.flags.slice(0, 3).map(function(x){
          return "<span class='b" + (/дороже рынка|сверь|не проверено/i.test(x) ? " warn" : "") + "'>" + esc(x) + "</span>";
        }).join("") + "</div>" : "") +
      "</div><div class='ec-srcs'>" + srcs + "</div>";
    var im = c.querySelector("img.ec-th");
    if (im) im.addEventListener("error", function(){
      var ph = document.createElement("div");
      ph.className = "ec-th ph";
      ph.textContent = (g.title || "?").charAt(0).toUpperCase();
      im.replaceWith(ph);
    });
    return c;
  }
  mainCards.forEach(function(g){ out.appendChild(ecCardEl(g)); });
  if (restCards.length){
    var d = document.createElement("details");
    d.className = "restbox";
    d.innerHTML = "<summary>менее похожие на запрос: " + restCards.length + " (свёрнуто)</summary>";
    restCards.forEach(function(g){ d.appendChild(ecCardEl(g)); });
    out.appendChild(d);
  }

  if (f.hidden && f.hidden.length){
    var hb = $("hidbox"); hb.hidden = false;
    $("hidsum").textContent = "скрыто фильтром: " + f.hidden.length + " (с причина́ми)";
    var hid = $("hid"); hid.innerHTML = "";
    f.hidden.forEach(function(h){
      var d = document.createElement("div");
      d.className = "hid";
      d.innerHTML = "<div class='r'>✗ " + esc(h.reason) + "</div>" +
        "<a href='" + esc(h.offer.url) + "' target='_blank' rel='noopener noreferrer'>" + esc((h.offer.title || "").slice(0, 90)) + "</a>";
      hid.appendChild(d);
    });
  } else $("hidbox").hidden = true;
}

// ============================================================================
// ПОТОК ПОИСКА: «искать» → открываю вкладки с твоим запросом → в каждой
// вкладке один клик по закладке «📨 в фильтр» (или ноль кликов со
// пользовательским скриптом) → вкладка сама шлёт выдачу и закрывается →
// две выдачи → итог с медианой собирается здесь сам.
// ============================================================================
function startSearch(){
  var q = ($("q").value || "").trim();
  if (!q){
    addLog("введи запрос — например, «sava a7l carbon road bike» или «детский велосипед»", "warn");
    $("q").focus();
    return;
  }
  state.pages = []; state.pastedIds = []; state.openedIds = []; state.autos = {};
  state.dedupTs = {};   // дедуп отчётов — на новый поиск с чистого листа
  state.aiAnswers = [];
  for (var k in bridgeTried) delete bridgeTried[k];
  state.shopReports = []; state.shopOffers = []; state.usedFallback = false;
  state.queue = TAB_ENGINES.concat(EXTRA_ENGINES);
  state.query = q; state.finalized = false; state.searching = true;
  state.tabsOpened = false;

  buildStages();
  ensureQuery(false);
  $("out").innerHTML = ""; $("hidbox").hidden = true; $("stats").innerHTML = "";

  stage(2, "active");
  state.queue.forEach(function(id){ if (!state.autos[id]) state.autos[id] = { state: "wait" }; });
  renderChips();

  // магазины — напрямую с твоего IP (CORS открыт, прокси не нужен)
  state.shopsPromise = runShops().then(function(offers){
    state.shopOffers = offers;
    if (state.finalized) rerunFinal();
    return offers;
  }, function(){ return []; });

  if (state.bridge.ready){
    // расширение: поисковики под капотом с куками пользователя, вкладки не нужны
    ["google", "yandex", "bing", "ddg"].forEach(function(id){
      if (!bridgeTried[id]) bridgeFetchEngine(id);
    });
    EXTRA_ENGINES.forEach(function(id){ if (id !== "marginalia") state.autos[id] = { state: "err", msg: "нет канала" }; });
    courier("мост активен: поисковики под капотом с твоими куками — вкладки не открываются. Хочешь больше источников — кнопки в чипах.");
    addLog("ищу «" + esc(q) + "»: поисковики под капотом (расширение), магазины напрямую");
  } else {
    // popup-окна поисковиков каскадом (друг под другом), последним —
    // окно-анимация: оно перекрывает всю стопку и показывает живой прогресс
    var opened = 0, failed = [];
    TAB_ENGINES.forEach(function(id, i){
      if (openSearchWindow(id, i)) opened++; else failed.push(engineName(id));
    });
    state.tabsOpened = opened > 0;
    var workerOk = opened > 0 && openWorkerWindow(q);
    if (!opened){
      courier("браузер заблокировал окна поиска. Разреши всплывающие окна для этого сайта (значок в адресной строке) и нажми «искать» ещё раз — или открывай поисковики кнопками в чипах");
      addLog("окна заблокированы браузером", "warn");
    } else {
      courier("открыл <b>" + opened + "</b> окон с твоим запросом (каскадом, друг под другом): все поисковики (Google, Яндекс, Bing, DuckDuckGo, Brave, Mojeek) и <b>Ozon, Avito, AliExpress — оттуда цены в рублях</b>" +
        (workerOk ? ", и окно поиска поверх — на нём виден прогресс, оно закроется само, когда пришлются минимум два источника" : "") +
        ". Со скриптом окна отчитываются сами и закрываются; без него — один клик по закладке «📨 в фильтр» в каждом. Окна, которые браузер не даст закрыть странице после перехода с поисковика, закрой Ctrl+W — данные уже на этой странице" +
        (failed.length ? ". Не открылись: " + esc(failed.join(", ")) + " — кнопки в чипах" : ""));
      addLog("ищу «" + esc(q) + "»: открыл " + opened + " окон (поисковики + маркетплейсы)" + (workerOk ? " + окно поиска" : "") +
        (failed.length ? "; не открылись: " + failed.join(", ") : ""));
    }
    var bo = $("bridgeOff");
    if (bo) bo.hidden = false;
  }
}

function finishSearch(){
  if (state.finalized){ rerunFinal(); return; }
  state.finalized = true;
  state.searching = false;
  stage(2, "done");
  var srcs = serpCount();
  // окну-анимации — сигнал «готово» (оно само доиграет анимацию и закроется);
  // окна поисковиков, которые ещё открыты, пробуем закрыть от имени открывшей
  // страницы; свою вкладку выдвигаем на передний план
  try { if (relayChannel) relayChannel.postMessage({ fsWorkerDone: 1, srcs: srcs, query: state.query }); } catch(e){}
  closeOurWindows();
  try { window.focus(); } catch(e){}
  courier("итог собран из " + srcs + " источника(ов). Пришлются ещё — итог пересчитается сам (окна, которые ещё открыты, отчитаются так же). Не хватило цен — жми <b>Ozon</b> / <b>Avito</b> / <b>AliExpress</b> в чипах: окно → закладка «📨 в фильтр» → цены вольются");
  addLog("итог собран: " + srcs + " источника(ов), ИИ-ответов: " + state.aiAnswers.length);
  renderChips();
  rerunFinal();
}

function rerunFinal(){
  var cmp = runCompare();
  var productCards = runProductPages();
  renderAiCards();
  var build = function(){
    try { runFilter(cmp, productCards, state.shopOffers); }
    catch(e){
      det(6, "<span class='bad'>сборка итога не удалась: " +
        esc(String(e && e.stack || e).split("\n").slice(0, 3).join(" | ").slice(0, 220)) + "</span>");
      addLog("ошибка сборки итога: " + esc(String(e && e.message || e).slice(0, 120)), "bad");
      stage(6, "error");
    }
  };
  if (state.shopsPromise) state.shopsPromise.then(build, build);
  else build();
}

// ---- ручной режим (без «искать»): вставил → нажал «разобрать» ------------------
function runAll(){
  if (!stageEls[1]) buildStages();
  state.offers = [];
  if (!ensureQuery(true)){
    det(1, "<span class='bad'>введи запрос или вставь страницу — запрос подхватится сам из заголовка</span>");
    stage(1, "error");
    return;
  }
  if (!state.pages.length){
    stage(2, "error");
    det(2, "<span class='bad'>нет источников: нажми «искать» — вкладки откроются сами, или вставь страницу/JSON вручную</span>");
    return;
  }
  $("out").innerHTML = "";
  $("hidbox").hidden = true;
  state.finalized = true; state.searching = false;
  addLog("разбираю вручную: " + state.pages.length + " страниц(ы), запрос «" + state.query + "»");
  rerunFinal();
}

// ---- экспорт --------------------------------------------------------------------
function exportJson(){
  var cards = Array.prototype.map.call($("out").querySelectorAll(".card:not(.ai-card)"), function(c){
    return { title: c.querySelector("a.t").textContent, url: c.querySelector("a.t").href };
  });
  if (!cards.length){ addLog("нечего экспортировать — итог ещё не собран", "warn"); return; }
  var data = {
    query: state.query, translated: state.translated,
    exportedAt: new Date().toISOString(),
    aiAnswers: state.aiAnswers.map(function(a){ return { source: engineName(a.src), text: a.text.slice(0, 500) }; }),
    pages: state.pages.map(function(p){ return { source: p.name, query: p.query, items: p.items.length, block: p.block, via: p.via }; }),
    offers: cards
  };
  download("filter-search-result.json", JSON.stringify(data, null, 2), "application/json");
  addLog("выгружен JSON (" + cards.length + " карточек)");
}
function exportCsv(){
  var cards = Array.prototype.map.call($("out").querySelectorAll(".card:not(.ai-card)"), function(c){
    var price = c.querySelector(".price");
    return { title: c.querySelector("a.t").textContent, url: c.querySelector("a.t").href,
             price: price ? price.textContent.trim() : "" };
  });
  if (!cards.length){ addLog("нечего экспортировать — итог ещё не собран", "warn"); return; }
  var rows = [["название", "цена", "ссылка"]].concat(cards.map(function(c){
    return [c.title, c.price, c.url];
  }));
  var csv = "\uFEFF" + rows.map(function(r){
    return r.map(function(x){ return '"' + String(x).replace(/"/g, '""') + '"'; }).join(";");
  }).join("\r\n");
  download("filter-search-result.csv", csv, "text/csv");
  addLog("выгружен CSV (" + cards.length + " карточек)");
}
function download(name, content, mime){
  var b = new Blob([content], { type: mime + ";charset=utf-8" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---- сброс ------------------------------------------------------------------------
function resetAll(){
  try { if (workerRef && !workerRef.closed) workerRef.close(); } catch(e){}
  workerRef = null;
  state = { query: "", translated: null, pages: [], aiAnswers: [], shopReports: [], shopOffers: [], shopsPromise: null,
            offers: [], usedFallback: false, searching: false, finalized: false,
            queue: [], pastedIds: [], openedIds: [], tabsOpened: false,
            bridge: state.bridge, autos: {} };   // мост переживает сброс
  for (var k in bridgeTried) delete bridgeTried[k];
  $("q").value = "";
  $("prog").innerHTML = ""; $("prog").hidden = true;
  stageEls = {};
  $("out").innerHTML = "";
  $("hidbox").hidden = true;
  $("stats").innerHTML = "";
  $("log").hidden = true; $("log").innerHTML = "";
  $("chips").hidden = true; $("chips").innerHTML = "";
  var bo = $("bridgeOff");
  if (bo && !state.bridge.ready) bo.hidden = false;
  courier("");
  updatePasteHint();
}

// ---- подсказки Google (JSONP, твой IP) ---------------------------------------------
var suggestTimer = null;
function runSuggest(){
  var q = ($("q").value || "").trim();
  if (q.length < 3){ $("sugg").hidden = true; return; }
  FS.googleSuggest(q).then(function(list){
    var box = $("sugg");
    if (!list || !list.length){ box.hidden = true; return; }
    box.innerHTML = "";
    list.slice(0, 8).forEach(function(s){
      var d = document.createElement("div");
      d.className = "sugg-item"; d.textContent = s;
      d.addEventListener("click", function(){
        $("q").value = s; box.hidden = true;
        state.query = s; ensureQuery(false);
      });
      box.appendChild(d);
    });
    box.hidden = false;
  });
}

// ---- события -----------------------------------------------------------------------
document.addEventListener("paste", handlePasteEvent);
setTimeout(function pingBridge(){
  window.postMessage({ type: "FS_BRIDGE_PING" }, location.protocol === "file:" ? "*" : location.origin);
  setTimeout(pingBridge, 3000);
}, 400);
document.addEventListener("dragover", function(e){ e.preventDefault(); });
document.addEventListener("drop", function(e){
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});
$("file").addEventListener("change", function(){ handleFiles(this.files); this.value = ""; });
$("goAuto").addEventListener("click", startSearch);
$("go").addEventListener("click", runAll);
$("finishNow").addEventListener("click", function(){
  if (!state.pages.length){ addLog("пока нечего собирать — пришли хотя бы одну вкладку", "warn"); return; }
  finishSearch();
});
$("grabClip").addEventListener("click", grabClipboard);
(function(){ var g2 = $("grabClip2"); if (g2) g2.addEventListener("click", grabClipboard); })();
$("q").addEventListener("keydown", function(e){ if (e.key === "Enter"){ e.preventDefault(); startSearch(); } });
$("reset").addEventListener("click", resetAll);
$("expJson").addEventListener("click", exportJson);
$("expCsv").addEventListener("click", exportCsv);
$("q").addEventListener("input", function(){
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(runSuggest, 450);
});
$("q").addEventListener("blur", function(){ setTimeout(function(){ $("sugg").hidden = true; }, 200); });
updatePasteHint();

function updatePasteHint(){
  var n = state.pages.filter(function(p){ return p.via !== "auto"; }).length;
  $("pasteHint").innerHTML = n === 0
    ? "выдачу можно и просто вставить сюда (<kbd>Ctrl+V</kbd> HTML или JSON от букмарклета) или перетащить файл"
    : "принесено страниц: <b>" + n + "</b>" + (serpCount() < 2 ? " — добавь ещё одно окно для перекрёстных подтверждений" : " — подтверждения между выдачами уже считаются");
}
})();
