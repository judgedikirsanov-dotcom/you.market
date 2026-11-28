// Тесты моста (bridge-lib.js): парсеры, ИИ-экстракция, payload, валидация,
// адрес релея с лимитом длины (relayHash).
// Запуск: node tools/test_bridge_lib.js
const path = require("path");
const FB = require(path.join(__dirname, "..", "apps", "web", "bridge-lib.js"));

let fails = 0;
function check(name, cond, extra){
  console.log((cond ? "✓" : "✗") + " " + name + (extra ? " | " + extra : ""));
  if (!cond) fails++;
}

// ---- парсеры на синтетических фиксaturах -------------------------------------
const googleFixture = `
<div><a href="/url?q=https://kids-bike.example.com/product/1&sa=x"><h3>Детский велосипед A7L Carbon</h3></a></div>
<div><a href="/url?q=https://shop2.example.org/kids/road-bike&sa=y"><h3>Kids road bike 24"</h3></a></div>`;
let r = FB.parseGoogle(googleFixture);
check("parseGoogle: /url?q= → 2", r.length === 2 && r[0].url === "https://kids-bike.example.com/product/1",
      r.map(x=>x.title).join("; "));
const rH3 = FB.parseGoogle('<div><a href="https://shop2.example.org/kids/road-bike"><h3>Kids road bike 24"</h3></a><a href="https://www.google.com/search?q=other"><h3>Другой поиск</h3></a></div>');
check("parseGoogle: стиль h3 без google-хостов", rH3.length === 1 && rH3[0].url === "https://shop2.example.org/kids/road-bike");

const yandexFixture = `
<a class="organic__url" href="https://yandex.ru/clck/jar?u=https%3A%2F%2Fveloshop.example.ru%2Fdet%2Fa7l"><span class="organic__url-text">Детский велосипед A7L — купить</span></a>
<a class="organic__url" href="https://yandex.ru/search/?text=x"><span>внутренняя</span></a>`;
r = FB.parseYandex(yandexFixture);
check("parseYandex: clck unwrap → 1", r.length === 1 && r[0].url === "https://veloshop.example.ru/det/a7l", r[0] && r[0].url);

const bingFixture = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&u=a1aHR0cHM6Ly9iaWtlc2hvcC5leGFtcGxlLmNvbS9raWRz">Детский велосипед в магазине</a></h2></li>`;
r = FB.parseBingHtml(bingFixture);
check("parseBingHtml: ck/a base64url → 1", r.length === 1 && r[0].url === "https://bikeshop.example.com/kids", r[0] && r[0].url);

const ddgFixture = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkidvelo.example.com%2Fa7l">Детский велосипед A7L</a>
<a class="result__snippet" href="#">описание выдачи DDG</a>`;
r = FB.parseDdg(ddgFixture);
check("parseDdg: uddg → 1", r.length === 1 && r[0].url === "https://kidvelo.example.com/a7l", r[0] && r[0].url);

// ---- ИИ-экстракция (regex-путь, DOM-путь требует браузера) ---------------------
const googleAi = `<div><h2>AI Overview</h2><div><p>Carbon frame kids bikes typically cost between 400 and 1200 USD depending on wheel size and component group. For a 24-inch wheel consider wheelbase and stack height first.</p></div></div>`;
r = FB.extractAi("google", googleAi, null);
check("extractAi: Google AI Overview", r && r.text.length > 60 && r.guess === true, r && r.text.slice(0, 60));
const yandexAi = `<div><h3>Нейро</h3><div><p>Для ребёнка 8–10 лет подойдёт велосипед с колёсами 20–24 дюйма и лёгкой рамой; карбон экономит вес, но требует ухода.</p></div></div>`;
r = FB.extractAi("yandex", yandexAi, null);
check("extractAi: Яндекс Нейро", r && r.text.length > 40, r && r.text.slice(0, 50));
check("extractAi: нет блока → null", FB.extractAi("bing", googleFixture, null) === null);

// ---- payload и валидация --------------------------------------------------------
const payload = FB.buildPayload({ src: "google", q: "детский велосипед",
  items: [{ title: "т", url: "https://x.y/1", snippet: "s" }],
  ai: { text: "ответ ИИ длиной более八十".repeat(3), guess: true }, html: "<html/>" });
check("payload: fsBridge=1, v=2, items=1", payload.fsBridge === 1 && payload.v === 2 && payload.items.length === 1);
check("payload: ai пронесён", payload.ai && payload.ai.text.length > 60 && payload.ai.guess === true);
check("payload: html не носится при items>0", payload.html === undefined);
const emptyPayload = FB.buildPayload({ src: "ddg", q: "x", items: [], ai: null, html: "<html><a class=result__a href=//d/l/?uddg=https%3A%2F%2Fx.y%2F1>t</a></html>" });
check("payload: html-фолбэк при 0 items", typeof emptyPayload.html === "string" && emptyPayload.html.length > 0);
check("validatePayload: корректный → true", FB.validatePayload(payload));
check("validatePayload: чужой src → false", FB.validatePayload({ fsBridge: 1, src: "evil", items: [] }) === false);
check("validatePayload: не fsBridge → false", FB.validatePayload({ hello: 1 }) === false);

check("detectSrcFromHost: google.de → google", FB.detectSrcFromHost("www.google.de") === "google");
check("detectSrcFromHost: ya.ru → yandex", FB.detectSrcFromHost("ya.ru") === "yandex");
check("detectSrcFromHost: evil → null", FB.detectSrcFromHost("evil.example.com") === null);
check("detectQueryFromSearch: text= → yandex", FB.detectQueryFromSearch("?text=детский+велосипед") === "детский велосипед");

// ---- адрес релея: данные в «#», лимит длины адреса движка -----------------------
// расшифровка «#fsRelay=…» — как на странице-релее (app.js b64urlToUtf8)
function decodeHash(h){
  const m = /^#fsRelay=([A-Za-z0-9_-]+)(&fsh=1)?$/.exec(h);
  return m ? { p: JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")), fsh: !!m[2] } : null;
}
let rh = FB.relayHash(emptyPayload, false);
let dh = decodeHash(rh.hash);
check("relayHash: короткий payload едет целиком, без обрезки",
      rh.cut === 0 && dh && dh.p.html === emptyPayload.html && dh.p.src === "ddg" && dh.fsh === false, rh.hash.slice(0, 40));
rh = FB.relayHash(emptyPayload, true);
dh = decodeHash(rh.hash);
check("relayHash: маркер шаттла → &fsh=1 в адресе", dh && dh.fsh === true && rh.hash.slice(-6) === "&fsh=1");
// страница целиком 1,5 млн знаков (ASCII): адрес без лимита был бы ~2,1 млн символов —
// Firefox такой не довозит; с лимитом — влезает, хвост отрезан и помечен
const bigHtml = "<html><body>" + "x".repeat(1500000) + "</body></html>";
const bigP = FB.buildPayload({ src: "ozon", q: "sava a7l", items: [], ai: null, html: bigHtml });
const naive = "#fsRelay=" + FB.b64url(JSON.stringify(bigP));
rh = FB.relayHash(bigP, false);
dh = decodeHash(rh.hash);
check("relayHash: без лимита адрес был бы длиннее предела Firefox 1 048 576 — " + naive.length, naive.length > 1048576);
check("relayHash: страница 1,5 млн знаков — адрес в лимите " + FB.RELAY_MAX_URL, rh.hash.length <= FB.RELAY_MAX_URL, rh.hash.length);
check("relayHash: лимит используется, а не половина (запас < 2 %)", rh.hash.length >= FB.RELAY_MAX_URL * 0.98, rh.hash.length);
check("relayHash: обрезка помечена htmlCut, длина сходится",
      rh.cut > 0 && dh && dh.p.htmlCut === 1500000 && dh.p.html.length === 1500000 - rh.cut,
      "cut=" + rh.cut + ", html=" + (dh && dh.p.html.length));
check("relayHash: обрезка — это начало страницы, остальные поля целы",
      dh && dh.p.html === bigHtml.slice(0, dh.p.html.length) && dh.p.src === "ozon" && dh.p.fsBridge === 1 &&
      Array.isArray(dh.p.items) && dh.p.items.length === 0 && FB.validatePayload(dh.p));
// кириллица: 2 байта на знак — адрес растёт быстрее, лимит всё равно держится
const ruHtml = "<p>Велосипед SAVA A7L карбон — цена</p>".repeat(60000);   // 2,3 млн знаков → buildPayload режет до 1,5 млн
const ruP = FB.buildPayload({ src: "avito", q: "sava", items: [], ai: null, html: ruHtml });
rh = FB.relayHash(ruP, true);
dh = decodeHash(rh.hash);
check("relayHash: кириллица (страница 1,5 млн знаков) — адрес в лимите, &fsh=1 сохранён",
      rh.hash.length <= FB.RELAY_MAX_URL && dh && dh.fsh === true && dh.p.htmlCut === ruP.html.length &&
      ruP.html.length === 1500000, rh.hash.length + "/" + FB.RELAY_MAX_URL);
// резать нечего (нет html) — отдаём как есть; такие payload всегда маленькие
const noHtml = FB.buildPayload({ src: "google", q: "x", items: [{ title: "t", url: "https://a.b/1" }], ai: null, html: "" });
check("relayHash: без html ничего не режется", FB.relayHash(noHtml, false).cut === 0);
// релей на странице расшифровывает то же, что сложил мост
check("relayHash: кавычки, обратный слэш, переносы и эмодзи проходят туда-обратно",
      decodeHash(FB.relayHash({ a: 'q"uote \\ <b>&amp;</b> ✓ 😀', s: "строка\nвторая" }, false).hash).p.a === 'q"uote \\ <b>&amp;</b> ✓ 😀');

// ---- реальный HTML от Bing через прокси (сохранён ранее, если жив) ---------------
try {
  const real = require("fs").readFileSync("/tmp/r_bing.html", "utf8");
  const rr = FB.parseBingHtml(real);
  check("parseBingHtml на реальном HTML", rr.length >= 5, "items=" + rr.length);
} catch(e){ console.log("(реальный /tmp/r_bing.html недоступен — пропускаю)"); }

process.exit(fails ? 1 : 0);
