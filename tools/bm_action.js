// Действие букмарклета: работает ПОСЛЕ inline bridge-lib.js (window.FSBridge готов).
// Клик на закладке «📨 в фильтр товаров» на странице выдачи:
//   1) парсим выдачу + ИИ-ответ прямо в контексте страницы (наши парсеры);
//   2) если вкладку открыл наш сайт и связь не разорвана (opener жив) —
//      window.opener.postMessage и window.close();
//   3) иначе (Google/Яндекс/Bing рвут opener через COOP) — универсальный
//      «вкладка-почтальон»: навигируем вкладку на сайт агрегатора с данными
//      в адресе (#fsRelay=…); страница-релей на нашем origin передаёт payload
//      агрегатору через BroadcastChannel и закрывается сама. COOP этому не
//      мешает: запрет касается связи с чужим origin, а не навигации.
(function(){
  var FB = (typeof FSBridge !== "undefined") ? FSBridge : (window && window.FSBridge);
  if (!FB || typeof FB.collect !== "function"){ alert("мост не собрался — переустанови закладку"); return; }
  if (!FB.detectSrcFromHost(location.host)){
    alert("это не страница выдачи поисковика — открой Google / Яндекс / Bing / DDG / Brave с результатами поиска");
    return;
  }
  var c = FB.collect();
  if (!c.items.length && !c.ai){
    alert("выдача не распознана (вёрстка изменилась или это страница-заглушка) — в фильтр уйдёт вся страница целиком, он разберёт сам");
  }
  var payload = FB.buildPayload(c);

  function b64url(s){
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // быстрая связь: агрегатор — наш opener
  var sentOpener = false;
  try {
    if (window.opener && window.opener !== window && !window.opener.closed){
      window.opener.postMessage(payload, "*");
      sentOpener = true;
    }
  } catch(e){}
  if (sentOpener){
    try { window.close(); } catch(e){}
    setTimeout(function(){
      try { window.close(); } catch(e){}
      alert("✓ отправлено в фильтр" + (c.items.length ? ": " + c.items.length + " результатов" : "") +
        (c.ai ? " + ИИ-ответ" : "") + ". Если вкладка не закрылась — закрой её, всё уже ушло.");
    }, 400);
    return;
  }

  // универсальный релей: вкладка возвращается на сайт с данными в адресе
  location.replace("https://judgedikirsanov-dotcom.github.io/you.market/#fsRelay=" + b64url(JSON.stringify(payload)));
})();
