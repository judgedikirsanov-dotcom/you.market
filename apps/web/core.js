// ============================================================================
// core.js — клиентское ядро честного поиска (UMD: браузер + Node-тесты).
//
// Порт алгоритмов filter-search v4 в среду браузера: те же парсеры выдач
// (regex, без DOM), то же сравнение выдач, тот же разбор JSON-LD/OpenGraph.
// Поиск выполняется ОТ ЛИЦА ПОЛЬЗОВАТЕЛЯ: пользователь сам открывает поисковик
// или магазин (свой IP, свои куки, антибот видит живого человека), вставляет
// страницу в наш сайт — а мы раскладываем её по правилам фильтра.
//
// Содержит:
//   • парсеры выдач: Google / Яндекс / Bing RSS / DDG html+lite / Mojeek /
//     generic-фолбэк (из engines.js, логика 1:1);
//   • парсеры маркетплейсов: Ozon (JSON-LD) / AliExpress RU (JSON-блоб) /
//     Avito (data-marker) (из shops.js);
//   • detectSource — «что вставили?» + автоперехват запроса из <title>;
//   • compareHits — сравнение нескольких вставленных выдач, «подтверждено
//     N системами» (из compare.js);
//   • extractJsonLd/extractOg — цена/наличие со страниц товаров, которые
//     магазины публикуют сами (из productpage.js);
//   • каналы fetch от IP пользователя: Shopify suggest/products.json (CORS *)
//     и Google-подсказки (JSONP).
//
// Ничего не удаляется молча: у каждого скрытого предложения есть причина.
// ============================================================================
(function(root){
"use strict";

// фильтр (filter-core.js загружен раньше; в Node — require)
var FC = (typeof window !== "undefined" && window.FilterCore) ||
         (typeof require !== "undefined" && require("./filter-core.js"));

// ----------------------------------------------------------------------------
// базовые утилиты разбора HTML (портированы из engines.js без изменений логики)
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

// base64 → utf8 без Buffer (браузер и Node)
function b64ToUtf8(b64){
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  var bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// DDG оборачивает ссылки в /l/?uddg=<urlencoded>
function decodeDdgHref(h){
  h = String(h || "").trim();
  if (h.indexOf("//") === 0) h = "https:" + h;
  var m = /[?&]uddg=([^&]+)/.exec(h);
  if (m){ try { return decodeURIComponent(m[1]); } catch(e){ return m[1]; } }
  return h;
}

// ----------------------------------------------------------------------------
// парсеры выдач поисковых систем (логика 1:1 с engines.js)
// ----------------------------------------------------------------------------
function parseGoogle(html){
  var out = [], seen = {};
  var skip = /(^|\.)google\.[a-z.]+$|gstatic\.com|youtube\.com|blogger\.com|googleads/i;
  function hostOf(u){ return (u.match(/^https?:\/\/([^\/"']+)/) || [])[1] || ""; }
  var re = /<a[^>]*href="\/url\?q=(https?:\/\/[^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(html))){
    var url = decodeEntities(m[1]), t = m[2].replace(/<[^>]+>/g, "").trim();
    if (url && t && !seen[url]){ seen[url] = 1; out.push({ title: decodeEntities(t), url: url, snippet: "" }); }
  }
  if (out.length) return out;
  // отрендеренный DOM (Ctrl+S сохраняет именно его): заголовок результата в <h3>
  re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/g;
  while ((m = re.exec(html))){
    var uH = decodeEntities(m[1]), tH = m[2].replace(/<[^>]+>/g, "").trim();
    if (skip.test(hostOf(uH)) || !tH || seen[uH]) continue;
    seen[uH] = 1;
    out.push({ title: decodeEntities(tH), url: uH, snippet: "" });
  }
  if (out.length) return out;
  re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = re.exec(html))){
    var u2 = decodeEntities(m[1]);
    var t2 = m[2].replace(/<[^>]+>/g, "").trim();
    if (skip.test(hostOf(u2)) || !t2 || t2.length < 12 || seen[u2]) continue;
    seen[u2] = 1;
    out.push({ title: decodeEntities(t2), url: u2, snippet: "" });
  }
  return out;
}

// Яндекс: внешние ссылки через переходник /clck/… с адресом в u= (энкод/b64)
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

function parseYandex(html){
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
  return out;
}

function parseBingRss(xml){
  var out = [];
  var re = /<item>([\s\S]*?)<\/item>/g, m;
  while ((m = re.exec(xml))){
    var item = m[1];
    var title = (item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    var link  = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    var desc  = (item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "";
    if (link) out.push({ title: decodeEntities(title), url: link.trim(),
                         snippet: decodeEntities(desc).replace(/<[^>]+>/g, "").slice(0, 180) });
  }
  return out;
}

function parseDdgHtml(html){
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
  return out;
}

function parseDdgLite(html){
  var anchors = [];
  eachAnchor(html, function(attrs, text){
    if (/result-link/i.test(attrs)) anchors.push({ href: attrGet(attrs, "href"), text: text });
  });
  var snips = [], m;
  var reS = /<td[^>]*class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = reS.exec(html))) snips.push(m[1]);
  var out = [];
  for (var i = 0; i < anchors.length; i++){
    var url = decodeDdgHref(anchors[i].href);
    var title = stripTags(anchors[i].text);
    if (url && title) out.push({ title: title, url: url,
      snippet: snips[i] !== undefined ? stripTags(snips[i]) : "" });
  }
  return out;
}

var JUNK_HOST = /(^|\.)(duckduckgo\.com|brave\.com|bing\.com|google\.[a-z.]+|yandex\.[a-z.]+|ya\.ru|searx\.[a-z]+|marginalia\.nu|mojeek\.com|github\.com|mozilla\.org|wikipedia\.org|accounts\.|support\.|help\.|policies\.|privacy\.|login\.|signin\.|settings|preferences|consent)/i;
var JUNK_TEXT = /^(назад|далее|ещё|more|next|previous|sign in|log in|register|settings|privacy|terms|about|help|support|feedback|careers|blog|home)\b/i;
function parseGenericHtml(html, selfHost){
  var out = [], seen = {};
  eachAnchor(html, function(attrs, text){
    if (out.length >= 25) return;
    var href = attrGet(attrs, "href");
    if (!/^https?:\/\//i.test(href)){
      if (href.indexOf("//") === 0) href = "https:" + href; else return;
    }
    var title = stripTags(text);
    if (title.length < 25 || JUNK_TEXT.test(title)) return;
    var hm = href.match(/^https?:\/\/([^\/"']+)/);
    var host = hm ? hm[1].replace(/^www\./, "") : "";
    if (!host || JUNK_HOST.test(host)) return;
    if (selfHost && host === selfHost) return;
    if (seen[href]) return;
    seen[href] = 1;
    out.push({ title: title, url: href, snippet: "" });
  });
  return out;
}

function parseMojeek(html){
  var out = [];
  var re = /<a[^>]*class="title"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(html))){
    out.push({ title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim(), url: m[1], snippet: "" });
  }
  if (out.length) return out;
  re = /<li><a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = re.exec(html))){
    out.push({ title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim(), url: m[1], snippet: "" });
  }
  return out;
}

// маркеры «система не дала выдачу» — капча, согласие, JS-заглушка
function detectBlock(html){
  var s = String(html || "");
  if (/unusual traffic|g-recaptcha|\/recaptcha\//i.test(s))
    return "капча (антибот) — выдача с этой сети недоступна";
  if (/SmartCaptcha|checkcaptcha|Подтвердите, что запросы отправлял человек/i.test(s))
    return "капча (антибот) — выдача с этой сети недоступна";
  if (/bots use DuckDuckGo|complete the following challenge|Select all squares/i.test(s))
    return "капча (антибот DuckDuckGo) — решите её во вкладке и нажмите закладку снова";
  if (/consent\.google\.|Before you continue/i.test(s))
    return "страница согласия cookies — выдайте выдачу без согласия";
  if (/Включите JavaScript|enable\s+JavaScript|JavaScript is required/i.test(s))
    return "страница требует браузер с JavaScript — сохрани страницу после полной загрузки";
  return null;
}

// ----------------------------------------------------------------------------
// JSON-LD / OpenGraph — цена и наличие со страниц товаров (из productpage.js)
// ----------------------------------------------------------------------------
function flatten(arr){
  var out = [];
  arr.forEach(function(x){
    if (!x) return;
    if (Array.isArray(x)) out.push.apply(out, flatten(x));
    else {
      out.push(x);
      if (typeof x === "object"){
        Object.keys(x).forEach(function(k){
          if (k === "@graph" && Array.isArray(x[k])) out.push.apply(out, flatten(x[k]));
        });
      }
    }
  });
  return out;
}

function extractJsonLd(html){
  var out = [];
  var re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g, m;
  while ((m = re.exec(html))){
    var raw = m[1].trim();
    var data = null;
    try { data = JSON.parse(raw); }
    catch(e){
      try { data = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&")); }
      catch(e2){ continue; }
    }
    var nodes = Array.isArray(data) ? data : [data];
    flatten(nodes).forEach(function(n){
      if (n && (n["@type"] === "Product" ||
                (Array.isArray(n["@type"]) && n["@type"].indexOf("Product") >= 0)))
        out.push(n);
    });
  }
  return out;
}

function priceFromLd(node){
  var of = node.offers;
  if (Array.isArray(of)) of = of[0];
  if (!of) return null;
  var p = of.price || (of.lowPrice) || null;
  var cur = of.priceCurrency || "";
  if (p != null) return { price: parseFloat(p), currency: cur || "USD" };
  return null;
}
function availabilityFromLd(node){
  var of = node.offers;
  if (Array.isArray(of)) of = of[0];
  if (!of || !of.availability) return null;
  var a = String(of.availability);
  if (/InStock/i.test(a)) return true;
  if (/OutOfStock|SoldOut|Discontinued/i.test(a)) return false;
  return null;
}

function extractOg(html){
  function meta(prop){
    var re = new RegExp('<meta[^>]*property=["\u0027]' + prop + '["\u0027][^>]*content=["\u0027]([^"\u0027]*)["\u0027]', "i");
    var m = html.match(re);
    if (m) return m[1];
    // content и property могут меняться местами
    var re2 = new RegExp('<meta[^>]*content=["\u0027]([^"\u0027]*)["\u0027][^>]*property=["\u0027]' + prop + '["\u0027]', "i");
    m = html.match(re2);
    return m ? m[1] : null;
  }
  return {
    title: meta("og:title"),
    price: (function(){
      var p = meta("product:price:amount") || meta("og:price:amount");
      return p ? parseFloat(p) : null;
    })(),
    currency: meta("product:price:currency") || meta("og:price:currency"),
    image: meta("og:image")
  };
}

// ----------------------------------------------------------------------------
// парсеры маркетплейсов (из shops.js, логика 1:1)
// ----------------------------------------------------------------------------
function nearestOf(list, pos){
  var best = null;
  list.forEach(function(x){
    if (!best || Math.abs(x.pos - pos) < Math.abs(best.pos - pos)) best = x;
  });
  return best;
}
function parseRuAmount(s){
  var v = parseFloat(String(s).replace(/[\s\u00a0]/g, "").replace(",", "."));
  return isFinite(v) ? Math.round(v) : null;
}

// цена из текста заголовка/сниппета выдачи («12 990 ₽», «от 9 500 руб», $149, €89,99)
// → {price, currency}; null, если цены в тексте нет. Это честная «цена из выдачи»
// (в карточках помечается ≈), а не цена карточки товара.
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
  // разделители: «1,499.00» → 1499.00 (запятые-тысячи + дробная точка),
  // «89,99» → 89.99 (дробная запятая), «12.990» → 12990 (точка-тысячи)
  num = num.replace(/[\s\u00a0]/g, "");
  var parts = /^(.+?)([.,])(\d{1,2})$/.exec(num);
  if (parts) num = parts[1].replace(/[.,]/g, "") + "." + parts[3];
  else num = num.replace(/[.,]/g, "");
  var v = parseFloat(num);
  return (isFinite(v) && v > 0) ? { price: v, currency: cur } : null;
}

function parseAvitoSearch(html){
  var out = [];
  var reA = /<a[^>]*(?:data-marker="item-title"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-marker="item-title")[^>]*>([\s\S]*?)<\/a>/g, m;
  var anchors = [];
  while ((m = reA.exec(html)))
    anchors.push({ url: m[1] || m[2], title: m[3].replace(/<[^>]+>/g, "").trim(),
                   pos: m.index, end: m.index + m[0].length });
  anchors.forEach(function(a, i){
    var nextStart = i + 1 < anchors.length ? anchors[i + 1].pos : Math.min(a.end + 6000, html.length);
    var seg = html.slice(a.end, nextStart);
    var pm = seg.match(/itemprop="price"[^>]*content="([\d\s]+)"/) ||
             seg.match(/content="([\d\s]+)"[^>]*itemprop="price"/) ||
             seg.match(/>\s*([\d\s]{5,})\s*₽/);
    out.push({ title: a.title, url: a.url,
               price: pm ? parseRuAmount(pm[1]) : null });
  });
  return out.filter(function(x){ return x.url && x.title; });
}

function parseAliRuSearch(html){
  var items = [], titles = [], amounts = [], m;
  var re = /"itemId":\s*"(\d{8,})"/g;
  while ((m = re.exec(html))) items.push({ id: m[1], pos: m.index });
  if (!items.length) return [];
  var rt = /"title":\s*"((?:[^"\\]|\\.){5,150})"/g;
  while ((m = rt.exec(html))) titles.push({
    t: m[1].replace(/\\"/g, '"').replace(/\\u([\dA-Fa-f]{4})/g,
      function(_, h){ return String.fromCharCode(parseInt(h, 16)); }), pos: m.index });
  var ra = /"formatedAmount":\s*"([\d\s.,]+)\s*₽"/g;
  while ((m = ra.exec(html))) amounts.push({ v: parseRuAmount(m[1]), pos: m.index });
  return items.map(function(it){
    var t = nearestOf(titles, it.pos), a = nearestOf(amounts, it.pos);
    return { title: t ? t.t : "", price: a ? a.v : null,
             url: "https://aliexpress.ru/item/" + it.id };
  }).filter(function(x){ return x.title; });
}

function parseOzonSearch(html){
  var out = [];
  var ld;
  try { ld = extractJsonLd(html); } catch(e){ ld = []; }
  ld.forEach(function(n){
    if (n.name && n.offers){
      var of = Array.isArray(n.offers) ? n.offers[0] : n.offers;
      var p = parseFloat(of.price || of.lowPrice);
      out.push({ title: n.name,
                 url: typeof n.url === "string" ? n.url : "",
                 price: isFinite(p) ? p : null });
    }
  });
  return out;
}

// ----------------------------------------------------------------------------
// определить, что вставили, и вытащить запрос из <title>/canonical
// ----------------------------------------------------------------------------
var SOURCES = [
  { id: "google",  name: "Google",     marker: /Поиск в Google|google\.[a-z.]+\/search\?q=|\/url\?q=https?:(?!\/\/(www\.)?google\.)/i },
  { id: "yandex",  name: "Яндекс",     marker: /Яндекс: нашли|serp-item|organic__url|yandex\.[a-z.]+\/search\/\?text=/i },
  { id: "bing",    name: "Bing",       marker: /b_algo|Поиск в Bing|bing\.com\/search\?q=/i },
  { id: "ddg",     name: "DuckDuckGo", marker: /result__a|duckduckgo\.com|at DuckDuckGo/i },
  { id: "mojeek",  name: "Mojeek",     marker: /results-standard|Mojeek</i },
  { id: "ozon",    name: "Ozon",       marker: /ozon\.ru|searchResults|"widgets"|"composerApi"/i },
  { id: "ali",     name: "AliExpress", marker: /aliexpress\.ru|formatedAmount|SearchResultsItems/i },
  { id: "avito",   name: "Avito",      marker: /avito\.ru|item-title|data-marker="item/i }
];

var TITLE_QUERY = [
  { re: /^(.+?)\s+[-—·|]\s+Поиск в Google\s*$/i, group: 1 },
  { re: /^(.+?)\s+[-—·|]\s+Яндекс[^\u0000-\u007f]*$/i, group: 1 },        // «q — Яндекс: нашли N…»
  { re: /^(.+?)\s+[-—·|]\s+(?:Поиск в\s+)?Bing\s*$/i, group: 1 },
  { re: /^(.+?)\s+[-—·|]\s+at DuckDuckGo\s*$/i, group: 1 },
  { re: /^(.+?)\s+[-—·|]\s+Mojeek\s*$/i, group: 1 },
  { re: /^(.+?)\s+[-—·|·]\s+Ozon\s*$/i, group: 1 },
  { re: /^(.+?)\s+[-—·|]\s+Avito\b/i, group: 1 },
  { re: /^(.+?)\s+—\s+\d+\s+объявл/i, group: 1 },
  { re: /^(.+?)\s+[-—·]\s+Покупки на AliExpress/i, group: 1 }
];

// Bing HTML-выдача: <li class="b_algo"> … <h2><a href="bing.com/ck/a?...u=a1<base64url>">
// (живая проба 2026-11-24: 10 результатов, ссылки через редирект ck/a с base64url)
function decodeBingCk(href){
  var m = /u=a1([A-Za-z0-9_-]+)/.exec(String(href || ""));
  if (!m) return href;
  try {
    var b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    if (typeof atob === "function"){
      var bin = atob(b64), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(arr);
    }
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  } catch(e){}
  return href;
}

function parseBingHtml(html){
  var out = [];
  var re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))){
    var url = decodeEntities(m[1]);
    if (/bing\.com\/(ck|aclick)/i.test(url)) url = decodeBingCk(url);
    if (!/^https?:\/\//i.test(url) || /bing\.com\/search/i.test(url)) continue;
    var title = decodeEntities(stripTags(m[2])).replace(/\s+/g, " ").trim();
    if (title) out.push({ title: title, url: url, snippet: "" });
  }
  return out;
}

function titleOf(html){
  var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1]) : "";
}
function canonicalQuery(html){
  var m = /<link[^>]*rel=["']canonical["'][^>]*href="([^"]+)"/i.exec(html) ||
          /<link[^>]*href="([^"]+)"[^>]*rel=["']canonical["']/i.exec(html);
  if (!m) return null;
  var u = decodeEntities(m[1]);
  var q = /[?&](?:q|text|SearchText|query)=([^&]+)/i.exec(u);
  if (!q) return null;
  try { return decodeURIComponent(q[1]); } catch(e){ return q[1]; }
}
function detectSource(html){
  var s = String(html || "");
  var found = null;
  for (var i = 0; i < SOURCES.length && !found; i++)
    if (SOURCES[i].marker.test(s)) found = SOURCES[i];
  if (!found) return { id: "unknown", name: "не распознано", query: null };
  var q = canonicalQuery(s);
  if (!q){
    var t = titleOf(s);
    for (var j = 0; j < TITLE_QUERY.length && !q; j++){
      var m = TITLE_QUERY[j].re.exec(t);
      if (m) q = m[TITLE_QUERY[j].group];
    }
  }
  return { id: found.id, name: found.name, query: q ? q.trim() : null };
}

// разобрать вставленную страницу её парсером → [{title,url,snippet,price?}]
// попутно: цены вынимаем и из текста результата (title/snippet), честно
// помечая происхождение (priceVia: market — парсер площадки, snippet — из выдачи)
function parseBySource(id, html){
  var r;
  if (id === "google") r = parseGoogle(html);
  else if (id === "yandex") r = parseYandex(html);
  else if (id === "bing") r = parseBingHtml(html).concat(parseBingRss(html)).filter(function(x, i, a){
      return a.findIndex(function(y){ return y.url === x.url; }) === i; });
  else if (id === "ddg")
    r = parseDdgHtml(html).concat(parseDdgLite(html)).filter(function(x, i, a){
      return a.findIndex(function(y){ return y.url === x.url; }) === i; });
  else if (id === "mojeek") r = parseMojeek(html);
  else if (id === "ozon") r = parseOzonSearch(html);
  else if (id === "ali") r = parseAliRuSearch(html);
  else if (id === "avito") r = parseAvitoSearch(html);
  else return [];
  var market = (id === "ozon" || id === "avito" || id === "ali");
  function annotate(list){
    list.forEach(function(it){
      if (it.price != null){ it.priceVia = market ? "market" : null; return; }
      var p = priceFromText(it.title, it.snippet);
      if (p){ it.price = p.price; it.currency = p.currency; it.priceVia = "snippet"; }
      else it.price = null;   // нормализуем: цена отсутствует (не undefined)
    });
    return list;
  }
  if (!r.length) return annotate(parseGenericHtml(html, null));
  return annotate(r);
}

// ----------------------------------------------------------------------------
// сравнение выдач (из compare.js; фильтр — через FC)
// ----------------------------------------------------------------------------
function hostOf(u){
  var m = /^https?:\/\/([^\/"']+)/.exec(String(u || ""));
  return m ? m[1].replace(/^www\./, "") : "";
}
function keyOf(hit){
  var words = FC.significantTerms(hit.title).slice(0, 2).join(" ");
  return hostOf(hit.url) + "|" + words;
}
function compareHits(hits, query){
  var terms = FC.significantTerms(query);
  var groups = {}, list = [];
  hits.forEach(function(h){
    var key = keyOf(h);
    var g = groups[key];
    if (!g){
      g = groups[key] = { key: key, urls: {}, engines: {}, best: null, hits: [] };
      list.push(g);
    }
    g.urls[h.url] = 1;
    g.engines[h.engine] = 1;
    if (h.img && !g.img) g.img = h.img;   // v14: картинка любого из источников
    g.hits.push(h);
    if (!g.best || h.title.length > g.best.title.length) g.best = h;
  });
  var candidates = [];
  list.forEach(function(g){
    var engines = Object.keys(g.engines);
    var urls = Object.keys(g.urls);
    var best = g.best;
    var titleNorm = FC.normText(best.title);
    var miss = terms.filter(function(t){ return titleNorm.indexOf(t) < 0; });
    var matched = terms.length > 0 && miss.length === 0;
    candidates.push({
      title: best.title, url: urls[0], urls: urls, engines: engines,
      confirmedBy: engines.length, matchedQuery: matched, missingTerms: miss,
      snippet: best.snippet || "", price: best.price != null ? best.price : null,
      currency: best.currency || null, sourceType: best.sourceType || "serp",
      img: g.img || null,
      priceVia: best.priceVia ||
        (best.sourceType === "market" && best.price != null ? "market" : null)
    });
  });
  candidates.sort(function(a, b){
    var sa = (a.confirmedBy > 1 ? 2 : 0) + (a.matchedQuery ? 1 : 0);
    var sb = (b.confirmedBy > 1 ? 2 : 0) + (b.matchedQuery ? 1 : 0);
    if (sa !== sb) return sb - sa;
    return b.confirmedBy - a.confirmedBy;
  });
  return {
    candidates: candidates,
    stats: {
      links: hits.length, uniqueTargets: candidates.length,
      confirmed: candidates.filter(function(c){ return c.confirmedBy > 1; }).length,
      matched: candidates.filter(function(c){ return c.matchedQuery; }).length
    }
  };
}

// ----------------------------------------------------------------------------
// карточки-офферы для фильтра: из кандидатов сравнения и из выдач маркетплейсов
// ----------------------------------------------------------------------------
function serpCandidateToOffer(c){
  return {
    shop: hostOf(c.url) || "web",
    shopName: (hostOf(c.url) || "веб") + (c.confirmedBy > 1 ?
      " · подтверждено " + c.confirmedBy + " источниками" : ""),
    platform: "web",
    title: c.title || "", price: c.price || 0, currency: c.currency || "RUB",
    url: c.url, image: c.img || null, available: true, vendor: null,
    tags: [], verified: false, priceVia: c.priceVia || null,
    flags: (c.confirmedBy > 1 ? ["ссылку независимо показали " + c.confirmedBy +
      " источника(ов): " + c.engines.join(", ")] : []),
    checkedAt: new Date().toISOString()
  };
}

function marketCardToOffer(card, shopName, currency){
  return {
    shop: shopName, shopName: shopName, platform: "marketplace",
    title: card.title, price: card.price || 0, currency: currency || "RUB",
    url: (card.url && card.url.indexOf("http") === 0) ? card.url :
         ("https://" + shopName.replace(/^www\./, "") + card.url),
    image: card.img || null, available: true, vendor: null, tags: [], verified: true,
    priceVia: "market",
    flags: card.price ? ["цена из выдачи поиска площадки — с твоего браузера"] : [],
    checkedAt: new Date().toISOString()
  };
}

// вставленная страница товара (JSON-LD/OpenGraph) → проверенная карточка
function productHtmlToOffer(url, html, flags){
  var ld = extractJsonLd(html);
  var og = extractOg(html);
  var node = ld[0] || null;
  var price = node ? priceFromLd(node) : null;
  var card = {
    shop: hostOf(url) || "web", shopName: hostOf(url) || "веб", platform: "web",
    title: (node && node.name) || og.title || "",
    price: price ? price.price : (og.price || 0),
    currency: price ? price.currency : (og.currency || "USD"),
    url: url, image: (node && node.image && (typeof node.image === "string" ? node.image : node.image.url)) || og.image || null,
    available: node ? availabilityFromLd(node) : null,
    vendor: null, tags: [], verified: true,
    flags: (flags || []).concat(price ? ["цена и наличие из карточки товара (JSON-LD магазина)"] : []),
    checkedAt: new Date().toISOString()
  };
  if (node && card.available === null) card.available = true;
  if (!price && !og.price) card.notProductPage = true;
  return card;
}

// ----------------------------------------------------------------------------
// Shopify-канал: fetch от IP пользователя (CORS * у storefront JSON)
// ----------------------------------------------------------------------------
var SHOPS = [
  { id: "savadeck",  name: "SAVA / SAVADECK bikes", domain: "savadeck-bike.com",
    platform: "shopify", currency: "USD", cats: ["bike"], note: "карбоновые шоссейные и горные велосипеды" },
  { id: "prevelo",   name: "Prevelo Bikes", domain: "prevelo.com",
    platform: "shopify", currency: "USD", cats: ["bike", "kids"], note: "детские велосипеды" },
  { id: "state",     name: "State Bicycle Co.", domain: "statebicycle.com",
    platform: "shopify", currency: "USD", cats: ["bike"], note: "синглспиды и фиксики" },
  { id: "sixthree",  name: "sixthreezero", domain: "sixthreezero.com",
    platform: "shopify", currency: "USD", cats: ["bike"], note: "круизеры, городские велосипеды" },
  { id: "kbdfans",   name: "KBDfans", domain: "kbdfans.com",
    platform: "shopify", currency: "USD", cats: ["keyboard"], note: "механические клавиатуры и комплектующие" },
  { id: "cannonkeys",name: "Cannon Keys", domain: "cannonkeys.com",
    platform: "shopify", currency: "USD", cats: ["keyboard"], note: "механические клавиатуры и комплектующие" }
];

function fetchJson(url, timeoutMs){
  return new Promise(function(resolve, reject){
    var done = false;
    var ctl = ("AbortController" in (root || globalThis)) ? new AbortController() : null;
    var to = setTimeout(function(){
      done = true;
      if (ctl) ctl.abort();
      reject(new Error("таймаут запроса"));
    }, timeoutMs || 12000);
    fetch(url, ctl ? { signal: ctl.signal, mode: "cors" } : { mode: "cors" })
      .then(function(r){
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function(j){ if (!done){ clearTimeout(to); resolve(j); } })
      .catch(function(e){ if (!done){ clearTimeout(to); reject(e); } });
  });
}

function shopifyNormalize(shop, it){
  var price = Math.round(parseFloat(it.price || 0) * 100) / 100;
  return {
    shop: shop.id, shopName: shop.name, platform: "shopify",
    title: it.title || it.name || "", price: price, currency: shop.currency,
    url: "https://" + shop.domain + "/products/" + (it.handle || ""),
    image: it.featured_image || (it.images && it.images[0]) || null,
    available: (typeof it.available === "boolean") ? it.available : true,
    vendor: it.vendor || null, tags: Array.isArray(it.tags) ? it.tags : [],
    verified: true, flags: [], checkedAt: new Date().toISOString()
  };
}

// поиск магазина, как печатает человек в поисковой строке магазина
function shopifySearch(shop, q, limit){
  var u = "https://" + shop.domain + "/search/suggest.json?q=" + encodeURIComponent(q) +
          "&resources[type]=product&resources[limit]=" + (limit || 6);
  return fetchJson(u).then(function(j){
    var items = (j && j.resources && j.resources.results && j.resources.results.products) || null;
    if (!items) throw new Error("магазин не отдал подсказки поиска");
    return items.map(function(it){ return shopifyNormalize(shop, it); });
  });
}

// запасной путь: каталог магазина (products.json — та же страница, что открывает человек)
function shopifyCatalog(shop, q){
  var u = "https://" + shop.domain + "/products.json?limit=250";
  return fetchJson(u, 15000).then(function(j){
    var prods = (j && j.products) || [];
    if (!Array.isArray(prods)) throw new Error("каталог не пришёл");
    var terms = FC.significantTerms(q);
    return prods.filter(function(p){
      var t = FC.normText((p.title || "") + " " + (p.vendor || ""));
      return terms.some(function(term){ return t.indexOf(term) >= 0; });
    }).slice(0, 8).map(function(p){
      var v = (p.variants && p.variants[0]) || {};
      return shopifyNormalize(shop, {
        title: p.title, price: v.price,
        available: (p.variants || []).some(function(x){ return x.available; }),
        vendor: p.vendor, handle: p.handle,
        featured_image: (p.images && p.images[0] && p.images[0].src) || null
      });
    });
  });
}

// один магазин: поиск → фолбэк каталог (всегда отчёт, не бросается)
function shopifyChannel(shop, q){
  return shopifySearch(shop, q).catch(function(){
    return shopifyCatalog(shop, q);
  }).then(function(offers){
    return { shop: shop, offers: offers, found: offers.length, error: null };
  }).catch(function(e){
    return { shop: shop, offers: [], found: 0, error: String(e && e.message || e) };
  });
}

// магазины по категории запроса (как человек: за ключами — в клавиатурные)
function orderShops(terms){
  return SHOPS.slice().sort(function(a, b){
    var ma = (a.cats || []).some(function(c){ return terms.indexOf(c) >= 0; }) ? 0 : 1;
    var mb = (b.cats || []).some(function(c){ return terms.indexOf(c) >= 0; }) ? 0 : 1;
    return ma - mb;
  });
}

// ----------------------------------------------------------------------------
// Google-подсказки через JSONP (запрос уходит с IP пользователя, CSP не мешает)
// ----------------------------------------------------------------------------
function googleSuggest(q, timeoutMs){
  return new Promise(function(resolve){
    var cbName = "__fsSuggest" + Math.floor(Math.random() * 1e9);
    var s = document.createElement("script");
    var done = false;
    function finish(v){
      if (done) return;
      done = true;
      clearTimeout(to);
      try { delete window[cbName]; } catch(e){ window[cbName] = undefined; }
      if (s.parentNode) s.parentNode.removeChild(s);
      resolve(v);
    }
    var to = setTimeout(function(){ finish(null); }, timeoutMs || 5000);
    window[cbName] = function(data){
      var out = [];
      if (data && data[1]) data[1].forEach(function(x){
        if (typeof x === "string") out.push(x);
        else if (x && typeof x[0] === "string") out.push(x[0]);
      });
      finish(out);
    };
    s.src = "https://suggestqueries.google.com/complete/search?client=youtube&q=" +
            encodeURIComponent(q) + "&callback=" + cbName;
    s.onerror = function(){ finish(null); };
    document.head.appendChild(s);
  });
}

// ----------------------------------------------------------------------------
// авто-открытие поисковиков: конструкторы URL, флаги фрейма и порядок очереди.
// framable — результат живой пробы 2026-11-24 (curl -L, финальные заголовки):
//   Bing и Marginalia не отдают X-Frame-Options / frame-ancestors — встраиваются;
//   Google (SAMEORIGIN), DDG (frame-ancestors 'self'), Ecosia/Brave/Startpage —
//   закрыты; Яндекс/Ozon/Avito не отдают запрета на редиректе, но проверяются
//   вживую во фрейме (антибот может отдать капчу/заглушку поверх 200).
// ----------------------------------------------------------------------------
var ENGINE_DEFS = [
  { id: "google", name: "Google",     market: false, framable: false,
    url: function(q){ return "https://www.google.com/search?q=" + encodeURIComponent(q); } },
  { id: "yandex", name: "Яндекс",     market: false, framable: null,   // пробуем фрейм, фолбэк — вкладка
    url: function(q){ return "https://yandex.ru/search/?text=" + encodeURIComponent(q); } },
  { id: "bing",   name: "Bing",       market: false, framable: true,
    url: function(q){ return "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&count=30"; } },
  { id: "ddg",    name: "DuckDuckGo", market: false, framable: false,
    // lite-версия: серверный HTML без их анти-автоматизации (та сама закрывала
    // popup-окно раньше, чем успевал отчитаться скрипт-мост) и не рвёт opener —
    // значит postMessage + window.close() работают: вкладка закрывается сама
    url: function(q){ return "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q); } },
  { id: "mojeek", name: "Mojeek", market: false, framable: false,
    url: function(q){ return "https://www.mojeek.com/search?q=" + encodeURIComponent(q); } },
  { id: "brave",  name: "Brave",      market: false, framable: false,
    url: function(q){ return "https://search.brave.com/search?q=" + encodeURIComponent(q); } },
  { id: "marginalia", name: "Marginalia", market: false, framable: true,
    url: function(q){ return "https://marginalia-search.com/search?query=" + encodeURIComponent(q); } },
  { id: "ozon",   name: "Ozon",       market: true,  framable: null,
    url: function(q){ return "https://www.ozon.ru/search/?text=" + encodeURIComponent(q); } },
  { id: "avito",  name: "Avito",      market: true,  framable: null,
    url: function(q){ return "https://www.avito.ru/all?q=" + encodeURIComponent(q); } },
  { id: "ali",    name: "AliExpress", market: true,  framable: null,
    url: function(q){ return "https://aliexpress.ru/wholesale?SearchText=" + encodeURIComponent(q); } }
];

function buildEngineUrl(id, q){
  for (var i = 0; i < ENGINE_DEFS.length; i++)
    if (ENGINE_DEFS[i].id === id) return ENGINE_DEFS[i].url(String(q || ""));
  return null;
}

// ----------------------------------------------------------------------------
// две очереди движения к выдаче:
//  • bridgeQueue — с расширением-мостом: Google и Яндекс в приоритете, их
//    fetch'ит сервис-воркер расширения с куками и IP пользователя (fetch не
//    подчиняется X-Frame-Options — это не встраивание), без вкладок и iframe;
//  • frameFirstQueue — без расширения: Bing + Marginalia во фрейм-панели
//    (не отдают запретов по живой пробе 2026-11-24), Яндекс — «может быть».
// ----------------------------------------------------------------------------
function bridgeQueue(){
  return ["google", "yandex", "bing", "ddg", "marginalia"];
}

function frameFirstQueue(){
  return ["bing", "marginalia", "yandex"];
}

// следующий движок очереди, страницу которого ещё не приносили:
// Google → Яндекс → Ozon (то, что уже вставлено, не открываем повторно)
function nextEngine(pastedIds, queueIds){
  var ids = queueIds || ["google", "yandex", "ozon"];
  for (var i = 0; i < ids.length; i++)
    if ((pastedIds || []).indexOf(ids[i]) < 0) return ids[i];
  return null;
}

// ----------------------------------------------------------------------------
// авто-каналы через публичный прокси allorigins (запрос идёт с IP прокси,
// НЕ пользователя — честно помечаем в UI; канал может умереть в любой момент,
// конвейер продолжает работу на остальных источниках)
// ----------------------------------------------------------------------------
function fetchText(url, timeoutMs){
  return new Promise(function(resolve, reject){
    var done = false;
    var ctl = ("AbortController" in (root || globalThis)) ? new AbortController() : null;
    var to = setTimeout(function(){
      done = true; if (ctl) ctl.abort(); reject(new Error("таймаут"));
    }, timeoutMs || 15000);
    fetch(url, ctl ? { signal: ctl.signal } : undefined)
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function(t){ if (!done){ clearTimeout(to); resolve(t); } })
      .catch(function(e){ if (!done){ clearTimeout(to); reject(e); } });
  });
}

function viaProxy(targetUrl, timeoutMs){
  return fetchText("https://api.allorigins.win/raw?url=" + encodeURIComponent(targetUrl),
                   timeoutMs || 20000);
}

// DuckDuckGo lite через прокси — единственный живой авто-канал (проверено
// живой пробой 2026-11-24: HTTP 200, маркеры результатов на месте)
function autoDdgLite(q){
  return viaProxy("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q))
    .then(function(html){
      var block = detectBlock(html);
      var items = parseDdgLite(html);
      if (block) throw new Error(block);
      if (!items.length) throw new Error("пустая выдача");
      return items;
    });
}

// Bing RSS через прокси — запасной авто-канал (нестабильный, отказы — норма)
function autoBingRss(q){
  return viaProxy("https://www.bing.com/search?format=rss&q=" + encodeURIComponent(q))
    .then(function(xml){
      var items = parseBingRss(xml);
      if (!items.length) throw new Error("пустая выдача");
      return items;
    });
}

var FSCore = {
  // парсеры
  parseGoogle: parseGoogle, parseYandex: parseYandex, parseBingRss: parseBingRss, parseBingHtml: parseBingHtml,
  parseDdgHtml: parseDdgHtml, parseDdgLite: parseDdgLite, parseMojeek: parseMojeek,
  parseGenericHtml: parseGenericHtml, parseAvitoSearch: parseAvitoSearch,
  parseAliRuSearch: parseAliRuSearch, parseOzonSearch: parseOzonSearch,
  detectBlock: detectBlock, unwrapYandex: unwrapYandex, decodeDdgHref: decodeDdgHref,
  // JSON-LD / OG
  extractJsonLd: extractJsonLd, extractOg: extractOg, priceFromLd: priceFromLd,
  availabilityFromLd: availabilityFromLd,
  // сравнение и конвертация
  compareHits: compareHits, hostOf: hostOf, keyOf: keyOf, priceFromText: priceFromText,
  detectSource: detectSource, parseBySource: parseBySource,
  serpCandidateToOffer: serpCandidateToOffer, marketCardToOffer: marketCardToOffer,
  productHtmlToOffer: productHtmlToOffer,
  // конвейер вкладок + авто-каналы + фрейм-панель + мост (расширение)
  ENGINE_DEFS: ENGINE_DEFS, buildEngineUrl: buildEngineUrl, nextEngine: nextEngine,
  frameFirstQueue: frameFirstQueue, bridgeQueue: bridgeQueue,
  autoDdgLite: autoDdgLite, autoBingRss: autoBingRss, viaProxy: viaProxy,
  // каналы
  SHOPS: SHOPS, shopifyChannel: shopifyChannel, shopifySearch: shopifySearch,
  shopifyCatalog: shopifyCatalog, orderShops: orderShops, googleSuggest: googleSuggest
};

if (typeof module !== "undefined" && module.exports) module.exports = FSCore;
else root.FSCore = FSCore;
})(typeof window !== "undefined" ? window : globalThis);
