// ============================================================================
// bridge-lib.js — единая библиотека «скрипт-моста» честного поиска товаров.
//
// Работает в трёх ролях из ОДНОГО исходника (без расползания копий):
//   • на сайте агрегатора: window.FSBridge — приём/валидация payload'ов;
//   • в пользовательском скрипте (Violentmonkey/Tampermonkey): подключается
//     через @require — авто-отчёт вкладки + кнопка/Alt+S;
//   • в букмарклете: целиком инлайнится скриптом build_bookmarklet.js
//     (CSP страницы букмарклет не запрещает, но внешние <script src> — да,
//     поэтому код букмарклета самодостаточен).
//
// Философия: мы не конкуренты поисковикам, мы их продвинутые пользователи.
// Всё выполняется В БРАУЗЕРЕ ПОЛЬЗОВАТЕЛЯ от его лица: его IP, его куки,
// его вкладки. Никаких серверов и прокси. Выдача попадает на страницу
// агрегатора через window.opener.postMessage (единственный легальный мост
// между вкладками разных origin) или через буфер обмена пользователя.
//
// Payload: {fsBridge:1, v:2, src, q, ts, host, items:[{title,url,snippet}...],
//           ai:{src,text}|null, html?:строка (только если парсер не распознал)}
// ============================================================================
(function(root){
"use strict";

// ----------------------------------------------------------------------------
// базовый разбор HTML (логика 1:1 с core.js агрегатора)
// ----------------------------------------------------------------------------
function decodeEntities(s){
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function(_, h){ return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function(_, d){ return String.fromCharCode(+d); })
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function eachAnchor(html, cb){
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi, m;
  while ((m = re.exec(html))) cb(m[1], m[2]);
}
function attrGet(attrs, name){
  var m = new RegExp(name + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1", "i").exec(attrs);
  return m ? m[2] : "";
}
function stripTags(s){
  return decodeEntities(String(s || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function b64ToUtf8(b64){
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  var bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
function decodeDdgHref(h){
  h = String(h || "").trim();
  if (h.indexOf("//") === 0) h = "https:" + h;
  var m = /[?&]uddg=([^&]+)/.exec(h);
  if (m){ try { return decodeURIComponent(m[1]); } catch(e){ return m[1]; } }
  return h;
}
function hostOf(u){
  var m = /^https?:\/\/([^\/"']+)/.exec(String(u || ""));
  return m ? m[1] : "";
}
function unwrapYandex(u){
  u = decodeEntities(u);
  var m = u.match(/^https?:\/\/yandex\.[a-z.]+\/clck\/[^\s"']*?[?&](?:u|url)=([^&"']+)/i);
  if (!m) return u;
  var dec = m[1];
  try { dec = decodeURIComponent(dec); } catch(e){}
  if (/^https?:\/\//i.test(dec)) return dec;
  var b64 = dec.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  try {
    var url2 = b64ToUtf8(b64);
    if (/^https?:\/\//i.test(url2)) return url2;
  } catch(e){}
  return u;
}
function decodeBingCk(href){
  var m = /u=a1([A-Za-z0-9_-]+)/.exec(String(href || ""));
  if (!m) return href;
  try { return b64ToUtf8(m[1]); } catch(e){ return href; }
}

// ----------------------------------------------------------------------------
// парсеры выдач (DOM-aware: серверный HTML + отрендеренный DOM)
// ----------------------------------------------------------------------------
function parseGoogle(html, doc){
  var out = [], seen = {};
  var skip = /(^|\.)google\.[a-z.]+$|gstatic\.com|youtube\.com|blogger\.com|googleads/i;
  function push(url, title){
    if (!url || !title || seen[url]) return;
    if (skip.test(hostOf(url))) return;
    seen[url] = 1;
    out.push({ title: decodeEntities(title), url: url, snippet: "" });
  }
  var re = /<a[^>]*href="\/url\?q=(https?:\/\/[^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(html))) push(decodeEntities(m[1]), m[2].replace(/<[^>]+>/g, "").trim());
  if (out.length) return out;
  re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/g;
  while ((m = re.exec(html))) push(decodeEntities(m[1]), m[2].replace(/<[^>]+>/g, "").trim());
  if (out.length || !doc) return out;
  // живой DOM (Google дорисовывает выдачу скриптами)
  Array.prototype.forEach.call(doc.querySelectorAll("a h3"), function(h3){
    var a = h3.closest("a");
    if (a && a.href) push(a.href, h3.textContent.trim());
  });
  return out;
}

function parseYandex(html, doc){
  var out = [], seen = {};
  function push(url, title){
    if (!url || !title) return;
    var real = unwrapYandex(url);
    if (seen[real]) return;
    if (/^https?:\/\/(www\.)?(yandex\.[a-z.]+|ya\.ru)(\/|$)/i.test(real) &&
        real.indexOf("/clck/") < 0) return;
    seen[real] = 1;
    out.push({ title: title, url: real, snippet: "" });
  }
  var re = /<a[^>]*class="[^"]*organic[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(html))) push(m[1], m[2].replace(/<[^>]+>/g, "").trim());
  re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*organic[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = re.exec(html))) push(m[1], m[2].replace(/<[^>]+>/g, "").trim());
  if (out.length || !doc) return out;
  Array.prototype.forEach.call(doc.querySelectorAll(
    "a.OrganicTitle-Link, a.organic__url, .organic a.Link, .serp-item a.Link"), function(a){
    var t = (a.querySelector(".OrganicTitleContentSpan, .organic__url-text") || a).textContent.trim();
    push(a.href, t);
  });
  return out;
}

function parseBingHtml(html, doc){
  var out = [], seen = {};
  function push(url, title){
    if (!url || !title || seen[url]) return;
    if (/bing\.com\/(ck|aclick)/i.test(url)) url = decodeBingCk(url);
    if (!/^https?:\/\//i.test(url) || /bing\.com\/search/i.test(url)) return;
    seen[url] = 1;
    out.push({ title: title, url: url, snippet: "" });
  }
  var re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, m;
  while ((m = re.exec(html)))
    push(decodeEntities(m[1]), decodeEntities(stripTags(m[2])).replace(/\s+/g, " ").trim());
  if (out.length || !doc) return out;
  Array.prototype.forEach.call(doc.querySelectorAll("li.b_algo h2 a"), function(a){
    push(a.href, a.textContent.trim());
  });
  return out;
}

function parseDdg(html, doc){
  var titles = [], hrefs = [], snips = [], m;
  var reT = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reT.exec(html))) titles.push(m[1]);
  var reH = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href=("[^"]*"|'[^']*')[^>]*>/gi;
  while ((m = reH.exec(html))) hrefs.push(m[1].slice(1, -1));
  var reS = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reS.exec(html))) snips.push(m[1]);
  var out = [];
  for (var i = 0; i < titles.length; i++){
    var url = decodeDdgHref(hrefs[i] || "");
    var title = stripTags(titles[i]);
    if (url && title) out.push({ title: title, url: url,
      snippet: snips[i] !== undefined ? stripTags(snips[i]) : "" });
  }
  if (out.length || !doc) return out;
  Array.prototype.forEach.call(doc.querySelectorAll("a.result__a"), function(a){
    var t = a.textContent.trim();
    if (t) out.push({ title: t, url: a.href, snippet: "" });
  });
  return out;
}

var JUNK_HOST = /(^|\.)(duckduckgo\.com|brave\.com|bing\.com|google\.[a-z.]+|yandex\.[a-z.]+|ya\.ru|marginalia\.nu|mojeek\.com|github\.com|mozilla\.org|wikipedia\.org|accounts\.|support\.|help\.|policies\.|privacy\.|login\.|signin\.|settings|preferences|consent)/i;
var JUNK_TEXT = /^(назад|далее|ещё|more|next|previous|sign in|log in|register|settings|privacy|terms|about|help|support|feedback|careers|blog|home)\b/i;
function parseGeneric(html, selfHost){
  var out = [], seen = {};
  eachAnchor(html, function(attrs, text){
    if (out.length >= 25) return;
    var href = attrGet(attrs, "href");
    if (!/^https?:\/\//i.test(href)){
      if (href.indexOf("//") === 0) href = "https:" + href; else return;
    }
    var title = stripTags(text);
    if (title.length < 25 || JUNK_TEXT.test(title)) return;
    var host = hostOf(href).replace(/^www\./, "");
    if (!host || JUNK_HOST.test(host)) return;
    if (selfHost && host === selfHost) return;
    if (seen[href]) return;
    seen[href] = 1;
    out.push({ title: title, url: href, snippet: "" });
  });
  return out;
}

function parseBySrc(src, html, doc){
  if (src === "google") return parseGoogle(html, doc);
  if (src === "yandex") return parseYandex(html, doc);
  if (src === "bing") return parseBingHtml(html, doc);
  if (src === "ddg") return parseDdg(html, doc);
  if (src === "brave") return parseGeneric(html, "search.brave.com");
  if (src === "mojeek") return parseGeneric(html, "www.mojeek.com");
  if (src === "marginalia") return parseGeneric(html, "marginalia-search.com");
  // маркетплейсы: парсеры (JSON-LD Ozon, JSON-блоб Ali, data-marker Avito)
  // живут в core.js — юзерскрипт подключает его рядом через @require
  if (src === "ozon" || src === "avito" || src === "ali"){
    var FS = (typeof root !== "undefined" && root.FSCore) ||
             (typeof window !== "undefined" && window.FSCore) || null;
    if (FS && typeof FS.parseBySource === "function") return FS.parseBySource(src, html);
    return [];
  }
  return [];
}

// ----------------------------------------------------------------------------
// ИИ-ответы поисковиков: Google «AI Overview», Яндекс «Нейро», Bing «Copilot»,
// Brave «Answer with AI». Блоки ленивые и вёрстка меняется — работаем
// эвристиками и честно помечаем guess:true. ИИ-ответ — это сводка поисковика,
// НЕ предложение товара: на сайт идёт отдельным полем, в медиану не входит.
// ----------------------------------------------------------------------------
var AI_HEADINGS = {
  google: /^(ai overview|обзор с ии|обзор с помощью ии|обзор, созданный ии|ai-обзор)/i,
  yandex: /^(нейро|yandexgpt|ответ нейро)/i,
  bing:   /^(copilot|краткий ответ|копилот)/i,
  brave:  /^(answer with ai|ответ с ии|ai-ответ)/i
};
function aiFromHtmlRegex(src, html){
  // запасной путь для тестов и серверного HTML: заголовок → текст до ~1200 символов
  // (^ в AI_HEADINGS нужен для DOM-заголовков; в HTML заголовок в середине строки,
  // а группа делаем незахватывающей — иначе она съедает m[1])
  if (!AI_HEADINGS[src]) return null;
  var headSrc = AI_HEADINGS[src].source.replace(/^\^/, "").replace("(", "(?:");
  var re = new RegExp(headSrc +
    "[\\s\\S]{0,400}?(?:<p[^>]*>|<span[^>]*>|<div[^>]*>)([\\s\\S]{80,1200}?)</(?:p|span)>", "i");
  var m = re.exec(html);
  if (!m) return null;
  var text = stripTags(m[1]);
  return (text.length >= 60) ? text : null;
}
function aiFromDom(src, doc){
  if (!doc || !doc.querySelectorAll) return null;
  // 1) ищем заголовок блока ИИ по тексту
  var heads = doc.querySelectorAll("h1,h2,h3,h4,div[role='heading'],span[role='heading'],[class*='heading' i]");
  for (var i = 0; i < heads.length; i++){
    var t = (heads[i].textContent || "").trim();
    if (!t || t.length > 80) continue;
    if (!AI_HEADINGS[src] || !AI_HEADINGS[src].test(t)) continue;
    // 2) поднимаемся к контейнеру с содержательным текстом
    var el = heads[i];
    for (var up = 0; up < 5 && el; up++){
      el = el.parentElement;
      if (!el) break;
      var txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length >= 80 && txt.length <= 4000) return txt;
    }
  }
  // 3) класс-эвристики для известных блоков
  var sel = {
    google: "[class*='ai-overview' i],[data-rl],div[id*='aio']",
    yandex: "[class*='Neuro' i],[class*='neuro' i]",
    bing:   "[class*='copilot' i],.b_ans .b_promTxt",
    brave:  "[class*='answer' i][class*='ai' i],[data-type='answer']"
  }[src];
  if (sel){
    var els = doc.querySelectorAll(sel);
    for (var j = 0; j < els.length; j++){
      var txt2 = (els[j].innerText || els[j].textContent || "").replace(/\s+/g, " ").trim();
      if (txt2.length >= 80 && txt2.length <= 4000) return txt2;
    }
  }
  return null;
}
function extractAi(src, html, doc){
  var t = aiFromDom(src, doc);
  if (t) return { text: t, guess: false };
  var t2 = aiFromHtmlRegex(src, html);
  if (t2) return { text: t2, guess: true };
  return null;
}

// ----------------------------------------------------------------------------
// определение источника/запроса, сбор данных со страницы выдачи
// ----------------------------------------------------------------------------
var SRC_HOSTS = [
  [/(^|\.)google\.[a-z.]+$/i, "google"],
  [/(^|\.)yandex\.[a-z.]+$|(^|\.)ya\.ru$/i, "yandex"],
  [/(^|\.)bing\.com$/i, "bing"],
  [/(^|\.)duckduckgo\.com$/i, "ddg"],           // html./lite. — тоже DDG
  [/(^|\.)brave\.com$/i, "brave"],
  [/(^|\.)mojeek\.com$/i, "mojeek"],
  [/(^|\.)marginalia-search\.com$/i, "marginalia"],
  // маркетплейсы: скрипт-мост работает и на них — цены в рублях летят сами
  [/(^|\.)ozon\.ru$/i, "ozon"],
  [/(^|\.)avito\.ru$/i, "avito"],
  [/(^|\.)aliexpress\.ru$/i, "ali"]
];
function detectSrcFromHost(host){
  for (var i = 0; i < SRC_HOSTS.length; i++)
    if (SRC_HOSTS[i][0].test(String(host || ""))) return SRC_HOSTS[i][1];
  return null;
}
function detectQueryFromSearch(search){
  try {
    var sp = new URLSearchParams(String(search || ""));
    return sp.get("q") || sp.get("text") || sp.get("query") || "";
  } catch(e){ return ""; }
}
function collect(){
  var src = detectSrcFromHost(location.host);
  var q = detectQueryFromSearch(location.search);
  var html = document.documentElement.outerHTML;
  var items = src ? parseBySrc(src, html, document) : [];
  var ai = src ? extractAi(src, html, document) : null;
  return { src: src, q: q, items: items, ai: ai, html: html };
}
// цена из текста результата — логика 1:1 с core.js агрегатора (FS.priceFromText)
function priceFromText(title, snippet){
  var t = String(title || "") + " " + String(snippet || "");
  // число: «12 500», «1,499.00», «12990», «89,99» — но НЕ «24 12 500» из
  // «…A7L 24 12 500 ₽» (группы тысяч строго по 3 цифры после разделителя)
  var numRe = "\\d{1,3}(?:[\\s\\u00a0,]\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
  var m, num, cur;
  if ((m = new RegExp("(от\\s+)?(" + numRe + ")\\s*(?:₽|руб\\.?|rub|р\\.)(?![\\wа-яё])", "i").exec(t))){
    num = m[2]; cur = "RUB";
  } else if ((m = new RegExp("(от\\s+)?([$€])\\s*(" + numRe + ")").exec(t))){
    num = m[3]; cur = m[2] === "$" ? "USD" : "EUR";
  } else if ((m = new RegExp("(от\\s+)?(" + numRe + ")\\s*([$€])").exec(t))){
    num = m[2]; cur = m[3] === "$" ? "USD" : "EUR";
  } else return null;
  // разделители: «1,499.00» → 1499.00, «89,99» → 89.99, «12.990» → 12990 — 1:1 с core.js
  num = num.replace(/[\s\u00a0]/g, "");
  var parts = /^(.+?)([.,])(\d{1,2})$/.exec(num);
  if (parts) num = parts[1].replace(/[.,]/g, "") + "." + parts[3];
  else num = num.replace(/[.,]/g, "");
  var v = parseFloat(num);
  return (isFinite(v) && v > 0) ? { price: v, currency: cur } : null;
}
// честное происхождение цены: market — парсер площадки, snippet — из выдачи (≈)
var MARKET_IDS = { ozon: 1, avito: 1, ali: 1 };
function priceOfItem(it, src){
  if (it.price != null && isFinite(it.price))
    return { price: it.price, currency: it.currency || (MARKET_IDS[src] ? "RUB" : null),
             via: MARKET_IDS[src] ? "market" : null };
  var p = priceFromText(it.title, it.snippet);
  if (p) return { price: p.price, currency: p.currency, via: "snippet" };
  return { price: null, currency: null, via: null };
}
function buildPayload(c){
  var p = { fsBridge: 1, v: 2, src: c.src, q: c.q || "", ts: Date.now(),
            host: (typeof location !== "undefined" ? location.host : ""),
            items: (c.items || []).slice(0, 40).map(function(it){
              var pv = priceOfItem(it, c.src);
              return { title: String(it.title || "").slice(0, 300),
                       url: String(it.url || ""), snippet: String(it.snippet || "").slice(0, 300),
                       price: pv.price, currency: pv.currency, priceVia: pv.via,
                       sourceType: MARKET_IDS[c.src] ? "market" : "serp" };
            }),
            ai: c.ai ? { src: c.src, text: String(c.ai.text || "").slice(0, 4000), guess: !!c.ai.guess } : null };
  if (!p.items.length) p.html = String(c.html || "").slice(0, 1500000);
  return p;
}
// фолбэк-копирование в буфер (когда navigator.clipboard недоступен)
function legacyCopy(text){
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch(e){}
  ta.remove();
}

// ----------------------------------------------------------------------------
// приём на стороне агрегатора: валидация payload'а (сам парсинг делает app.js)
// ----------------------------------------------------------------------------
function validatePayload(p){
  return !!(p && p.fsBridge === 1 && p.src && detectSrcFromHostHostAlias(p.src) &&
            (Array.isArray(p.items) || typeof p.html === "string"));
}
function detectSrcFromHostHostAlias(src){
  // src в payload — id источника: 7 поисковиков или маркетплейс с ценами
  return /^(google|yandex|bing|ddg|brave|mojeek|marginalia|ozon|avito|ali)$/.test(String(src));
}

var api = {
  decodeEntities: decodeEntities, stripTags: stripTags, eachAnchor: eachAnchor,
  attrGet: attrGet, b64ToUtf8: b64ToUtf8, decodeDdgHref: decodeDdgHref,
  hostOf: hostOf, unwrapYandex: unwrapYandex, decodeBingCk: decodeBingCk,
  parseGoogle: parseGoogle, parseYandex: parseYandex, parseBingHtml: parseBingHtml,
  parseDdg: parseDdg, parseGeneric: parseGeneric, parseBySrc: parseBySrc,
  extractAi: extractAi, aiFromHtmlRegex: aiFromHtmlRegex,
  detectSrcFromHost: detectSrcFromHost, detectQueryFromSearch: detectQueryFromSearch,
  collect: collect, buildPayload: buildPayload, legacyCopy: legacyCopy,
  priceFromText: priceFromText, priceOfItem: priceOfItem,
  validatePayload: validatePayload
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.FSBridge = api;
})(typeof window !== "undefined" ? window : this);
