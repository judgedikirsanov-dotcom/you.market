// ============================================================================
// planner_tests.js — офлайн-тесты планировщика запросов (этап 1 «Честного
// поиска 2.0»). Проверяют план по примерам предложения, таблицу бюджета,
// раскладку, три жёстких правила и веса оценки, маршрут источников и все
// тридцать контрольных запросов этапа 0. Сеть не нужна.
//   node tests/planner_tests.js   → «ВСЕ ТЕСТЫ ПЛАНИРОВЩИКА ЗЕЛЁНЫЕ»
// ============================================================================
"use strict";
var FP = require("../planner.js");

var passed = 0, failed = 0;
function ok(cond, name, extra){
  if (cond){ passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}
function enc(s){ return encodeURIComponent(s); }
function offer(title, o){
  var x = { title: title, url: "https://shop.example.com/" + encodeURIComponent(title),
            price: 30000, currency: "RUB", available: true, trusted: true };
  Object.keys(o || {}).forEach(function(k){ x[k] = o[k]; });
  return x;
}
var MINUS_RU = " -обзор -отзыв -отзывы -youtube -форум -распаковка -инструкция";
var MINUS_EN = " -review -reviews -youtube -forum -unboxing -manual";

console.log("== план по примерам предложения ==");
(function(){
  var p = FP.buildPlan("велосипед sava al pro");
  ok(p.intent === "buy", "«велосипед sava al pro» → купить");
  ok(p.entities.brand === "sava" && p.entities.model === "al pro", "бренд SAVA, модель al pro");
  ok(p.entities.categoryRu === "велосипед" && p.entities.category === "bike", "категория: велосипед / bike");
  ok(p.queries.ru === 'SAVA "al pro" велосипед купить' + MINUS_RU, "Яндекс: " + p.queries.ru);
  ok(p.queries.en === 'SAVA "al pro" bike buy' + MINUS_EN, "Google: " + p.queries.en);
  ok(p.queries.market === "SAVA al pro велосипед", "площадки: " + p.queries.market);
  ok(p.ladder.ru.length === 5 && p.ladder.en.length === 5, "лестница: 5 шагов (" + p.ladder.ru.length + ")");
  ok(p.sources.join(",") === "yandex,ozon,google", "источники: " + p.sources.join(", "));
  ok(p.shoppingUrl === null, "без бюджета адреса Google Shopping нет");

  var p2 = FP.buildPlan("sava al pro");
  ok(p2.ladder.ru.length === 4, "«sava al pro» → лестница из 4 шагов (" + p2.ladder.ru.length + ")");

  var p3 = FP.buildPlan("детский велосипед до 20 тысяч");
  ok(p3.entities.budget && p3.entities.budget.amount === 20000 && p3.entities.budget.currency === "RUB",
     "бюджет: 20 000 RUB");
  ok(p3.queries.ru === "велосипед детский купить" + MINUS_RU, "Яндекс: " + p3.queries.ru);
  ok(p3.queries.en === "bike kids buy" + MINUS_EN, "Google: " + p3.queries.en);
  ok(p3.queries.market === "велосипед детский", "площадки: " + p3.queries.market);
  ok(p3.ladder.ru.length === 3, "лестница: 3 шага (" + p3.ladder.ru.length + ")");
  ok(p3.sources.join(",") === "yandex,ozon,google", "источники: " + p3.sources.join(", "));
  ok(p3.shoppingUrl === "https://www.google.com/search?q=" + enc("велосипед детский") +
     "&tbm=shop&tbs=mr:1,price:1,ppr_min:0,ppr_max:20000", "Google Shopping с фильтром цены: " + p3.shoppingUrl);

  var p4 = FP.buildPlan("ыфмф ф7д");
  ok(p4.layoutFixed === "sava a7l", "раскладка: «ыфмф ф7д» → «sava a7l»");
  ok(p4.queries.ru === 'SAVA "a7l" купить' + MINUS_RU, "Яндекс: " + p4.queries.ru);
})();

console.log("== намерения и маршрут источников (P10) ==");
(function(){
  ok(FP.buildPlan("велосипед б/у").intent === "used", "«велосипед б/у» → купить б/у");
  ok(FP.buildPlan("велосипед б/у").sources.join(",") === "avito,yandex,google", "б/у: Авито, Яндекс, Google");
  var pu = FP.buildPlan("горный велосипед с рук");
  ok(pu.intent === "used", "«с рук» → б/у");
  ok(pu.queries.ru === "велосипед горный б/у купить" + MINUS_RU, "«с рук», Яндекс: " + pu.queries.ru);
  ok(pu.queries.en === "bike mountain used buy" + MINUS_EN, "«с рук», Google: " + pu.queries.en);
  ok(pu.queries.market === "велосипед горный", "«с рук», площадки: " + pu.queries.market);
  ok(!/ рук/.test(pu.queries.ru) && !/б\/у| рук/.test(pu.queries.market), "«с рук» не попадает в текст запроса");
  var pb = FP.buildPlan("sava a7l бу");
  ok(pb.intent === "used" && pb.layoutFixed === null, "«sava a7l бу» → б/у, раскладку не трогаем");
  ok(pb.queries.market === "SAVA a7l", "«бу» не попадает в рыночный запрос: " + pb.queries.market);
  ok(pb.ladder.ru.length === 4, "«sava a7l бу»: лестница из 4 шагов (" + pb.ladder.ru.length + ")");
  ok(pb.ladder.ru[3].q === "SAVA a7l б/у", "последний шаг держит маркер б/у: " + pb.ladder.ru[3].q);

  var pc = FP.buildPlan("какой детский велосипед выбрать");
  ok(pc.intent === "choose", "«какой детский велосипед выбрать» → выбрать");
  ok(pc.queries.ru === "какой детский велосипед выбрать" && pc.queries.en === pc.queries.ru,
     "выбрать: вопрос ищется как написан");
  ok(pc.sources.join(",") === "google,yandex,ddg", "выбрать: Google, Яндекс, DuckDuckGo");
  ok(pc.ladder.ru.length === 1 && pc.ladder.ru[0].name === "исходный запрос", "выбрать: один шаг лестницы");

  var pr = FP.buildPlan("почему велосипед скрипит");
  ok(pr.intent === "research" && pr.sources.join(",") === "google,ddg", "«почему …» → изучить: Google, DuckDuckGo");

  ok(FP.buildPlan("детский велосипед").intent === "choose", "голая категория → выбрать");
  ok(FP.buildPlan("ноутбук 16gb 512gb").intent === "buy", "категория с атрибутами → купить");
  ok(FP.buildPlan("велосипед stels или stern что лучше").intent === "choose", "«что лучше» → выбрать");
})();

console.log("== бюджет (P7) ==");
(function(){
  var cases = [
    ["детский велосипед до 20 тысяч", 20000, "RUB", true],
    ["велосипед до 30 тысяч рублей", 30000, "RUB", true],
    ["ноутбук до 50 тысяч", 50000, "RUB", true],
    ["наушники до 100 долларов", 100, "USD", true],
    ["механическая клавиатура до 10 тыс", 10000, "RUB", true],
    ["велосипед бу до 15 тысяч", 15000, "RUB", true],
    ["планшет не дороже 25 000", 25000, "RUB", true],
    ["iphone за 80000 руб", 80000, "RUB", true],
    ["наушники $100", 100, "USD", true],
    ["велосипед до 20,5 тысяч", 20500, "RUB", true],
    ["монитор 20 тысяч", 20000, "RUB", false],
    ["велосипед до 20 дюймов", null],
    ["велосипед до 20", null],
    ["велосипед 3 года", null],
    ["велосипед 27.5 карбоновый", null],
    ["клавиатура 87 клавиш", null]
  ];
  cases.forEach(function(c){
    var b = FP.extractBudget(c[0]);
    if (c[1] == null) ok(b === null, "«" + c[0] + "» → без бюджета");
    else ok(b && b.amount === c[1] && b.currency === c[2] && b.explicit === c[3],
            "«" + c[0] + "» → " + c[1] + " " + c[2]);
  });
  var p = FP.buildPlan("наушники $100");
  ok(p.intent === "buy" && !/100|\$/.test(p.queries.market), "цена убрана из текста запроса: " + p.queries.market);
})();

console.log("== раскладка (P5) и атрибуты (P9) ==");
(function(){
  ok(FP.fixLayout("велосипед sava") === null, "русские слова есть — раскладку не трогаем");
  ok(FP.fixLayout("ыфмф") === "sava", "«ыфмф» → «sava»");
  ok(FP.fixLayout("мшзщк") === null, "«мшзщк» не бренд и не слово словаря — без замены");
  ok(FP.fixLayout("sava al pro отзывы") === null, "«sava al pro отзывы» — раскладка верная, без замены");
  var p = FP.buildPlan("велосипед 27.5 карбоновый");
  ok(p.entities.attrs.join(",") === "27.5", "атрибут «27.5» остался целым");
  ok(p.queries.ru === "велосипед карбоновый 27.5 купить" + MINUS_RU, "Яндекс: " + p.queries.ru);
  ok(p.queries.en === "bike carbon 27.5 buy" + MINUS_EN, "Google: " + p.queries.en);
  var m = FP.buildPlan("наушники sony wh-1000xm4");
  ok(m.entities.model === "wh-1000xm4", "модель с дефисом: " + m.entities.model);
  var r = FP.scoreOffer(m, offer("Sony WH-1000XM4 беспроводные наушники"));
  ok(r.verdict === "main", "«WH-1000XM4» в названии находится: " + r.verdict + " " + r.reason);
})();

console.log("== оценка карточек (P15): жёсткие правила и веса ==");
(function(){
  var p = FP.buildPlan("велосипед sava al pro");
  var max = FP.maxPossible(p);
  ok(max === 9, "максимум баллов: бренд 3 + модель 3 + категория 1 + площадка 2 = " + max);

  var a = FP.scoreOffer(p, offer("Велосипед SAVA AL Pro 27.5 карбоновый"));
  ok(a.verdict === "main" && a.score === 9, "SAVA AL Pro, площадка: " + a.score + "/" + a.max + " → основная");
  var b = FP.scoreOffer(p, offer("Велосипед SAVA AL Pro 27.5", { trusted: false, price: null }));
  ok(b.verdict === "main" && b.score === 6, "то же из выдачи без цены: " + b.score + "/" + b.max + " → основная");
  var b2 = FP.scoreOffer(p, offer("Велосипед SAVA AL Pro 27.5", { trusted: false }));
  ok(b2.verdict === "main" && b2.score === 7, "то же из магазина с ценой: " + b2.score + "/" + b2.max + " → основная");
  var b3 = FP.scoreOffer(p, offer("SAVA AL Pro 27.5", { trusted: false, price: null }));
  ok(b3.verdict === "similar" && b3.score === 5, "без слова «велосипед» и без цены: " + b3.score + "/" + b3.max + " → похожая");
  var c = FP.scoreOffer(p, offer("Stels Navigator 500 D 26"));
  ok(c.verdict === "hidden" && /нет бренда/.test(c.reason), "Stels при запросе SAVA скрыт: " + c.reason);
  var d = FP.scoreOffer(p, offer("Велосипед SAVA A7L Carbon"));
  ok(d.verdict === "hidden" && /другая модель/.test(d.reason), "SAVA A7L при запросе AL Pro скрыт: " + d.reason);
  var e = FP.scoreOffer(p, offer("Чехол для велосипеда SAVA AL Pro"));
  ok(e.verdict === "hidden" && /аксессуар/.test(e.reason), "чехол скрыт: " + e.reason);
  // запчасть без слов модели — причина «аксессуар», а не «другая модель»
  var e2 = FP.scoreOffer(p, offer("Педали для велосипеда SAVA", { trusted: true, priceVia: "market" }));
  ok(e2.verdict === "hidden" && /аксессуар/.test(e2.reason), "педали SAVA без слов модели скрыты как аксессуар: " + e2.reason);
  var d2 = FP.scoreOffer(p, offer("Карбоновый велосипед SAVA Z1"));
  ok(d2.verdict === "hidden" && /другая модель/.test(d2.reason), "SAVA Z1 при запросе AL Pro — другая модель: " + d2.reason);
  var f = FP.scoreOffer(p, offer("SAVA AL Pro — обзор и отзывы владельцев"));
  ok(f.verdict === "hidden" && /обзор/.test(f.reason), "обзор при покупке скрыт: " + f.reason + " (" + f.score + ")");
  var j = FP.scoreOffer(p, offer("Велосипед SAVA AL-Pro 27.5"));
  ok(j.verdict === "main", "«AL-Pro» слитно тоже находится: " + j.verdict);

  var ps = FP.buildPlan("велосипед stels");
  var low = FP.scoreOffer(ps, offer("Stels", { trusted: false, price: null }));
  ok(low.verdict === "hidden" && /мало совпадений/.test(low.reason), "низкий балл: " + low.score + "/" + low.max + " → " + low.reason);

  // аксессуар в самом запросе: правило аксессуара не работает
  var k = FP.buildPlan("чехол для iphone");
  ok(k.accessoryQuery === true, "«чехол для iphone» — запрос про аксессуар");
  var l = FP.scoreOffer(k, offer("Чехол для iPhone 15 Pro силиконовый"));
  ok(l.verdict !== "hidden", "чехол не спрятан правилом аксессуара: " + l.verdict + " (" + l.reason + ")");
  ok(p.accessoryQuery === false, "«велосипед sava al pro» — не запрос про аксессуар");

  // шум только для «купить»: для «выбрать» обзор — нужный результат
  var m = FP.buildPlan("sava al pro отзывы");
  var n = FP.scoreOffer(m, offer("SAVA AL Pro — отзывы владельцев", { trusted: false, price: null }));
  ok(m.intent === "choose" && n.verdict === "main", "обзор для «выбрать» — основная карточка: " + n.score + "/" + n.max + " → " + n.verdict);
})();

console.log("== бюджет в оценке ==");
(function(){
  var p = FP.buildPlan("детский велосипед до 20 тысяч");
  var inb = FP.scoreOffer(p, offer("Детский велосипед Stels 14", { price: 15000 }));
  ok(inb.verdict === "main" && inb.why.some(function(x){ return /в бюджете/.test(x); }), "15 000 ₽ в бюджете → основная");
  var over = FP.scoreOffer(p, offer("Детский велосипед Stels Flyte 20", { price: 25000 }));
  ok(over.verdict === "similar" && over.reason === "дороже бюджета на 25%", "25 000 ₽ → похожая: " + over.reason);
  var cur = FP.scoreOffer(p, offer("Kids bike Trek Precaliber", { price: 300, currency: "USD" }));
  ok(!/бюджет/.test(cur.why.join(" ")), "другая валюта с бюджетом не сравнивается");
  var sh = FP.buildPlan("велосипед sava al pro");
  ok(FP.scoreOffer(sh, offer("Велосипед SAVA AL Pro", { price: 99999 })).verdict === "main", "без бюджета цена не влияет");
})();

console.log("== адреса источников и «наш» запрос ==");
(function(){
  var p = FP.buildPlan("велосипед sava al pro");
  ok(FP.engineUrl(p, "yandex", 0) === "https://yandex.ru/search/?text=" + enc(p.queries.ru), "Яндекс: строгий русский запрос");
  ok(FP.engineUrl(p, "google", 0) === "https://www.google.com/search?q=" + enc(p.queries.en), "Google: английский запрос");
  ok(FP.engineUrl(p, "ozon", 0) === "https://www.ozon.ru/search/?text=" + enc("SAVA al pro велосипед"), "Ozon: рыночный запрос");
  ok(FP.engineUrl(p, "avito", 0) === "https://www.avito.ru/all?q=" + enc("SAVA al pro велосипед"), "Авито: рыночный запрос");
  ok(FP.engineQuery(p, "yandex", 1) === 'SAVA "al pro" велосипед купить', "шаг 1 без минус-слов");
  ok(FP.engineQuery(p, "yandex", 2) === 'SAVA "al pro" велосипед', "шаг 2 без «купить»");
  ok(FP.engineQuery(p, "yandex", 3) === "SAVA al pro велосипед", "шаг 3 без кавычек");
  ok(FP.engineQuery(p, "yandex", 4) === "SAVA al pro", "шаг 4 без категории");
  ok(FP.engineQuery(p, "yandex", 9) === "SAVA al pro", "за пределами лестницы — последний шаг");
  ok(FP.engineUrl(p, "bing", 0) === "https://www.bing.com/search?q=" + enc(p.queries.en) + "&count=30", "Bing: английский запрос, count сохранён");
  ok(FP.engineQuery(p, "ozon", 3) === "SAVA al pro велосипед", "площадки от лестницы не зависят");

  ok(FP.isKnownQuery(p, "велосипед sava al pro"), "исходная строка — наш запрос");
  ok(FP.isKnownQuery(p, p.queries.ru), "строгий запрос — наш");
  ok(FP.isKnownQuery(p, "SAVA al pro велосипед"), "переписанный поисковиком запрос — наш");
  ok(FP.isKnownQuery(p, 'SAVA "al pro" велосипед купить'), "запрос с кавычками — наш");
  ok(!FP.isKnownQuery(p, "купить iphone 15"), "чужой запрос не наш");
  ok(!FP.isKnownQuery(p, ""), "пустой запрос не наш");
  var u = FP.buildPlan("велосипед бу до 15 тысяч");
  ok(FP.isKnownQuery(u, "велосипед б/у купить"), "б/у с наклонной чертой — наш");
})();

console.log("== журнал и обучение ==");
(function(){
  var d = FP.describePlan(FP.buildPlan("детский велосипед до 20 тысяч"));
  var labels = d.map(function(x){ return x[0]; });
  ok(labels.indexOf("намерение") === 0 && labels.indexOf("источники") >= 0, "журнал: " + labels.join(" · "));
  ok(/бюджет: 20000 RUB/.test(d.map(function(x){ return x[1]; }).join(" ")), "журнал показывает бюджет");
  var t = FP.learnFromTitles(["SAVA A7L Carbon 27.5", "SAVA A7L 29er MTB", "SAVA A7L 27.5 MTB"]);
  ok(t[0].count === 2 && t[0].token === "27.5", "частые атрибуты: " + JSON.stringify(t.slice(0, 2)));
})();

console.log("== этап 0: тридцать контрольных запросов ==");
(function(){
  var kinds = { "brand-model": "buy", "budget-attr": "buy", used: "used", choose: "choose" };
  var counts = {};
  FP.CONTROL_QUERIES.forEach(function(c){
    var p = FP.buildPlan(c.q);
    counts[c.kind] = (counts[c.kind] || 0) + 1;
    ok(p.intent === kinds[c.kind], "«" + c.q + "» → " + p.intentRu + "; Яндекс: " + p.queries.ru);
    var all = [p.queries.ru, p.queries.en, p.queries.market];
    ok(all.every(function(q){ return q && q.length >= 2; }), "«" + c.q + "»: все три текста запроса непустые");
    ok(p.sources.every(function(id){ return !!p.urls[id]; }), "«" + c.q + "»: адреса всех источников построены");
    ok(p.ladder.ru.length === p.ladder.en.length && p.ladder.ru.length >= 1, "«" + c.q + "»: лестница " + p.ladder.ru.length + " шагов в обоих языках");
    var uniq = {};
    ok(p.ladder.ru.every(function(s){ if (uniq[s.q]) return false; uniq[s.q] = 1; return true; }),
       "«" + c.q + "»: шаги лестницы не повторяются");
    if (p.intent !== "choose")
      ok(!/до |тысяч|тыс\b|руб|доллар|\$/.test(all.join(" | ")), "«" + c.q + "»: слова бюджета не попали в запрос");
    if (p.intent === "used")
      ok(/б\/у/.test(p.queries.ru) && / used/.test(p.queries.en) && !/б\/у| used|купить/.test(p.queries.market),
         "«" + c.q + "»: маркер б/у в поисковиках и без него на площадках");
  });
  ok(counts["brand-model"] === 10 && counts["budget-attr"] === 10 && counts.used === 5 && counts.choose === 5,
     "состав: 10 + 10 + 5 + 5 = " + FP.CONTROL_QUERIES.length);
})();

console.log("");
if (failed){ console.log("ПРОВАЛЕНО: " + failed); process.exit(1); }
console.log("ВСЕ ТЕСТЫ ПЛАНИРОВЩИКА ЗЕЛЁНЫЕ (" + passed + " проверок)");
