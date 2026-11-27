// ============================================================================
// bg.js — фоновый скрипт расширения-моста (Chrome MV3 service_worker /
// Firefox MV3 event page; общий код, без веток по браузеру).
//
// Принцип: расширение знает СВОИ вкладки по tabId. Вкладки, открытые сайтом
// через fsExtOpen, попадают в ourTabs; отчёты приходят ТОЛЬКО от них, их же
// расширение закрывает. Вкладка ручного поиска пользователя не в ourTabs —
// content-serp на ней даже не собирает выдачу (сперва спрашивает fsIsOurs),
// а bg молча игнорирует любое её сообщение. Ничего «возвращать на сайт»
// невозможно by design.
// ============================================================================
var api = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
if (api){
  var siteTabs = new Set();   // живые вкладки сайта-агрегатора
  var ourTabs = new Map();    // tabId → { id: движок } — вкладки, открытые расширением

  api.runtime.onMessage.addListener(function(msg, sender, sendResponse){
    // сайт просит открыть вкладку выдачи (и запомнить её как «нашу»)
    if (msg && msg.fsExtOpen && sender && sender.tab){
      var req = msg.fsExtOpen;
      api.tabs.create({ url: req.url, active: !!req.active })
        .then(function(tab){
          ourTabs.set(tab.id, { id: String(req.id || "") });
          siteTabs.add(sender.tab.id);
          sendResponse({ ok: true, tabId: tab.id });
        })
        .catch(function(err){ sendResponse({ ok: false, error: String(err && err.message || err) }); });
      return true;   // асинхронный sendResponse
    }
    // контент-скрипт сайта пингует: расширение живо
    if (msg && msg.fsExtPing && sender && sender.tab){
      siteTabs.add(sender.tab.id);
      sendResponse({ ok: true });
      return true;
    }
    // выдача спрашивает: «моя вкладка — твоя?» Чужая — ответ «нет» и всё.
    if (msg && msg.fsIsOurs && sender && sender.tab){
      sendResponse({ ours: ourTabs.has(sender.tab.id) });
      return true;
    }
    // отчёт с выдачи: пересылаем на вкладки сайта и закрываем СВОЮ вкладку
    if (msg && msg.fsSerpPayload && sender && sender.tab){
      if (!ourTabs.has(sender.tab.id)) return;   // чужая вкладка — молча игнор
      siteTabs.forEach(function(t){
        try {
          var p = api.tabs.sendMessage(t, { fsExtPayload: msg.fsSerpPayload });
          if (p && p.catch) p.catch(function(){ siteTabs.delete(t); });
        } catch(e){ siteTabs.delete(t); }
      });
      ourTabs.delete(sender.tab.id);
      try { api.tabs.remove(sender.tab.id).catch(function(){}); } catch(e){}
      return;
    }
    return;
  });

  // умершие вкладки вычищаем из обоих списков
  api.tabs.onRemoved.addListener(function(tabId){
    ourTabs.delete(tabId);
    siteTabs.delete(tabId);
  });
}
