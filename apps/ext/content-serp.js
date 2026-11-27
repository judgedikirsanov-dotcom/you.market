// content-serp.js — на страницах выдач поисковиков и маркетплейсов.
// НЕ собирает ничего сам по себе: сперва спрашивает фон «вкладка моя?»
// (т.е. открыта ли она сайтом-агрегатором через расширение). На чужой
// вкладке — полная тишина: никаких чтений, сообщений и переходов.
(function(){
"use strict";
var api = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
if (!api || !api.runtime) return;
if (typeof FSBridge === "undefined" || !FSBridge.collect) return;

try {
  api.runtime.sendMessage({ fsIsOurs: 1 }).then(function(resp){
    if (!resp || !resp.ours) return;   // чужой поиск пользователя — молчим
    // помечаем вкладку: юзерскрипт v2.4 увидит флаг и не будет отчитываться
    // вторым (иначе дубли «Ozon: 3 результатов» ×2 в логе агрегатора)
    try { document.documentElement.dataset.fsExtSerp = "1"; } catch(e){}
    // наша вкладка: собираем выдачу тем же bridge-lib (ИИ-ответ + цены) и
    // шлём ВСЕГДА, даже 0 результатов: фон закроет вкладку после любого
    // отчёта — окно не должно зависать, если вёрстка не распозналась
    setTimeout(function(){
      try {
        var c = FSBridge.collect();
        if (!c || !c.src) return;
        var p = FSBridge.buildPayload(c);
        api.runtime.sendMessage({ fsSerpPayload: p });
      } catch(e){}
    }, 1500);
  }).catch(function(){ /* фона нет — молчим */ });
} catch(e){}
})();
