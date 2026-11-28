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
var FC = window.FilterCore, FS = window.FSCore, FB = window.FSBridge, FP = window.FSPlanner;
var $ = function(id){ return document.getElementById(id); };

var SERP_IDS = ["google", "yandex", "bing", "ddg", "mojeek", "brave", "marginalia"];
// маркетплейсы: цены в рублях, отчёты принимаем как источники карточек
var MARKET_IDS = ["ozon", "avito", "ali"];
// этап 1: источники для поиска выбирает планировщик по намерению (3–4 окна
// вместо десяти); TAB_ENGINES остались запасом — кнопки «ещё источники» в панели
var TAB_ENGINES = ["google", "yandex", "bing", "ddg", "brave", "mojeek", "ozon", "avito", "ali", "marginalia"];
var EXTRA_ENGINES = [];

// ---- состояние ---------------------------------------------------------------
var state = {
  query: "", translated: null,
  plan: null,           // план запроса (planner.js): намерение, сущности, тексты, лестница
  ladderStep: 0,        // текущий шаг лестницы ослабления (0 — строгий запрос)
  stepOffered: null,    // шаг, предложенный кнопкой «смягчить запрос» (режим окон)
  passForced: false,    // итог собран кнопкой «готово» до отчётов всех источников
  lastFilter: null,     // последний итог: { main, similar, hidden, step }
  note: "",             // заметка для пользователя в строке статуса
  pages: [],            // источники: {id, name, query, items, via, block, isProductPage, html}
  aiAnswers: [],        // ИИ-ответы поисковиков: {src, text, guess, ts, key}
  shopReports: [], shopOffers: [], shopsPromise: null,
  offers: [], usedFallback: false,
  searching: false,
  finalized: false,
  queue: [],            // источники текущего поиска (из плана)
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
  // вкладка отчитывается запросом КАК ОН ВВЕДЁН в поисковик: оригинал, перевод
  // или любой текст из плана (строгий запрос, шаг лестницы, рыночный текст)
  var qOk = !state.query || !p.q ||
            normQ(p.q) === normQ(state.query) ||
            (state.translated && normQ(p.q) === normQ(state.translated.query)) ||
            (state.plan && FP && FP.isKnownQuery(state.plan, p.q));
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

// ИИ-ответ поисковика — отдельная сводка в технической панели, в карточки
// товаров не попадает
function pushAiAnswer(src, text, guess){
  var key = src + "|" + normQ(text).slice(0, 80);
  for (var i = 0; i < state.aiAnswers.length; i++)
    if (state.aiAnswers[i].key === key) return;
  state.aiAnswers.push({ src: src, text: text, guess: guess, ts: Date.now(), key: key });
  addLog("🤖 ИИ-ответ " + esc(engineName(src)) + " принят" + (guess ? " (эвристика)" : ""));
  renderAiCards();
}
function renderAiCards(){
  var box = $("aiBox");
  if (!box) return;
  box.innerHTML = state.aiAnswers.slice().reverse().map(function(a){
    return "<div class='ai-card'>" +
      "<div class='shop'>🤖 ИИ-ответ · " + esc(engineName(a.src)) + (a.guess ? " (найден эвристикой)" : "") + "</div>" +
      "<div class='aitext'>" + esc(a.text).slice(0, 1200) + "</div>" +
      "<div class='meta'>сводка поисковика с твоей вкладки, а не предложение товара — в медиану рынка не входит</div></div>";
  }).join("");
  box.hidden = !state.aiAnswers.length;
  updatePanelSummary();
}
// счётчики в заголовке технической панели: что там лежит, не открывая её
function updatePanelSummary(){
  var s = $("techSum");
  if (!s) return;
  var parts = [];
  if (state.aiAnswers.length) parts.push("ИИ-ответы: " + state.aiAnswers.length);
  if (state.lastFilter && state.lastFilter.hidden.length) parts.push("скрыто с причинами: " + state.lastFilter.hidden.length);
  s.textContent = parts.length ? "· " + parts.join(" · ") : "";
}

// подкапотный fetch поисковика через расширение (Chrome, если стоит)
var bridgeTried = {};
// окна поиска, открытые страницей: на «готово» главная страница пробует закрыть
// их сама (закроются те, где флаг «открыто скриптом» не порван COOP-переходом)
var popupRefs = {}, workerRef = null;
function bridgeFetchEngine(id){
  var url = engineUrl(id);
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
// статус источников текущего поиска (очередь из плана); остальные поисковики и
// площадки — запасные кнопки в той же технической панели
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
  // площадки вне очереди — кнопки (открываем по желанию — оттуда приходят цены)
  MARKET_IDS.forEach(function(id){
    if (state.queue.indexOf(id) >= 0) return;
    var got = state.pastedIds.indexOf(id) >= 0;
    var cls = "chip btn" + (got ? " ok" : "");
    var lbl = engineName(id) + (got ? " ✓" : " — цены");
    html += "<button type='button' class='" + cls + "' data-engine='" + id + "'>" + esc(lbl) + "</button>";
  });
  // прочие поисковики — запасные источники
  TAB_ENGINES.forEach(function(id){
    if (state.queue.indexOf(id) >= 0 || MARKET_IDS.indexOf(id) >= 0) return;
    html += "<button type='button' class='chip btn dim' data-engine='" + id + "' title='запасной источник — тем же запросом'>" +
            esc(engineName(id) + " — ещё") + "</button>";
  });
  box.innerHTML = html;
  box.hidden = false;
  Array.prototype.forEach.call(box.querySelectorAll("button[data-engine]"), function(b){
    b.addEventListener("click", function(){ openEngineTab(b.getAttribute("data-engine")); });
  });
}

// ---- строка статуса: единственный видимый служебный текст ----------------------
// всё остальное (журнал, стадии, чипы, причины скрытия) — в технической панели
function renderStatus(){
  var c = $("courier");
  if (!c) return;
  var lf = state.lastFilter;
  var parts = [];
  if (state.searching){
    var got = state.queue.filter(function(id){ return state.pastedIds.indexOf(id) >= 0; }).length;
    parts.push("ищу <b>" + esc(state.query) + "</b>: пришло " + got + " из " + state.queue.length +
      " источников" + (state.plan && state.plan.layoutFixed ? " (раскладка исправлена: «" + esc(state.plan.layoutFixed) + "»)" : ""));
  } else if (lf){
    parts.push("основных карточек: <b>" + lf.main.length + "</b> · похожих: " + lf.similar.length +
      " · скрыто с причинами: " + lf.hidden.length);
  }
  if (state.note) parts.push(state.note);
  if (state.stepOffered != null && state.plan){
    var st = state.plan.ladder.ru[state.stepOffered];
    parts.push("основных предложений с ценой меньше трёх — смягчить запрос: <button type='button' class='sbtn' data-act='step'>" +
      "шаг " + (state.stepOffered + 1) + " из " + state.plan.ladder.ru.length + " — «" + esc(st ? st.name : "") + "»</button>");
  }
  // единственная видимая подсказка для новичка: как передать выдачу (один раз,
  // пока в этом браузере не пришла ни одна выдача и нет моста-расширения)
  if (!state.bridge.ready && !payloadSeen())
    parts.push("первый раз здесь: <button type='button' class='sbtn ghost' data-act='setup'>как передать выдачу — 1 минута</button>");
  c.innerHTML = parts.map(function(p){ return "<span>" + p + "</span>"; }).join(" ");
  c.hidden = !parts.length;
}
var PAYLOAD_SEEN_KEY = "fsPayloadSeen";
function payloadSeen(){
  try { return !!localStorage.getItem(PAYLOAD_SEEN_KEY); } catch(e){ return false; }
}
function markPayloadSeen(){
  try { localStorage.setItem(PAYLOAD_SEEN_KEY, "1"); } catch(e){}
}
// открыть техническую панель на разделе настройки
function openSetup(){
  var t = $("tech"), bo = $("bridgeOff");
  if (t) t.open = true;
  if (bo) bo.hidden = false;
  if (bo && bo.scrollIntoView) bo.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- курьер-подсказка ----------------------------------------------------------
// заметка в строке статуса (что сделать пользователю); пустая строка убирает её
function courier(html){
  state.note = html || "";
  renderStatus();
}

// ---- ① запрос: план (намерение, сущности, тексты, лестница) и запасной перевод --
function ensureQuery(auto){
  if (!state.query) state.query = ($("q").value || "").trim();
  if (!state.query && auto) return false;
  if (state.query){
    // план строится один раз на строку запроса; лестница — с первого шага
    if (FP && (!state.plan || state.plan.raw !== state.query)){
      state.plan = FP.buildPlan(state.query);
      state.ladderStep = 0; state.stepOffered = null;
    }
    var tr = FC.translateQuery(state.query);
    state.translated = tr;
    stage(1, "done");
    det(1, "«" + esc(state.query) + "»" +
      (state.plan && state.plan.layoutFixed ? " → раскладка: <b>" + esc(state.plan.layoutFixed) + "</b>" : "") +
      (tr.translated ? " → запасной перевод: <b>" + esc(tr.query) + "</b>" : ""));
    renderPlan();
  }
  return !!state.query;
}

// журнал плана в технической панели: что именно поедет в каждый источник
function renderPlan(){
  var box = $("planBox");
  if (!box || !FP) return;
  var p = state.plan;
  if (!p){ box.innerHTML = ""; box.hidden = true; return; }
  var cur = Math.min(state.ladderStep, p.ladder.ru.length - 1);
  var html = FP.describePlan(p).map(function(r){
    return "<div class='pl'><span class='k'>" + esc(r[0]) + "</span><span class='v'>" + esc(r[1]) + "</span></div>";
  }).join("");
  html += "<div class='pl'><span class='k'>текущий шаг</span><span class='v'>" + (cur + 1) + " из " + p.ladder.ru.length +
    " — " + esc(p.ladder.ru[cur] ? p.ladder.ru[cur].name : "") + "</span></div>";
  if (p.shoppingUrl)
    html += "<div class='pl'><span class='k'>Google Shopping, фильтр цены</span><span class='v'><a href='" + esc(p.shoppingUrl) +
      "' target='_blank' rel='noopener noreferrer'>проверить вручную (этап 0)</a> — сама страница адрес не открывает</span></div>";
  box.innerHTML = html;
  box.hidden = false;
  renderDialectLinks();
}

// ссылки проверки диалектов (этап 0): адреса второй волны по текущему плану.
// Параметры P6/P8/P11 в адреса поиска страница не встраивает — их эффект
// измеряется вручную; отметки — только в localStorage этого браузера
function renderDialectLinks(){
  var box = $("dialect");
  if (!box) return;
  var p = state.plan;
  var en = p ? p.queries.en : "", ru = p ? p.queries.ru : "";
  var pad = function(n){ return (n < 10 ? "0" : "") + n; };
  var ymd = function(d){ return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); };
  var nowD = new Date();
  var yearAgo = new Date(nowD.getFullYear() - 1, nowD.getMonth(), nowD.getDate());
  var lit = ru.split(/\s+/).filter(function(w){ return w && w.charAt(0) !== "-"; })
    .map(function(w){ return "!" + w; }).join(" ");
  var G = "https://www.google.com/search?q=" + encodeURIComponent(en);
  var Y = "https://yandex.ru/search/?text=" + encodeURIComponent(ru);
  var urls = {
    p6g: en ? G + "&hl=ru&gl=RU" : "",
    p6y: ru ? Y + "&lr=213" : "",
    p8g: en ? G + "&tbs=qdr:y" : "",
    p8y: ru ? Y + "&date:" + ymd(yearAgo) + ".." + ymd(nowD) : "",
    p11g: en ? G + "&nfpr=1&tbs=li:1" : "",
    p11y: lit ? "https://yandex.ru/search/?text=" + encodeURIComponent(lit) : ""
  };
  Array.prototype.forEach.call(box.querySelectorAll("[data-dialect-link]"), function(a){
    var u = urls[a.getAttribute("data-dialect-link")];
    if (u){
      a.href = u; a.title = u;
      a.classList.remove("dim");
    } else {
      a.removeAttribute("href"); a.title = "сначала введи запрос";
      a.classList.add("dim");
    }
  });
}

// ---- этап 0: контрольные запросы и проверка диалектов ---------------------------
// тридцать запросов с готовым планом; клик подставляет запрос и запускает поиск
function renderControl(){
  var box = $("ctl");
  if (!box || !FP) return;
  box.innerHTML = FP.CONTROL_QUERIES.map(function(c, i){
    var p = FP.buildPlan(c.q);
    return "<div class='ctl'><span class='n'>" + (i + 1) + "</span>" +
      "<button type='button' class='lnk' data-q='" + esc(c.q) + "' title='подставить и искать'>" + esc(c.q) + "</button>" +
      "<span class='v'>" + esc(p.intentRu) + " · " + esc(p.sources.map(engineName).join(", ")) +
      " · Яндекс: «" + esc(p.queries.ru) + "»</span></div>";
  }).join("");
}
// отметки «сработало / не сработало» по параметрам второй волны — только в
// localStorage этого браузера; никуда не отправляются
var DIALECT_KEY = "fsDialect";
function dialectMarks(){
  try { return JSON.parse(localStorage.getItem(DIALECT_KEY) || "{}") || {}; } catch(e){ return {}; }
}
function markDialect(id, ok){
  var m = dialectMarks();
  m[id] = { ok: !!ok, at: new Date().toISOString() };
  try { localStorage.setItem(DIALECT_KEY, JSON.stringify(m)); } catch(e){}
  renderDialectMarks();
}
function renderDialectMarks(){
  var box = $("dialect");
  if (!box) return;
  var m = dialectMarks();
  Array.prototype.forEach.call(box.querySelectorAll("[data-dialect]"), function(row){
    var st = row.querySelector(".st");
    if (!st) return;
    var v = m[row.getAttribute("data-dialect")];
    st.textContent = v ? (v.ok ? "✓ сработало" : "✗ не сработало") : "не проверено";
    st.className = "st " + (v ? (v.ok ? "ok" : "bad") : "");
  });
}
function appVersion(){
  var m = document.querySelector('meta[name="you-market-version"]');
  return m ? m.getAttribute("content") : "";
}
// отчёт этапа 0: план, карточки трёх вердиктов с причинами и метрики таблицы 5.
// Скачивается файлом на диск пользователя — телеметрии нет
function buildReport(){
  var p = state.plan;
  var lf = state.lastFilter || { main: [], similar: [], hidden: [], step: 0 };
  var pack = function(list){
    return list.map(function(g){
      return { title: g.title, url: g.url, verdict: g.verdict || "hidden", reason: g.reason || "",
               why: g.why || [], score: g.score, max: g.max, price: g.price || null, currency: g.currency || null };
    });
  };
  var main = pack(lf.main), similar = pack(lf.similar), hidden = pack(lf.hidden);
  var e = p && p.entities;
  var buying = !!(p && (p.intent === "buy" || p.intent === "used"));
  var bmDefined = !!(e && e.brand && e.model);
  var bmOk = bmDefined ? lf.main.filter(function(g){ return brandModelIn(e, g.title); }).length : null;
  var noise = buying ? lf.main.filter(function(g){ return FP.INFO_RE.test(g.title); }).length : null;
  var metrics = {
    "основных карточек": main.length,
    "похожих": similar.length,
    "скрыто с причинами": hidden.length,
    "основных с брендом и моделью, %": bmDefined ? Math.round(100 * bmOk / Math.max(main.length, 1)) : null,
    "информационного шума среди основных, %": buying ? Math.round(100 * noise / Math.max(main.length, 1)) : null,
    "запросов со словами бюджета в тексте запроса": p ? (/до |тысяч|тыс\b/.test(p.queries.ru + " " + p.queries.en) ? 1 : 0) : null,
    "источников на поиск": p ? p.sources.length : null
  };
  var report = {
    service: "you.market", version: appVersion(), generatedAt: new Date().toISOString(),
    stage: "этап 0 — диагностический прогон", query: state.query, ladderStep: state.ladderStep,
    plan: p ? { intent: p.intentRu, layoutFixed: p.layoutFixed, queries: p.queries, sources: p.sources,
                ladder: p.ladder, budget: e.budget, shoppingUrl: p.shoppingUrl } : null,
    metrics: metrics, metricTargets: { "основных с брендом и моделью, %": "≥ 90",
      "информационного шума среди основных, %": "≤ 10",
      "запросов со словами бюджета в тексте запроса": "0", "источников на поиск": "3–4" },
    cards: { main: main, similar: similar, hidden: hidden },
    pages: state.pages.map(function(pg){ return { source: pg.name, query: pg.query, items: pg.items.length, via: pg.via, block: pg.block }; }),
    dialectMarks: dialectMarks(),
    control: FP ? FP.CONTROL_QUERIES.map(function(c){
      var cp = FP.buildPlan(c.q);
      return { kind: c.kind, q: c.q, intent: cp.intentRu, sources: cp.sources, queries: cp.queries,
               ladderRu: cp.ladder.ru.map(function(s){ return s.q; }) };
    }) : []
  };
  download("you-market-report-" + new Date().toISOString().slice(0, 10) + ".json",
           JSON.stringify(report, null, 2), "application/json");
  addLog("отчёт этапа 0 выгружен: основных " + main.length + ", похожих " + similar.length + ", скрытых " + hidden.length);
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
      plan: state.plan ? { intent: state.plan.intent, queries: state.plan.queries, sources: state.plan.sources,
                           ladderStep: state.ladderStep, urls: state.plan.urls } : null,
      ladderStep: state.ladderStep, stepOffered: state.stepOffered,
      lastFilter: state.lastFilter ? { main: state.lastFilter.main.length, similar: state.lastFilter.similar.length,
                                       hidden: state.lastFilter.hidden.length } : null,
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
  markPayloadSeen();   // выдача дошла — подсказка «как передать выдачу» больше не нужна
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
  renderStatus();
  if (state.searching){
    // две выдачи — итог собирается; все источники прохода отчитались — тоже
    if (serpCount() >= 2 || passSettled()) finishSearch();
  } else if (state.finalized){
    rerunFinal();   // поздний источник (Ozon с ценами, ещё одна вкладка) — пересобрать
  }
}

function serpCount(){
  var seen = {};
  state.pages.forEach(function(p){ if (SERP_IDS.indexOf(p.id) >= 0 && p.items.length) seen[p.id] = 1; });
  return Object.keys(seen).length;
}
// все источники текущего прохода либо прислали выдачу, либо честно отказались
function passSettled(){
  if (!state.queue.length) return true;
  return state.queue.every(function(id){
    return state.pastedIds.indexOf(id) >= 0 ||
           !!(state.autos[id] && state.autos[id].state === "err");
  });
}
// поисковики плана (площадки от лестницы не зависят — им всегда рыночный текст)
function planSerpSources(){
  return state.plan ? state.plan.sources.filter(function(id){ return SERP_IDS.indexOf(id) >= 0; }) : [];
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
// текст запроса для источника — из плана: Яндексу строгий русский запрос
// текущего шага лестницы, остальным поисковикам — английский, площадкам —
// короткий «рыночный» текст. Без плана (старый путь) — как раньше
function engineQuery(id){
  if (state.plan && FP) return FP.engineQuery(state.plan, id, state.ladderStep);
  var useOriginal = (id === "yandex" || id === "ozon" || id === "avito" || id === "ali");
  return useOriginal ? state.query :
         ((state.translated && state.translated.query) || state.query);
}
function engineUrl(id){
  if (state.plan && FP) return FP.engineUrl(state.plan, id, state.ladderStep);
  return FS.buildEngineUrl(id, engineQuery(id));
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
  var url = engineUrl(id);
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
    courier("открыл <b>" + esc(engineName(id)) + "</b>: один клик по закладке «📨 в фильтр товаров» — окно само передаст результат и закроется" +
      (state.finalized ? "; итог пересоберётся сам" : ""));
    addLog("открыл окно " + engineName(id) + " по кнопке");
  } else {
    courier("браузер не дал открыть окно — разреши всплывающие окна для этого сайта (значок в адресной строке) и нажми кнопку снова");
  }
  renderChips();
  renderStatus();
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
  // слова для сверки названий — из плана (без «купить» и минус-слов), иначе перевод
  var q = state.plan ? (state.plan.queries.market + " " + state.plan.queries.marketEn) :
          ((state.translated && state.translated.query) || state.query || "");
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
  // англоязычные магазины — структурированным английским текстом из плана
  var q = (state.plan && state.plan.queries.marketEn) ||
          (state.translated && state.translated.query) || state.query || "";
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
  // этап 1: веб-ссылка без цены — тоже кандидат. Планировщик снимает за это
  // балл, а не вычёркивает молча: страница товара на сайте бренда без цены
  // полезнее скрытой, а обзор, запчасть и чужая модель получают причину в
  // списке скрытых (прежде такие ссылки молча ждали очереди в резерве)
  if (state.plan && FP) fallback.forEach(function(c){ marketOffers.push(FS.serpCandidateToOffer(c)); });
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
  var f = { hidden: [], medians: {}, median: 0, stats: { total: offers.length, kept: 0, hidden: 0 } };
  var resultOffers = [];

  if (state.plan && FP){
    // этап 1: одна взвешенная оценка (planner.js) вместо четырёх прогонов по
    // словам. Базовая годность — правила filter-core (ссылка, наличие, подделки);
    // дальше три вердикта: основная / похожая / скрыта с причиной
    var shown = [];
    offers.forEach(function(o){
      var why = baseInvalid(o);
      if (why){ f.hidden.push({ offer: o, reason: why }); return; }
      var flags = baseFlags(o);
      if (flags.length) o.flags = (o.flags || []).concat(flags);
      o.trusted = TRUSTED(o);
      var r = FP.scoreOffer(state.plan, o);
      o.verdict = r.verdict; o.reason = r.reason; o.why = r.why; o.score = r.score; o.max = r.max;
      if (r.verdict === "hidden") f.hidden.push({ offer: o, reason: r.reason });
      else shown.push(o);
    });
    // цена против рынка — отдельно по валютам и только среди карточек с ценой
    var priced = shown.filter(function(o){ return o.price > 0; });
    var pf = FC.applyPriceFilter(priced);
    f.hidden = f.hidden.concat(pf.hiddenByPrice);
    f.medians = pf.medians; f.median = pf.median;
    resultOffers = shown.filter(function(o){ return o.price > 0 ? pf.kept.indexOf(o) >= 0 : true; });
    state.looseMatch = false;
  } else {
    // без плана — прежний путь: строгий прогон filter-core, затем мягче
    var qOrig = state.query || (state.translated && state.translated.query) || "";
    var qTr = (state.translated && state.translated.query) || "";
    var passes = [
      { q: qOrig, mode: "all" },
      { q: qOrig, mode: "any" },
      { q: qTr, mode: "all" },
      { q: qTr, mode: "any" }
    ].filter(function(p){ return p.q; });
    var fl = null, chosenIdx = -1;
    for (var pi = 0; pi < passes.length; pi++){
      var cand = FC.filterOffers(offers, passes[pi].q, { termMode: passes[pi].mode, trustedFn: TRUSTED });
      if (!fl) fl = cand;
      if (cand.kept.some(function(o){ return o.price > 0; })){ chosenIdx = pi; fl = cand; break; }
    }
    if (!fl && offers.length) fl = FC.filterOffers(offers, qOrig, { termMode: "any", trustedFn: TRUSTED });
    if (fl){
      f = { hidden: fl.hidden, medians: fl.medians, median: fl.median, stats: fl.stats };
      resultOffers = fl.kept;
    }
    state.looseMatch = chosenIdx > 0;
  }

  if (!resultOffers.length && fallback.length){
    // последний резерв: ссылки без цены, не противоречащие строгим словам запроса
    resultOffers = fallback.filter(function(c){
      return !((c.missingTerms || []).filter(FC.isStrictToken).length);
    }).slice(0, 8).map(function(c){
      return FS.serpCandidateToOffer(c);
    });
    state.usedFallback = true;
  } else state.usedFallback = false;
  f.stats.kept = resultOffers.length;
  f.stats.hidden = f.hidden.length;

  stage(6, "done");
  det(6, "проверено карточек " + f.stats.total + " · прошло " + f.stats.kept + " · скрыто с причинами " + f.stats.hidden +
    (state.usedFallback ? " · непроверенных ссылок (фолбэк): " + resultOffers.length : ""));

  renderResults(resultOffers, f);
}

// базовая годность карточки до оценки релевантности — те же правила, что в
// FC.checkOffer, но без требования цены (веб-ссылка без цены получает −1 балл,
// а не исчезает) и без правила аксессуара (оно в планировщике и не действует
// для запросов про сам аксессуар)
function baseInvalid(o){
  if (!o.title || !o.url) return "неполная карточка: нет ссылки";
  if (o.available === false) return "нет в наличии";
  var tags = (o.tags || []).join(" ");
  for (var i = 0; i < FC.JUNK.length; i++)
    if (FC.JUNK[i].re.test(o.title) || FC.JUNK[i].re.test(tags)) return FC.JUNK[i].reason;
  return "";
}
function baseFlags(o){
  var flags = [];
  if (FC.REFLAG.test(o.title) || FC.REFLAG.test((o.tags || []).join(" ")))
    flags.push("восстановленный/б-у — обычно дешевле, проверьте состояние");
  if (String(o.title).split(/\s+/).length > 12)
    flags.push("SEO-название (рекламная простыня) — сверили содержимое с запросом, оно совпадает");
  return flags;
}

// ---- рендер итогов -------------------------------------------------------------
// домен-источник в одну строку
function hostShort(u){
  var m = /^https?:\/\/([^\/"']+)/.exec(String(u || ""));
  return m ? m[1].replace(/^www\./, "") : String(u || "");
}

// в названии есть и бренд, и модель из плана (модель — слитно, через дефис или
// с пробелом: «al pro», «AL-Pro», «ALPRO»)
function brandModelIn(e, title){
  if (!e || !e.brand || !e.model || !title) return false;
  var t = FC.normText(title);
  var only = function(s){ return String(s || "").toLowerCase().replace(/[^a-zа-яё0-9]/g, ""); };
  return (" " + t + " ").indexOf(" " + e.brand + " ") >= 0 &&
         only(t).indexOf(only(e.model)) >= 0;
}

function renderResults(offers, f){
  var out = $("out");
  out.innerHTML = "";
  var statsEl = $("stats");
  statsEl.innerHTML = "";
  var hid = $("hid");
  if (hid) hid.innerHTML = "";

  if (!offers.length){
    // пусто: считаем, по каким причинам фильтр всё спрятал, и говорим это прямо
    var reasons = {};
    (f.hidden || []).forEach(function(h){ reasons[h.reason] = (reasons[h.reason] || 0) + 1; });
    var why = Object.keys(reasons).sort(function(a, b){ return reasons[b] - reasons[a]; }).slice(0, 5).map(function(r){
      return reasons[r] > 1 ? r + " — " + reasons[r] : r;
    }).join("; ");
    out.innerHTML = "<div class='fatal'>ничего не нашлось" +
      (why ? ". Почему: " + esc(why) : ". Открой источники кнопками в разделе «технические детали» и нажми там закладку «📨 в фильтр»") +
      (state.stepOffered != null ? ". В строке статуса — кнопка смягчить запрос" : "") + "</div>";
    renderHidden(f.hidden || []);
    state.lastFilter = { main: [], similar: [], hidden: packHidden(f.hidden || []), step: state.ladderStep };
    renderStatus();
    updatePanelSummary();
    return;
  }

  // ecatalog-стиль: один товар — одна строка. Слева название (самое полное из
  // источников), справа — список источников с ценами; один и тот же товар из
  // разных выдач и магазинов склеивается в одну строку по значимым словам.
  var groups = {}, order = [];
  // ключ склейки: для запроса «бренд + модель» — сама модель (все магазины и
  // модификации одной модели в одной карточке: «SAVA A7L Carbon 27.5» и
  // «Велосипед SAVA A7L 700C» раньше расползались на две строки); иначе —
  // значимые слова названия минус слова запроса («велосипед детский»): разные
  // товары не склеиваются, а разные магазины одного товара склеиваются
  var pe = state.plan ? state.plan.entities : null, drop = [];
  if (pe){
    if (pe.brand) drop.push(pe.brand);
    if (pe.model) drop = drop.concat(pe.model.split(" "));
    if (pe.category) drop.push(pe.category);
    if (pe.categoryRu) drop.push(pe.categoryRu);
    pe.modifiers.forEach(function(m){ if (m.ru) drop.push(m.ru); if (m.en) drop.push(m.en); });
    drop = drop.map(function(w){ return FC.normText(w); }).filter(Boolean);
  }
  function productKey(o){
    var t = FC.normText(o.title);
    if (pe && brandModelIn(pe, t)) return "bm:" + pe.brand + " " + pe.model;
    var toks = FC.significantTerms(t);
    var rest = toks.filter(function(x){
      return !drop.some(function(d){
        if (x === d || (d.length >= 4 && x.indexOf(d) === 0)) return true;
        var n = Math.min(x.length, d.length) - 2;   // «детские» / «детский»
        return n >= 4 && x.slice(0, n) === d.slice(0, n);
      });
    });
    return (rest.length ? rest.slice(0, 3).join(" ") : "") || toks.slice(0, 3).join(" ") ||
           String(o.title || "").toLowerCase().slice(0, 80);
  }
  offers.forEach(function(o){
    var key = productKey(o);
    if (!groups[key]){ groups[key] = { title: o.title, flags: [], srcs: [] }; order.push(groups[key]); }
    var g = groups[key];
    if ((o.title || "").length > g.title.length) g.title = o.title;
    if (!g.img && (o.image || o.img)) g.img = o.image || o.img;   // v14: картинка товара из выдачи
    g.srcs.push(o);
    (o.flags || []).forEach(function(fl){ if (g.flags.indexOf(fl) < 0) g.flags.push(fl); });
  });
  // вердикт кластера — лучшее из его предложений (planner.js): основная или
  // похожая. Впереди основные, внутри — по доле набранных баллов, при равенстве
  // — с ценой, с бо́льшим числом источников, дешевле
  var hasPrice = function(g){ return g.srcs.some(function(x){ return x.price; }); };
  var minPrice = function(g){ return Math.min.apply(null, g.srcs.map(function(x){ return x.price || Infinity; })); };
  order.forEach(function(g){
    var best = g.srcs[0];
    g.srcs.forEach(function(o){ if (o.max && (!best.max || o.score / o.max > best.score / best.max)) best = o; });
    g.best = best; g.verdict = best.verdict || "similar"; g.reason = best.reason || "";
    g.why = best.why || []; g.score = best.score || 0; g.max = best.max || 1;
    g.ratio = g.score / g.max;
    g.url = best.url; g.price = best.price || null; g.currency = best.currency || null;
  });
  order.sort(function(a, b){
    var va = a.verdict === "main" ? 2 : 1, vb = b.verdict === "main" ? 2 : 1;
    if (va !== vb) return vb - va;
    if (b.ratio !== a.ratio) return b.ratio - a.ratio;
    var ha = hasPrice(a) ? 1 : 0, hb = hasPrice(b) ? 1 : 0;
    if (hb !== ha) return hb - ha;
    if (b.srcs.length !== a.srcs.length) return b.srcs.length - a.srcs.length;
    return minPrice(a) - minPrice(b);
  });
  var mainCards = order.filter(function(g){ return g.verdict === "main"; });
  var restCards = order.filter(function(g){ return g.verdict !== "main"; });

  var medLine = document.createElement("div");
  medLine.className = "stats";
  var meds = Object.keys(f.medians || {}).map(function(cur){
    return "<span class='b ok'>медиана " + cur + ": " + fmtPrice(f.medians[cur], cur) + "</span>";
  });
  medLine.innerHTML = meds.join(" ") +
    "<span class='b'>товаров: " + order.length + "</span>" +
    "<span class='b'>предложений: " + offers.length + "</span>" +
    "<span class='b'>основных: " + mainCards.length + "</span>" +
    "<span class='b'>похожих: " + restCards.length + "</span>" +
    "<span class='b'>скрыто: " + (f.hidden || []).length + "</span>" +
    (state.usedFallback ? "<span class='b warn'>непроверенные ссылки (фолбэк)</span>" : "");
  statsEl.appendChild(medLine);

  function ecCardEl(g){
    var c = document.createElement("div");
    c.className = "card ec " + (g.verdict === "main" ? "main" : "similar");
    // почему карточка здесь: набранные баллы — у основной, причина — у похожей
    c.title = g.verdict === "main" ? ("почему основная: " + (g.why.join(", ") || "совпадение с запросом")) :
                                     ("похожая: " + (g.reason || "неполное совпадение с запросом"));
    var srcs = g.srcs.map(function(o){
      var approx = o.priceVia === "snippet" ? "≈" : "";
      var tag = o.priceVia === "market" ? "<span class='ec-tag'>маркетплейс</span>" :
                o.priceVia === "snippet" ? "<span class='ec-tag dim'>≈ из выдачи</span>" : "";
      return "<a class='ec-src' href='" + esc(o.url) + "' target='_blank' rel='noopener noreferrer' title='" +
        esc(String(o.title || "").slice(0, 140)) + "'>" +
        "<span class='ec-shop'>" + esc(hostShort(o.url)) + "</span>" +
        (o.price ? "<span class='ec-price price'>" + approx + " " + esc(fmtPrice(o.price, o.currency)) + "</span>" : "<span class='ec-price price dim'>—</span>") +
        tag + "</a>";
    }).join("");
    var verified = g.srcs.some(function(x){ return x.verified; });
    // картинка товара (из выдачи), если не загрузилась — плейсхолдер с буквой
    var th = g.img
      ? "<img class='ec-th' src='" + esc(g.img) + "' alt='' loading='lazy'>"
      : "<div class='ec-th ph'>" + esc((g.title || "?").charAt(0).toUpperCase()) + "</div>";
    var whyLine = g.verdict !== "main"
      ? "<div class='why'>" + esc(g.reason || "похожая: неполное совпадение с запросом") + "</div>" : "";
    c.innerHTML =
      th +
      "<div class='ec-name'>" +
        "<a class='t' href='" + esc(g.url) + "' target='_blank' rel='noopener noreferrer'>" + esc(g.title) + "</a>" +
        whyLine +
        "<div class='ec-meta'>" + (verified ? "проверенная карточка товара · " : "") + "источников: " + g.srcs.length +
          (state.usedFallback ? " · фолбэк" : "") + "</div>" +
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
    d.innerHTML = "<summary>похожие на запрос: " + restCards.length + " (свёрнуто)</summary>";
    restCards.forEach(function(g){ d.appendChild(ecCardEl(g)); });
    out.appendChild(d);
  }

  renderHidden(f.hidden || []);
  state.lastFilter = { main: mainCards, similar: restCards, hidden: packHidden(f.hidden || []), step: state.ladderStep };
  renderStatus();
  updatePanelSummary();
}

// скрытые карточки с причина́ми — списком в технической панели и в отчёте этапа 0
function packHidden(list){
  return (list || []).map(function(h){
    var o = h.offer || h;
    return { title: o.title || "", url: o.url || "", reason: h.reason || o.reason || "",
             why: o.why || [], score: o.score, max: o.max, price: o.price || null, currency: o.currency || null };
  });
}
function renderHidden(list){
  var hb = $("hidbox");
  if (!hb) return;
  if (!list.length){ hb.hidden = true; return; }
  hb.hidden = false;
  $("hidsum").textContent = "скрыто: " + list.length + " (с причина́ми)";
  $("hid").innerHTML = list.map(function(h){
    var o = h.offer || h;
    return "<div class='hid'><div class='r'>✗ " + esc(h.reason || o.reason || "") + "</div>" +
      "<a href='" + esc(o.url) + "' target='_blank' rel='noopener noreferrer'>" +
      esc(String(o.title || "").slice(0, 90)) + "</a></div>";
  }).join("");
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
  state.query = q; state.finalized = false; state.searching = true;
  state.tabsOpened = false; state.passForced = false; state.stepOffered = null;
  state.lastFilter = null; state.note = "";

  buildStages();
  ensureQuery(false);
  // этап 1: источники — из плана (3–4 по намерению); без плана — прежний список
  state.queue = state.plan ? state.plan.sources.slice() : TAB_ENGINES.concat(EXTRA_ENGINES);
  $("out").innerHTML = ""; $("hidbox").hidden = true; $("stats").innerHTML = "";
  renderAiCards();

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
    // расширение: поисковики плана под капотом с куками пользователя, вкладки
    // не нужны; площадки мост не фетчит — они остаются кнопками «вкладкой»
    planSerpSources().forEach(function(id){ if (!bridgeTried[id]) bridgeFetchEngine(id); });
    state.queue.forEach(function(id){
      if (MARKET_IDS.indexOf(id) >= 0) state.autos[id] = { state: "err", msg: "площадка — только вкладкой", blocked: true };
    });
    courier("мост активен: поисковики идут под капотом с твоими куками, окна не открываются");
    addLog("ищу «" + esc(q) + "»: поисковики под капотом (расширение), магазины напрямую");
  } else {
    // окна источников из плана каскадом (друг под другом), последним —
    // окно-анимация: оно перекрывает всю стопку и показывает живой прогресс
    var opened = 0, failed = [];
    state.queue.forEach(function(id, i){
      if (openSearchWindow(id, i)) opened++; else failed.push(engineName(id));
    });
    state.tabsOpened = opened > 0;
    var workerOk = opened > 0 && openWorkerWindow(q);
    if (!opened){
      courier("браузер заблокировал окна поиска — разреши всплывающие окна для этого сайта (значок в адресной строке) и нажми «искать» ещё раз, либо открой источники кнопками в «технических деталях»");
      addLog("окна заблокированы браузером", "warn");
    } else {
      courier("открыл <b>" + opened + "</b> окон: " + esc(state.queue.map(engineName).join(", ")) +
        ". Со скриптом окна отчитываются сами и закрываются; без него — один клик по закладке «📨 в фильтр» в каждом" +
        (failed.length ? ". Не открылись: " + esc(failed.join(", ")) + " — кнопки в «технических деталях»" : ""));
      addLog("ищу «" + esc(q) + "» (" + (state.plan ? state.plan.intentRu : "без плана") + "): открыл " + opened +
        " окон: " + state.queue.map(engineName).join(", ") + (workerOk ? " + окно поиска" : "") +
        (failed.length ? "; не открылись: " + failed.join(", ") : ""));
    }
    var bo = $("bridgeOff");
    if (bo) bo.hidden = false;
  }
  renderStatus();
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
  courier("итог собран из " + srcs + " поисковика(ов); поздние окна пересчитают его сами. Цены с площадок — кнопки в «технических деталях»");
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
    maybeStepDown();
  };
  if (state.shopsPromise) state.shopsPromise.then(build, build);
  else build();
}

// ---- лестница ослабления (P14) -------------------------------------------------
// Шаг вниз — только когда все источники текущего прохода отчитались (или итог
// собран кнопкой «готово») и основных карточек меньше трёх. С расширением
// поисковики переспрашиваются сами; с окнами — кнопка в строке статуса:
// браузер не даёт открыть окно без клика пользователя
function maybeStepDown(){
  var p = state.plan, lf = state.lastFilter;
  if (!p || !FP || !lf || !state.finalized) return;
  var last = Math.min(p.ladder.ru.length, p.ladder.en.length) - 1;
  if (state.ladderStep >= last || state.stepOffered != null) return;
  // «мало основных» — по предложениям с ценой, а не по карточкам: для запроса
  // «бренд + модель» одна карточка с пятью магазинами — норма, а не повод
  // смягчать запрос (по карточкам она считалась одной и лестница срабатывала)
  var mainPriced = 0;
  lf.main.forEach(function(g){ (g.srcs || []).forEach(function(o){ if (o.price > 0) mainPriced++; }); });
  if (mainPriced >= 3) return;
  if (!state.passForced && !passSettled()) return;
  var next = state.ladderStep + 1;
  var line = "шаг " + (next + 1) + " из " + (last + 1) + " — " + p.ladder.ru[next].name + ": «" + p.ladder.ru[next].q + "»";
  var whyFew = "основных предложений с ценой меньше трёх (" + mainPriced + ")";
  if (state.bridge.ready && planSerpSources().length){
    state.ladderStep = next; state.passForced = false;
    state.finalized = false; state.searching = true;
    addLog(whyFew + " — лестница ослабления, " + line, "warn");
    detLine(6, "<span class='warn'>• лестница ослабления (" + whyFew + "): " + esc(line) + "</span>");
    renderPlan();
    for (var k in bridgeTried) delete bridgeTried[k];
    planSerpSources().forEach(function(id){ bridgeFetchEngine(id); });
    renderChips();
    renderStatus();
  } else {
    state.stepOffered = next;
    addLog(whyFew + " — предлагаю лестницу ослабления, " + line, "warn");
    detLine(6, "<span class='warn'>• лестница ослабления (" + whyFew + "): " + esc(line) + " — кнопка в строке статуса</span>");
    renderStatus();
  }
}
function openLadderStep(){
  var p = state.plan;
  if (!p || state.stepOffered == null) return;
  state.ladderStep = state.stepOffered; state.stepOffered = null; state.passForced = false;
  var st = p.ladder.ru[state.ladderStep];
  var line = "шаг " + (state.ladderStep + 1) + " из " + p.ladder.ru.length + " — " + st.name + ": «" + st.q + "»";
  addLog("лестница ослабления, " + line);
  detLine(6, "• лестница ослабления: " + esc(line));
  renderPlan();
  var opened = 0, failed = [];
  planSerpSources().forEach(function(id, i){
    if (openSearchWindow(id, state.openedIds.length + i)) opened++; else failed.push(engineName(id));
  });
  courier("смягчил запрос (" + st.name + "): открыл " + opened + " окон — " +
    esc(planSerpSources().map(engineName).join(", ")) + (failed.length ? "; не открылись: " + esc(failed.join(", ")) : ""));
  renderChips();
  renderStatus();
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
  state.finalized = true; state.searching = false; state.note = "";
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
  state = { query: "", translated: null, plan: null, ladderStep: 0, stepOffered: null,
            passForced: false, lastFilter: null, note: "",
            pages: [], aiAnswers: [], shopReports: [], shopOffers: [], shopsPromise: null,
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
  ["planBox", "aiBox"].forEach(function(id){ var b = $(id); if (b){ b.innerHTML = ""; b.hidden = true; } });
  var tech = $("tech"); if (tech) tech.open = false;
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
  state.passForced = true;   // итог собран до отчётов всех источников прохода
  finishSearch();
});
$("grabClip").addEventListener("click", grabClipboard);
(function(){ var g2 = $("grabClip2"); if (g2) g2.addEventListener("click", grabClipboard); })();
(function(){ var dr = $("dlReport"); if (dr) dr.addEventListener("click", buildReport); })();
// кнопки внутри строки статуса (шаг лестницы, настройка) — делегированием
$("courier").addEventListener("click", function(e){
  var t = e.target;
  var b = t && t.closest ? t.closest("button[data-act]") : null;
  if (!b) return;
  var act = b.getAttribute("data-act");
  if (act === "step") openLadderStep();
  else if (act === "setup") openSetup();
});
// этап 0: контрольный запрос — подставить и искать; диалект — отметка о проверке
(function(){
  var ctl = $("ctl");
  if (ctl) ctl.addEventListener("click", function(e){
    var t = e.target;
    var b = t && t.closest ? t.closest("button[data-q]") : null;
    if (!b) return;
    $("q").value = b.getAttribute("data-q");
    try { window.scrollTo(0, 0); } catch(err){}
    startSearch();
  });
  var dia = $("dialect");
  if (dia) dia.addEventListener("click", function(e){
    var t = e.target;
    var b = t && t.closest ? t.closest("button[data-mark]") : null;
    if (!b) return;
    markDialect(b.getAttribute("data-mark"), b.getAttribute("data-ok") === "1");
  });
})();
$("q").addEventListener("keydown", function(e){ if (e.key === "Enter"){ e.preventDefault(); startSearch(); } });
$("reset").addEventListener("click", resetAll);
$("expJson").addEventListener("click", exportJson);
$("expCsv").addEventListener("click", exportCsv);
$("q").addEventListener("input", function(){
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(runSuggest, 450);
});
$("q").addEventListener("blur", function(){ setTimeout(function(){ $("sugg").hidden = true; }, 200); });
renderControl();
renderDialectMarks();
renderDialectLinks();
renderStatus();   // на первом визите — единственная подсказка: как передать выдачу
// номер версии из метки (проставляет сборщик из version.json) — в заголовке панели
(function(){ var tv = $("techVer"), v = appVersion(); if (tv && v) tv.textContent = "v" + v + " "; })();
window.__fsDebug = makeDebugHook();   // отладочный хук доступен и до первой выдачи
updatePasteHint();

function updatePasteHint(){
  var n = state.pages.filter(function(p){ return p.via !== "auto"; }).length;
  $("pasteHint").innerHTML = n === 0
    ? "выдачу можно и просто вставить сюда (<kbd>Ctrl+V</kbd> HTML или JSON от букмарклета) или перетащить файл"
    : "принесено страниц: <b>" + n + "</b>" + (serpCount() < 2 ? " — добавь ещё одно окно для перекрёстных подтверждений" : " — подтверждения между выдачами уже считаются");
}
})();
