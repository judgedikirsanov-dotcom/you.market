// ==UserScript==
// @name         Честный фильтр выдачи — скрипт-мост (Firefox/Chrome, тихий)
// @namespace    fs-bridge
// @version      3.1.0
// @description  Авто-режим ТОЛЬКО для вкладок, открытых сайтом агрегатора (маркер &fsx=1 в адресе или наш referrer): вкладка парсит выдачу (включая ИИ-ответ: Google AI Overview, Яндекс Нейро, Bing Copilot, Brave AI и цены маркетплейсов), отдаёт её агрегатору через страницу-релей и — во «Шаттле» — сама идёт к следующему источнику. Твои обычные поиски из адресной строки скрипт НЕ трогает — на чужих вкладках лишь маленькая кнопка «📨 в фильтр» и Alt+S для добровольной отправки. Расширение не нужно.
// @author       filter-search
// @match        https://www.google.com/search*
// @match        https://www.google.*/search*
// @match        https://yandex.ru/search*
// @match        https://yandex.*/search/*
// @match        https://www.bing.com/search*
// @match        https://duckduckgo.com/?q=*
// @match        https://duckduckgo.com/html/?q=*
// @match        https://lite.duckduckgo.com/lite/?q=*
// @match        https://search.brave.com/search?q=*
// @match        https://www.mojeek.com/search?q=*
// @match        https://marginalia-search.com/search*
// @match        https://www.ozon.ru/search/*
// @match        https://www.avito.ru/all*
// @match        https://aliexpress.ru/wholesale*
// @match        https://judgedikirsanov-dotcom.github.io/you.market/*
// @run-at       document-idle
// @noframes
// @grant        none
// @require      https://judgedikirsanov-dotcom.github.io/you.market/bridge-lib.js?v=3.1.0
// @require      https://judgedikirsanov-dotcom.github.io/you.market/core.js?v=3.1.0
// @updateURL    https://judgedikirsanov-dotcom.github.io/you.market/filter-search.user.js
// @downloadURL  https://judgedikirsanov-dotcom.github.io/you.market/filter-search.user.js
// ==/UserScript==
//
// Установка/ОБНОВЛЕНИЕ: Violentmonkey (Firefox) или Tampermonkey (Chrome) →
// открыть https://judgedikirsanov-dotcom.github.io/you.market/filter-search.user.js
// → «установить» (старая версия обновится по @version). Обновления скрипт берёт
// с сайта (публикуется из main) — страница и скрипт всегда одной версии.
//
// ЧЕМ v2.3 ОТЛИЧАЕТСЯ: v2.1/v2.2 авто-отчитывались с ЛЮБОЙ вкладки поисковика —
// обычный поиск пользователя из адресной строки улетал на сайт агрегатора
// (вкладка-почтальон навигировала выдачу на наш #fsRelay). Violentmonkey не
// умеет отличать окно, открытое сайтом, от ручного поиска — различение
// переехало В САМ скрипт: сайт ставит маркер &fsx=1 в URL своих вкладок; у
// ручного поиска маркера нет, а referrer не наш. Теперь:
//   • наша вкладка (маркер/referrer) → авто-отчёт через релей; во «Шаттле»
//     релей ведёт вкладку к следующему источнику, обычное окно — закрывает;
//   • чужая вкладка → полная тишина, кроме крошечной кнопки «📨 в фильтр»
//     в углу (и Alt+S): нажал — выдача ушла на вкладку агрегатора.
(function(){
"use strict";
var FB = (typeof FSBridge !== "undefined") ? FSBridge : (window.FSBridge || null);
if (!FB || typeof FB.collect !== "function") return;

var SITE_ORIGIN = "https://judgedikirsanov-dotcom.github.io/you.market";
// на странице самого сайта скрипт только объявляет себя: страница узнаёт, что
// клики по закладке не нужны (для «Шаттла» — «выдачи уйдут сами»)
if (String(location.origin) === SITE_ORIGIN){
  try {
    var ver = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "";
    window.postMessage({ fsUserjs: String(ver) }, location.origin);
  } catch(e){}
  return;
}

var src = FB.detectSrcFromHost(location.host);
if (!src) return;

// запрос есть только на страницах ПОИСКА (у поисковиков — всегда в адресе, у
// маркетплейсов — только на странице поиска, не на карточках товара)
var autoQuery = FB.detectQueryFromSearch(location.search);

// «наше» ли это окно? Два признака, достаточно любого:
//  1) сайт открыл вкладку с маркером &fsx=1 в адресе (ставит агрегатор);
//  2) document.referrer — наш сайт (window.open и страница-релей передают
//     referrer, а SPA, переписывая адрес, referrer не трогают).
// Ручной поиск из адресной строки/закладки/сабмита формы: маркера нет,
// referrer пустой или внутренний — значит, вкладка пользователя, не трогаем.
function isOurWindow(){
  try {
    if (/[?&]fsx=1/.test(location.search)) return true;
    if (document.referrer && String(document.referrer).indexOf(SITE_ORIGIN) === 0) return true;
  } catch(e){}
  return false;
}

function buildPayloadNow(){
  var c = FB.collect();
  if (c && c.q === "") c.q = autoQuery;
  return FB.buildPayload(c);
}

// универсальный «вкладка-почтальон»: Google/Яндекс/Bing рвут opener через COOP,
// зато навигация на наш сайт с данными в адресе (#fsRelay) всегда разрешена —
// страница-релей на нашем origin передаст payload агрегатору. Для вкладки
// «Шаттла» (маркер &fsh=1 в адресе источника) маркер уходит и в адрес релея.
// Адрес релея ограничен движком (см. bridge-lib.js relayHash): страница
// целиком, не влезшая в адрес, режется с пометкой htmlCut.
var RELAY_URL = SITE_ORIGIN + "/";
function relayNavigate(){
  var shuttle = /[?&]fsh=1(?=&|#|$)/.test(location.search);
  location.replace(RELAY_URL + FB.relayHash(buildPayloadNow(), shuttle).hash);
}
function sendViaOpener(){
  try {
    if (window.opener && window.opener !== window && !window.opener.closed){
      window.opener.postMessage(buildPayloadNow(), "*");
      return true;
    }
  } catch(e){}
  return false;
}

function toast(text){
  try {
    var t = document.createElement("div");
    t.textContent = text;
    t.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);" +
      "background:#181d24;color:#4fbf7c;border:1px solid #4fbf7c;border-radius:10px;" +
      "padding:10px 16px;font:14px/1.4 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;" +
      "z-index:2147483647;box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:90vw";
    document.body.appendChild(t);
    setTimeout(function(){ t.remove(); }, 3200);
  } catch(e){}
}

// добровольная отправка с чужой вкладки: opener жив — postMessage (вкладка
// остаётся на месте); opener разорван COOP — навигация-релей (пользователь сам
// нажал кнопку, значит согласен уйти с выдачи — релей скажет «✓ передано»)
function sendNow(){
  if (sendViaOpener()){
    toast("✓ выдача отправлена на вкладку «честный поиск товаров»");
  } else {
    relayNavigate();
  }
}

// ---- тихий режим на чужих вкладках: кнопка «📨 в фильтр» + Alt+S -------------
function mountManualButton(){
  try {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "📨 в фильтр";
    b.title = "Отправить эту выдачу на страницу «честный поиск товаров» (Alt+S)";
    b.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483646;" +
      "background:#181d24;color:#57b3e0;border:1px solid #2a313b;border-radius:99px;" +
      "padding:7px 14px;font:13px/1 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;" +
      "cursor:pointer;opacity:.82;box-shadow:0 4px 16px rgba(0,0,0,.35)";
    b.addEventListener("click", sendNow);
    document.body.appendChild(b);
  } catch(e){}
}
document.addEventListener("keydown", function(e){
  if (e.altKey && (e.key === "s" || e.key === "S" || e.key === "ы" || e.key === "Ы")){
    e.preventDefault();
    sendNow();
  }
}, true);

// ---- РАЗВИЛКА ----------------------------------------------------------------
// v2.4: расширение-мост помечает «свою» вкладку флагом fsExtSerp — отчёт и
// закрытие делает оно, скрипт молчит (иначе один отчёт уходил дважды: и
// расширение, и скрипт — отсюда дубли «Ozon: 3 результатов» ×2 в логе).
if (document.documentElement.dataset.fsExtSerp === "1") return;
if (isOurWindow()){
  // наше окно: авто-отчёт через релей. Запрос обычно есть в адресе рядом
  // с fsx=1; если SPA переписал адрес и потерял и маркер, и запрос
  // (AliExpress: /wholesale/…?SearchText=…), но выдача распознана — всё равно
  // отчитываемся: окно не должно висеть и ждать ручного клика (в v2.3 оно
  // молчало — отсюда «AliExpress открылся, но не закрыл окно»).
  // Всегда через релей, без быстрого пути opener→close: вкладка «Шаттла»
  // обязана дойти до релея, чтобы он повёл её к следующему источнику, а
  // закрывание после первого отчёта обрывало бы очередь.
  var c0 = FB.collect();
  var hasItems = c0 && c0.items && c0.items.length > 0;
  if (autoQuery || hasItems){
    setTimeout(function(){ relayNavigate(); }, 1800);
    return;
  }
  mountManualButton();   // наша вкладка, распознавать нечего — только кнопка
  return;
}

// чужая вкладка пользователя: НИКАКОГО авто-режима и навигаций. Только
// добровольная кнопка в углу (замена букмарклета) и Alt+S.
mountManualButton();
return;
})();
