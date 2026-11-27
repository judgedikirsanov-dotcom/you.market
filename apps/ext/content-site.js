// content-site.js — на странице агрегатора: мост «страница ↔ расширение».
// 1) пингует расширение (страница включает режим extMode);
// 2) пересылает запросы открытия вкладок (fsExtOpen) в фон;
// 3) принимает от фона payload'ы выдач (fsExtPayload) и вливает их на
//    страницу обычным postMessage — acceptBridgePayload уже слушает.
(function(){
"use strict";
var api = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
if (!api || !api.runtime) return;

// страница узнаёт, что расширение есть (app.js включает режим расширения)
try { window.postMessage({ fsExtReady: 1 }, window.location.origin); } catch(e){}

api.runtime.sendMessage({ fsExtPing: 1 }).then(function(){
  try { window.postMessage({ fsExtReady: 1 }, window.location.origin); } catch(e){}
}).catch(function(){ /* расширение не отвечает — страница живёт без него */ });

window.addEventListener("message", function(ev){
  if (ev.origin !== window.location.origin) return;
  var m = ev.data;
  if (!m || typeof m !== "object") return;
  if (m.fsExtOpen){
    api.runtime.sendMessage({ fsExtOpen: m.fsExtOpen })
      .then(function(resp){
        try { window.postMessage({ fsExtOpened: resp || { ok: false } }, window.location.origin); } catch(e){}
      })
      .catch(function(err){
        try { window.postMessage({ fsExtOpened: { ok: false, error: String(err && err.message || err) } },
          window.location.origin); } catch(e){}
      });
  }
});

api.runtime.onMessage.addListener(function(msg){
  if (msg && msg.fsExtPayload){
    try { window.postMessage(msg.fsExtPayload, window.location.origin); } catch(e){}
  }
});
})();
