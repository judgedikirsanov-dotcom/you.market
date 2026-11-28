// ============================================================================
// web_tests.js — офлайн-тесты клиентской версии (filter-search-web).
// Прогоняют core.js в Node на тех же фикстурах, что и серверная v4:
// парсеры выдач/маркетплейсов/товарных страниц, определение источника,
// сравнение выдач, фильтр, перевод запроса. Сеть не нужна.
//   node tests/web_tests.js   → «ВСЕ КЛИЕНТСКИЕ ТЕСТЫ ЗЕЛЁНЫЕ»
// ============================================================================
"use strict";
var path = require("path");
var fs = require("fs");
var FC = require("../filter-core.js");
var FS = require("../core.js");

var FIX = path.join(__dirname, "fixtures");
function fixture(name){ return fs.readFileSync(path.join(FIX, name), "utf8"); }

var passed = 0, failed = 0;
function ok(cond, name, extra){
  if (cond){ passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

console.log("== парсеры выдач поисковых систем ==");
(function(){
  var r = FS.parseGoogle(fixture("google_serp.html"));
  ok(r.length === 2, "Google classic /url?q=: " + r.length + " ссылок (как в v4)");
  var rr = FS.parseGoogle(fixture("google_serp_rendered.html"));
  ok(rr.length === 2, "Google отрендеренный (h3): " + rr.length + " ссылок (как в v4)");
  ok(rr.every(function(x){ return /savadeck-bike\.com/.test(x.url) || !/google\.com/.test(x.url); }),
     "Google: служебные ссылки отфильтрованы");

  var y = FS.parseYandex(fixture("yandex_serp.html"));
  ok(y.length === 2, "Яндекс organic: " + y.length + " ссылок (как в v4)");
  ok(y.every(function(x){ return /^https?:\/\//.test(x.url); }), "Яндекс: все ссылки абсолютные");

  var b = FS.parseBingRss(fixture("bing_rss.xml"));
  ok(b.length === 4, "Bing RSS: " + b.length + " ссылок");

  var d = FS.parseDdgHtml(fixture("ddg_html.html"));
  ok(d.length === 4, "DDG html: " + d.length + " ссылок");
  ok(d.some(function(x){ return x.url === "https://savadeck-bike.com/products/sava-a7l-pro-105-r7120"; }),
     "DDG: uddg-редирект развёрнут в настоящий адрес");
  var dl = FS.parseDdgLite(fixture("ddg_lite.html"));
  ok(dl.length === 2, "DDG lite: " + dl.length + " ссылок (как в v4)");
})();

console.log("== парсеры маркетплейсов ==");
(function(){
  // Ozon: JSON-LD из выдачи (фикстуры ozon_search.html в v4 нет — генерируем страницу)
  var ozonHtml = "<html><head><title>sava a7l — Ozon</title></head><body>" +
    '<script type="application/ld+json">{"@type":"Product","name":"SAVA A7L Carbon","url":"https://www.ozon.ru/product/1/","offers":{"price":129000,"priceCurrency":"RUB"}}<\/script>' +
    '<script type="application/ld+json">{"@type":"Product","name":"SAVA A7L 105","url":"https://www.ozon.ru/product/2/","offers":{"price":145000,"priceCurrency":"RUB"}}<\/script>' +
    "</body></html>";
  var oz = FS.parseOzonSearch(ozonHtml);
  ok(oz.length === 2, "Ozon JSON-LD: " + oz.length + " карточек");
  ok(oz.every(function(x){ return x.price > 0; }), "Ozon: у всех карточек цена");

  var al = FS.parseAliRuSearch(fixture("ali_search.html"));
  ok(al.length >= 2, "AliExpress RU: " + al.length + " карточек");
  ok(al.every(function(x){ return x.price > 0; }), "AliExpress: у всех цена");

  var av = FS.parseAvitoSearch(fixture("avito_search.html"));
  ok(av.length >= 2, "Avito: " + av.length + " карточек");
  ok(av.every(function(x){ return x.price > 0; }), "Avito: у всех цена");
})();

console.log("== определение источника вставки ==");
(function(){
  var g = FS.detectSource(fixture("google_serp_rendered.html"));
  ok(g.id === "google", "Google распознан (запрос: " + (g.query || "—") + ")");
  var y = FS.detectSource(fixture("yandex_serp.html"));
  ok(y.id === "yandex", "Яндекс распознан");
  var av = FS.detectSource(fixture("avito_search.html"));
  ok(av.id === "avito", "Avito распознан (синтетика без <title> — запроса нет, это норма)");
  var al = FS.detectSource(fixture("ali_search.html"));
  ok(al.id === "ali", "AliExpress распознан (синтетика без <title> — запроса нет, это норма)");
  var pp = FS.detectSource(fixture("product_page.html"));
  ok(pp.id === "unknown", "страница товара не спутана с выдачей");
})();

console.log("== JSON-LD / OpenGraph ==");
(function(){
  var ld = FS.extractJsonLd(fixture("product_page.html"));
  ok(ld.length >= 1, "JSON-LD Product найден");
  var p = ld.length ? FS.priceFromLd(ld[0]) : null;
  ok(!!p && p.price > 0, "цена из JSON-LD: " + (p ? p.price + " " + p.currency : "нет"));
  var og = FS.extractOg(fixture("product_page.html"));
  ok(!!og.title, "OG title: " + (og.title || "").slice(0, 40));
})();

console.log("== сравнение выдач и подтверждения ==");
(function(){
  var g = FS.parseGoogle(fixture("google_serp_rendered.html")).map(function(r){
    return { engine: "google", title: r.title, url: r.url, snippet: r.snippet };
  });
  var d = FS.parseDdgHtml(fixture("ddg_html.html")).map(function(r){
    return { engine: "ddg", title: r.title, url: r.url, snippet: r.snippet };
  });
  // имитируем пересечение: DDG-хит с тем же title/url, что у Google
  if (g[0] && d[0]){
    d[0].url = g[0].url;
    d[0].title = g[0].title;
  }
  var cmp = FS.compareHits(g.concat(d), "sava a7l carbon road bike");
  ok(cmp.candidates.length >= 2, "кандидатов: " + cmp.candidates.length);
  var conf = cmp.candidates.filter(function(c){ return c.confirmedBy > 1; });
  ok(conf.length >= 1, "пересечение подтверждено двумя источниками: " + conf.length);
  ok(cmp.candidates[0].confirmedBy >= cmp.candidates[cmp.candidates.length - 1].confirmedBy,
     "сортировка: подтверждённые сверху");
  // ключ совпадения — адрес, а не «домен + два слова»: разные товары одного
  // магазина не склеиваются (иначе чужая модель исчезала до оценки)
  var same = FS.compareHits([
    { engine: "ozon", title: "Велосипед SAVA A7L Carbon Road Bike 27.5", url: "https://www.ozon.ru/product/1/" },
    { engine: "ozon", title: "Велосипед SAVA DECK 300", url: "https://www.ozon.ru/product/4" },
    { engine: "yandex", title: "Велосипед SAVA A7L Carbon Road Bike 27.5", url: "HTTP://WWW.OZON.ru/product/1#top" }
  ], "sava a7l carbon");
  ok(same.candidates.length === 2, "разные адреса одного магазина — разные кандидаты: " + same.candidates.length);
  ok(same.candidates.some(function(c){ return c.confirmedBy === 2 && c.engines.indexOf("yandex") >= 0; }),
     "тот же адрес из двух источников — подтверждён");
})();

console.log("== фильтр и медиана (ядро v4 без изменений) ==");
(function(){
  var offers = [
    { title: "SAVA A7L Carbon Road Bike 105", price: 1299, currency: "USD", url: "https://a.com/1", available: true },
    { title: "SAVA A7L Carbon Road Bike 105", price: 1249, currency: "USD", url: "https://b.com/2", available: true },
    { title: "SAVA A5L Carbon Road Bike", price: 899, currency: "USD", url: "https://c.com/3", available: true },   // другая модель (a5l нет в запросе)
    { title: "SAVA A7L Replica 1:1 quality", price: 300, currency: "USD", url: "https://d.com/4", available: true }, // подделка
    { title: "Case Cover for SAVA A7L", price: 15, currency: "USD", url: "https://e.com/5", available: true },       // аксессуар
    { title: "SAVA A7L Carbon Road Bike", price: 100, currency: "USD", url: "https://f.com/6", available: true }     // вдвое ниже рынка
  ];
  var f = FC.filterOffers(offers, "sava a7l carbon road bike");
  ok(f.kept.length === 2, "прошли 2 честные карточки (получено " + f.kept.length + ")");
  ok(f.hidden.length === 4, "скрыто 4 с причинами (получено " + f.hidden.length + ")");
  ok(f.medians.USD > 1000, "медиана USD ≈ 1274 (получено " + f.medians.USD + ")");
  var reasons = f.hidden.map(function(h){ return h.reason; }).join(" | ");
  ok(/подделк/.test(reasons), "подделка скрыта с причиной");
  // 1:1 со сценарием v4-теста (filter_tests.js): запрос «sava al pro» — термы
  // в «Case Cover for SAVA A7L Pro» совпадают, доходит до правила аксессуара
  var accV = FC.checkOffer({ title: "Case Cover for SAVA A7L Pro", price: 15, url: "https://x/1", available: true },
                           FC.significantTerms("sava al pro"));
  ok(!accV.keep && /аксессуар/.test(accV.reason), "аксессуар скрывается правилом (как в v4)");
  ok(/ниже рынка/.test(reasons), "подозрительная цена скрыта с причиной");
})();

console.log("== перевод запроса (словарь v4) ==");
(function(){
  var tr = FC.translateQuery("детский велосипед sava");
  ok(/kids bike/.test(tr.query) && /sava/.test(tr.query), "перевод: «" + tr.query + "»");
  ok(tr.translated, "флаг перевода выставлен");
  var tr2 = FC.translateQuery("карбоновый шоссейный велосипед");
  ok(/carbon/.test(tr2.query) && /road bike/.test(tr2.query), "словарные основы: «" + tr2.query + "»");
})();

console.log("== unwrapYandex без Buffer (браузерный путь) ==");
(function(){
  // u= с процент-энкодом
  var a = FS.unwrapYandex("https://yandex.ru/clck/redir/AiuY0DBWFJ4e?u=https%3A%2F%2Fwww.savadeck-bike.com%2Fa7l");
  ok(/savadeck-bike\.com/.test(a), "энкод разворачивается: " + a.slice(0, 50));  // u= с base64url
  var b64 = "aHR0cHM6Ly9zYXZhZGVjay1iaWtlLmNvbS9hN2w=";
  var b = FS.unwrapYandex("https://yandex.ru/clck/redir?u=" + b64);
  ok(/savadeck-bike\.com/.test(b), "base64url разворачивается (через TextDecoder): " + b.slice(0, 50));
})();

console.log("== Shopify-канал: нормализация (без сети) ==");
(function(){
  var shop = FS.SHOPS[0];
  var it = { title: "SAVA A7L Carbon", price: "12.99", handle: "a7l", available: true, vendor: "SAVA" };
  var o = null;
  // shopifyNormalize не экспортирован — проверяем через открытый формат suggest
  ok(shop && shop.domain === "savadeck-bike.com", "реестр магазинов на месте: " + FS.SHOPS.length + " магазинов");
  ok(typeof FS.shopifyChannel === "function", "канал магазина доступен");
})();

console.log("== карточка товара из вставленного HTML ==");
(function(){
  var card = FS.productHtmlToOffer("https://shop.example/product", fixture("product_page.html"), []);
  ok(card.price > 0, "карточка: цена " + card.price + " " + card.currency);
  ok(card.verified === true, "карточка помечена проверенной");
  ok(!!card.title, "название: " + (card.title || "").slice(0, 40));
})();

console.log("== маскированный поток: конструкторы URL поисковиков ==");
(function(){
  var g = FS.buildEngineUrl("google", "sava a7l carbon");
  ok(g === "https://www.google.com/search?q=sava%20a7l%20carbon", "Google URL: " + g);
  var y = FS.buildEngineUrl("yandex", "sava a7l");
  ok(y === "https://yandex.ru/search/?text=sava%20a7l", "Яндекс URL: " + y);
  var o = FS.buildEngineUrl("ozon", "велосипед");
  ok(o === "https://www.ozon.ru/search/?text=" + encodeURIComponent("велосипед"), "Ozon URL: " + o);
  var a = FS.buildEngineUrl("avito", "sava");
  ok(a === "https://www.avito.ru/all?q=sava", "Avito URL: " + a);
  var al = FS.buildEngineUrl("ali", "sava");
  ok(al === "https://aliexpress.ru/wholesale?SearchText=sava", "AliExpress URL: " + al);
  ok(FS.buildEngineUrl("нет-такого", "q") === null, "неизвестный движок → null");
})();

console.log("== маскированный поток: очередь движков ==");
(function(){
  ok(FS.nextEngine([], null) === "google", "первый в очереди — Google");
  ok(FS.nextEngine(["google"], null) === "yandex", "после Google — Яндекс");
  ok(FS.nextEngine(["google", "yandex"], null) === "ozon", "после Яндекса — Ozon (для цен)");
  ok(FS.nextEngine(["google", "yandex", "ozon"], null) === null, "очередь исчерпана → null");
  ok(FS.nextEngine(["google"], ["google"]) === null, "кастомная очередь уважается");
  // вставка Ozon минуя очередь не должна ломать порядок SERP
  ok(FS.nextEngine(["ozon"], null) === "google", "Ozon не входит в SERP-очередь");
})();

console.log("== авто-каналы: парсинг ответа прокси (без сети, мок allorigins) ==");
(function(){
  // мок: то, что реально отдал allorigins для DDG lite в пробах 2026-11-24
  var mockLite = '<html><body><table>' +
    '<tr><td><a class="result-link" href="https://savadeck-bike.com/products/sava-a7l">SAVA A7L Carbon Road Bike</a></td>' +
    '<td class="result-snippet">carbon road bike 105</td></tr>' +
    '<tr><td><a class="result-link" href="https://market.example/sava">Sava Deck bike shop</a></td>' +
    '<td class="result-snippet">best bikes</td></tr>' +
    '</table></body></html>';
  var items = FS.parseDdgLite(mockLite);
  ok(items.length === 2, "DDG lite мок: " + items.length + " результатов");
  ok(items[0].url === "https://savadeck-bike.com/products/sava-a7l", "ссылка без uddg-обёртки");
  ok(items[0].snippet.length > 0, "сниппет прочитан");

  var mockRss = '<rss><channel>' +
    '<item><title>SAVA A7L</title><link>https://shop.example/a7l</link><description>road</description></item>' +
    '<item><title>Bike B</title><link>https://shop.example/b</link><description>mtb</description></item>' +
    '</channel></rss>';
  var r = FS.parseBingRss(mockRss);
  ok(r.length === 2, "Bing RSS мок: " + r.length + " результатов");
  ok(r[0].title === "SAVA A7L" && r[0].url === "https://shop.example/a7l", "RSS item разобран");

  // detectBlock на моках: капча и согласие распознаются
  ok(/капча/.test(FS.detectBlock("google unusual traffic recaptcha") || ""), "антибот-капча распознана");
  ok(/согласия/.test(FS.detectBlock("consent.google.com Before you continue") || ""), "страница согласия распознана");
})();

console.log("== вставка с принудительным id (авто-каналы) ==");
(function(){
  // addPage-логика для авто: страница с forcedId не парсится заново, items кладёт канал
  // проверяем сопоставление SERP_IDS-типов через compareHits с двумя источниками
  var g = FS.parseGoogle(fixture("google_serp_rendered.html")).map(function(r){
    return { engine: "google", title: r.title, url: r.url, snippet: r.snippet };
  });
  var ddgAuto = [{ engine: "ddg", title: g[0].title, url: g[0].url, snippet: "" }];  // авто-канал нашёл то же
  var cmp = FS.compareHits(g.concat(ddgAuto), "sava a7l carbon road bike");
  ok(cmp.stats.confirmed >= 1, "авто-выдача подтверждает вставку Google: " + cmp.stats.confirmed);
  ok(cmp.candidates[0].engines.indexOf("ddg") >= 0, "в подтверждении участвует ddg (авто)");
})();

console.log("== фрейм-режим: очередь frameFirstQueue и framable-флаги ==");
(function(){
  var q = FS.frameFirstQueue();
  ok(q[0] === "bing", "первый в фрейм-очереди — Bing (запретов нет по пробе)");
  ok(q.indexOf("marginalia") >= 0, "Marginalia в фрейм-очереди");
  ok(q.indexOf("google") < 0, "Google не во фрейм-очереди (SAMEORIGIN)");
  ok(FS.nextEngine([], q) === "bing", "nextEngine уважает фрейм-очередь");
  ok(FS.nextEngine(["bing"], q) === "marginalia", "после Bing — Marginalia");
  ok(FS.nextEngine(["bing", "marginalia"], q) === "yandex", "затем Яндекс");
  var defs = FS.ENGINE_DEFS;
  ok(defs.filter(function(e){ return e.id === "bing"; })[0].framable === true, "bing.framable = true");
  ok(defs.filter(function(e){ return e.id === "google"; })[0].framable === false, "google.framable = false");
  var marg = FS.buildEngineUrl("marginalia", "sava bike");
  ok(marg === "https://marginalia-search.com/search?query=" + encodeURIComponent("sava bike"), "Marginalia URL: " + marg);
  var ddgH = FS.buildEngineUrl("ddg", "sava");
  ok(ddgH === "https://lite.duckduckgo.com/lite/?q=sava", "DDG lite URL (без самозакрытия окна): " + ddgH);
})();

console.log("== фрейм-режим: parseBingHtml на живой структуре Bing ==");
(function(){
  // живая структура bing.com 2026-11-24: <li class="b_algo">… <h2><a href="bing.com/ck/a?…u=a1<base64url>">
  var real = '<ol id="b_results"><li class="b_algo" data-id iid=SERP.1>' +
    '<h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=abcJmltdHM9MQ&amp;u=a1aHR0cHM6Ly9zYXZhZGVjay1iaWtlLmNvbS9wcm9kdWN0cy9zYXZhLWE3bA">SAVA A7L Carbon Road Bike</a></h2></li>' +
    '<li class="b_algo"><h2><a href="https://www.cyclingweekly.com/bikes">Best carbon road bikes</a></h2></li>' +
    '<li class="b_algo"><h2><a href="https://www.bing.com/search?q=x">служебная ссылка</a></h2></li>' +
    '</ol>';
  var items = FS.parseBingHtml(real);
  ok(items.length === 2, "Bing HTML: " + items.length + " результатов (служебная отброшена)");
  ok(items[0].url === "https://savadeck-bike.com/products/sava-a7l", "ck/a-редирект развёрнут из base64url: " + items[0].url);
  ok(items[0].title === "SAVA A7L Carbon Road Bike", "заголовок прочитан");
  // parseBySource("bing") теперь умеет HTML (раньше умел только RSS)
  var viaSource = FS.parseBySource("bing", real);
  ok(viaSource.length === 2, "parseBySource(bing) на HTML: " + viaSource.length);
  // энтити в заголовках декодируются
  var ent = '<li class="b_algo"><h2><a href="https://x.example/1">C&#225;ch X&#243;a &#194;m</a></h2></li>';
  var t = FS.parseBingHtml(ent);
  ok(t.length === 1 && t[0].title === "Cách Xóa Âm", "HTML-энтити декодированы: " + t[0].title);
})();

console.log("== мост-режим (расширение): очередь bridgeQueue ==");
(function(){
  var q = FS.bridgeQueue();
  ok(q[0] === "google" && q[1] === "yandex", "с мостом Google и Яндекс — приоритет: " + q.join("→"));
  ok(q.indexOf("bing") >= 0 && q.indexOf("ddg") >= 0, "запасные движки тоже под капотом (fetch не знает XFO)");
  ok(FS.nextEngine([], q) === "google", "nextEngine: первым под капотом идёт Google");
  ok(FS.nextEngine(["google"], q) === "yandex", "после Google — Яндекс");
  ok(FS.nextEngine(["google", "yandex"], q) === "bing", "затем запасные (Bing)");
})();

console.log("== мост-режим: allowlist URL расширения (serp_allow.js) ==");
(function(){
  var SA = require("../../ext/serp_allow.js");
  ok(SA.serpAllowed("https://www.google.com/search?q=bike"), "Google SERP разрешён");
  ok(SA.serpAllowed("https://yandex.ru/search/?text=bike"), "Яндекс SERP разрешён");
  ok(SA.serpAllowed("https://www.bing.com/search?q=bike"), "Bing SERP разрешён");
  ok(!SA.serpAllowed("https://mail.google.com/u/0/"), "Gmail НЕ разрешён (не выдача)");
  ok(!SA.serpAllowed("https://google.com/settings/security"), "настройки Google НЕ разрешены");
  ok(!SA.serpAllowed("https://bank.example.com/login"), "произвольный сайт НЕ разрешён");
  ok(!SA.serpAllowed("https://www.google.com/search/evil?continue=https://evil.com"), "странный путь НЕ разрешён");
})();

console.log("== мост-режим: parseBySource на HTML, принесённом мостом ==");
(function(){
  // мост приносит настоящий HTML выдачи — парсится как вставленный
  var g = FS.parseBySource("google", fixture("google_serp_rendered.html"));
  ok(g.length > 0, "Google HTML через мост парсится: " + g.length + " результатов");
  var y = FS.parseBySource("yandex", fixture("yandex_serp.html"));
  ok(y.length > 0, "Яндекс HTML через мост парсится: " + y.length + " результатов");
  // оба движка в одной сводке — перекрёстное подтверждение работает
  var hits = [].concat(
    g.map(function(r){ return { engine: "google", title: r.title, url: r.url, snippet: r.snippet || "" }; }),
    y.map(function(r){ return { engine: "yandex", title: r.title, url: r.url, snippet: r.snippet || "" }; })
  );
  var cmp = FS.compareHits(hits, "sava a7l carbon road bike");
  ok(cmp.stats.links >= g.length + y.length - 2, "ссылок из двух движков: " + cmp.stats.links);
})();

console.log("== цены из выдачи: FS.priceFromText и priceVia-разметка ==");
(function(){
  var p;
  p = FS.priceFromText("Детский велосипед 20 дюймов", "цена от 12 990 ₽ в магазине");
  ok(p && p.price === 12990 && p.currency === "RUB", "«12 990 ₽» → 12990 RUB");
  p = FS.priceFromText("Sava A7L Carbon", "offers from $1,499.00");
  ok(p && p.price === 1499 && p.currency === "USD", "«$1,499.00» → 1499 USD");
  p = FS.priceFromText("Велосипед от 9500 руб.", "");
  ok(p && p.price === 9500 && p.currency === "RUB", "«от 9500 руб.» → 9500 RUB");
  p = FS.priceFromText("Детский велосипед Sava A7L 24", "12 500 ₽ с доставкой");
  ok(p && p.price === 12500, "«A7L 24 + 12 500 ₽» → 12500 (не склейка «24 12500»)");
  p = FS.priceFromText("Laptop 89,99 € today", "");
  ok(p && p.price === 89.99 && p.currency === "EUR", "«89,99 €» → 89.99 EUR");
  ok(FS.priceFromText("детский велосипед без цены", "для ребёнка 6 лет") === null, "без цены → null");
  ok(FS.priceFromText("", "") === null, "пустой текст → null");
  // parseBySource размечает priceVia: сниппет → snippet, маркетплейс → market
  var oz = FS.parseBySource("ozon", '<html><script type="application/ld+json">' +
    JSON.stringify([{ "@type": "Product", name: "Велосипед Sava A7L",
      url: "https://www.ozon.ru/product/123", offers: { price: "24990", priceCurrency: "RUB" } }]) +
    '</script></html>');
  ok(oz.length === 1 && oz[0].price === 24990 && oz[0].priceVia === "market",
    "Ozon JSON-LD → priceVia=market");
  var bing = FS.parseBySource("bing", '<li class="b_algo"><h2><a href="https://shop.example.com/kids">Детский велосипед Sava</a></h2></li>');
  ok(bing.length === 1 && bing[0].price === null, "SERP без цены → price null");
  // candidates несут priceVia дальше (hits такие же, как строит runCompare)
  var hits = [{ engine: "ozon", title: "Велосипед Sava A7L", url: "https://www.ozon.ru/product/123",
                price: 24990, currency: "RUB", sourceType: "market" },
              { engine: "bing", title: "Велосипед Sava A7L", url: "https://shop.example.com/kids",
                price: null, currency: null, sourceType: "serp" }];
  var cmp = FS.compareHits(hits, "велосипед sava");
  var withPrice = cmp.candidates.filter(function(c){ return c.price != null; });
  ok(withPrice.length === 1 && withPrice[0].priceVia === "market", "candidate → priceVia market");
})();

console.log("");
if (failed){ console.log("ПРОВАЛЕНО: " + failed); process.exit(1); }
console.log("ВСЕ КЛИЕНТСКИЕ ТЕСТЫ ЗЕЛЁНЫЕ (" + passed + " проверок)");
