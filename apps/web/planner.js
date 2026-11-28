// ============================================================================
// planner.js — планировщик запросов (QueryPlan). Этап 1 «Честного поиска 2.0».
//
// Модуль стоит между строкой пользователя и открытием вкладок. Один раз
// разбирает запрос на сущности (категория, уточнения, бренд, модель, атрибуты,
// бюджет, состояние) и намерение, собирает для каждого источника свой текст
// запроса, лестницу ослабления и оценивает найденные карточки взвешенной
// релевантностью вместо подсчёта совпавших слов.
//
// Первая волна параметров (меняют только наш код, проверяются автотестом):
//   P1  якорь категории          P2  точная фраза модели
//   P3  минус-слова шума         P4  маркер покупки
//   P5  языковая пара и раскладка
//   P7  бюджет                   P9  состояние и атрибуты
//   P10 маршрут источников по намерению
//   P14 лестница ослабления      P15 взвешенная релевантность
// Вторая волна (P6, P8, P11, P12, P13) добавляет к адресам источников значения,
// эффект которых нужно измерить на живой выдаче (этап 0), — в адреса они пока
// не встраиваются. Адрес Google Shopping с фильтром цены (P7) планировщик
// строит, но страница его не открывает: он ждёт проверки этапа 0.
//
// Порт референс-прототипа (scripts/query_planner_proto.js). При переносе
// исправлены три дефекта прототипа:
//   • \b в JS-регулярках не работает с кириллицей — «велосипед б/у» не
//     распознавалось как б/у, «топ-10» как выбор; теперь границы слов явные;
//   • «27.5» резалось на «27» и «5» — десятичные числа держатся целыми;
//   • запрос «чехол для iphone» прятал все чехлы как аксессуары — правило
//     аксессуара не действует, если сам запрос про аксессуар.
// Два решения для намерений «выбрать» и «изучить»: вопрос пользователя ищется
// как написан (слова «какой», «выбрать» не выбрасываются), а бонус площадки
// не участвует в оценке — обзоры для этих намерений нужный результат.
//
// UMD: браузер (window.FSPlanner, после filter-core.js) и Node (тесты).
// ============================================================================
(function(root){
"use strict";

var FC = (typeof window !== "undefined" && window.FilterCore) ||
         (typeof require !== "undefined" ? require("./filter-core.js") : null);
if (!FC) throw new Error("planner.js: сначала загрузите filter-core.js");

// словарь категорий и уточнений — общий с filter-core.js ([[ру-основа, en]])
var LEXICON = FC.LEXICON;
var EN_WORDS = {};
LEXICON.forEach(function(l){ l[1].split(" ").forEach(function(w){ EN_WORDS[w] = 1; }); });

// Известные бренды — только для проверки «того ли раскладки строка»: после
// замены клавиш должно получиться осмысленное слово. Для распознавания бренда
// в запросе список не нужен (бренд — первое латинское слово вне словаря).
var BRANDS = {};
("sava savadeck stels stern forward merida giant trek cube scott canyon orbea bmc bianchi " +
 "pinarello ghost haibike kona norco polygon specialized keychron akko varmilo leopold ducky " +
 "filco realforce wooting durgod apple samsung xiaomi sony lenovo asus dell hp lg nike adidas " +
 "puma reebok columbia thule logitech jbl bose huawei honor garmin casio").split(" ")
 .forEach(function(b){ BRANDS[b] = 1; });

// граница слова для кириллицы: \b в JS считает русские буквы «не-словом»
function wb(s){ return "(?:^|[^а-яёa-z0-9])" + s + "(?![а-яёa-z])"; }

var BUY_RE = new RegExp(["купить", wb("цен[аыу]"), "заказать", "в наличии", "где купить",
                         "со скидкой", "дешев", wb("buy"), wb("price"), wb("for sale"), wb("cheap")]
                        .join("|"), "i");
var CHOOSE_RE = new RegExp(["какой", "который", "лучш", "выбрать", "выбор", "отзыв", "обзор",
                            "сравни", wb("топ"), "рейтинг", "rating", wb("best"), wb("top"), wb("vs")]
                           .join("|"), "i");
var RESEARCH_RE = /как \S|почему|что такое|инструкц|настроить|ремонт|\bhow\b|\bwhat is\b|\bwhy\b/i;
var USED_RE = new RegExp([wb("б[/.\\-]?у"), wb("бу"), "с рук", "бывш\\S* в употребл", wb("used"),
                          "авито", "avito"].join("|"), "i");
var ATTR_RE = /^(\d{1,2}(?:\.\d)?|\d+\s?(gb|tb)|xl|xxl|xxs|xs)$/i;
var INFO_RE = new RegExp(["обзор", "отзыв", "отзыды", "видео", "youtube", "ютуб", "форум", "forum",
                          "распаковк", "unboxing", "инструкц", wb("manual"), wb("тест"), wb("test"),
                          "review", "сравнен", wb("vs"), "как выбрать", "рейтинг", "top\\s?\\d"]
                         .join("|"), "i");
var INFO_RE_G = new RegExp(INFO_RE.source, "gi");
var ACC_RU = /чехол|креплен|подставк|запчаст|крыло|покрышк|камера для|сиденье|седл[ао]|рем\.?комплект|педал|грипс|багажник|насос|тормоз|звонок|стабилизат/i;
// английские запчасти без оборота «for …» (его ловит FC.ACCESSORY)
var ACC_EN = /\b(pedals?|handlebars?|grips?|saddles?|stabilizers?|training wheels|kickstand)\b/i;
function isAccessoryText(raw){ return FC.ACCESSORY.test(raw) || ACC_RU.test(raw) || ACC_EN.test(raw); }

// ---- бюджет (P7) -------------------------------------------------------------
var NUM = "(\\d+(?:[.,]\\d+)?(?:[\\s\\u00a0]\\d{3})*)";
var MULT = "(тысяч|тысячи|тыс\\.?|тр|к|k)(?![а-яёa-z])";
var CUR = "(₽|руб[а-яё]*|р\\.?|\\$|долл[а-яё]*|€|евро)(?![а-яёa-z])";
var KEYWORD_RE = new RegExp("(?:^|[^а-яёa-z])(?:до|не дороже|не больше|максимум|max|за|в пределах|бюджет)\\s+" +
                            NUM + "(?:\\s*" + MULT + ")?(?:\\s*" + CUR + ")?", "i");
var MONEY_RE = new RegExp(NUM + "(?:\\s*" + MULT + ")?\\s*" + CUR, "i");
var CURFIRST_RE = /([$€])\s?(\d[\d\s\u00a0]*\d|\d)/i;
var THOUSANDS_RE = new RegExp("(?:^|[^а-яёa-z0-9])" + NUM + "\\s*" + MULT, "i");
// после «до 20» может стоять не цена: год, размер, возраст
var NOT_PRICE_RE = /^\s?(?:год[а-яё]*|лет|дюйм[а-яё]*|см|мм|кг|км|метр[а-яё]*|минут[а-яё]*|час[а-яё]*|дн[а-яё]*|недел[а-яё]*|месяц[а-яё]*|шт[а-яё]*|размер[а-яё]*|литр[а-яё]*|мл|гр|г|л|м)(?![а-яёa-z])/i;

function extractBudget(q){
  q = String(q || "");
  var m, num, mult, curWord, explicit;
  if ((m = KEYWORD_RE.exec(q))){
    var rest = q.slice(m.index + m[0].length);
    // «до 20» без «тысяч» и валюты — не бюджет: возраст, размер, год
    if (!m[2] && !m[3] && (NOT_PRICE_RE.test(rest) || Number(m[1].replace(/[\s\u00a0]/g, "")) < 1000)) m = null;
    else { num = m[1]; mult = m[2]; curWord = m[3]; explicit = true; }
  }
  if (!m && (m = CURFIRST_RE.exec(q))){ num = m[2]; mult = null; curWord = m[1]; explicit = true; }
  if (!m && (m = MONEY_RE.exec(q))){ num = m[1]; mult = m[2]; curWord = m[3]; explicit = true; }
  if (!m && (m = THOUSANDS_RE.exec(q))){ num = m[1]; mult = m[2]; curWord = ""; explicit = false; }
  if (!m) return null;
  var amount = parseFloat(String(num).replace(/[\s\u00a0]/g, "").replace(",", ".")) * (mult ? 1000 : 1);
  amount = Math.round(amount);
  curWord = String(curWord || "").toLowerCase();
  var currency = (/^\$|долл/.test(curWord)) ? "USD" : (/^€|евро/.test(curWord)) ? "EUR" : "RUB";
  if (!(amount > 0)) return null;
  return { amount: amount, currency: currency, explicit: explicit, text: m[0].trim() };
}

// ---- раскладка (P5) ----------------------------------------------------------
var RU_KEYS = "йцукенгшщзхъфывапролджэячсмитьбю.";
var EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,./";

function normalize(q){
  return String(q || "")
    .replace(/[\u00ab\u00bb\u201e\u201c\u201d\u2018\u2019]/g, '"')
    .replace(/[\u00a0\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// «ыфмф ф7д» → «sava a7l». Замена клавиш допустима, только когда в строке нет
// ни одного словарного русского слова и КАЖДОЕ русское слово после замены
// становится осмысленным — брендом, словом словаря или моделью. Иначе
// «sava al pro отзывы» превратилось бы в «sava al pro jnpsds».
function fixLayout(q){
  if (!/[а-яё]/i.test(q)) return null;
  function mapKeys(s){
    return s.toLowerCase().split("").map(function(ch){
      var i = RU_KEYS.indexOf(ch);
      return i >= 0 ? EN_KEYS[i] : ch;
    }).join("");
  }
  var words = tokenize(q);
  var cyr = words.filter(function(t){ return /[а-яё]/.test(t); });
  if (!cyr.length) return null;
  if (cyr.some(function(t){ return lexiconHit(t); })) return null;
  var sensible = cyr.every(function(t){
    var m = mapKeys(t);
    return BRANDS[m] || EN_WORDS[m] || /^[a-z]\d[a-z0-9]*$/.test(m) || /^\d+([.,]\d+)?$/.test(m);
  });
  return sensible ? normalize(mapKeys(q)) : null;
}

// слова запроса: десятичные числа остаются целыми («27.5»), дефис внутри
// модели тоже («wh-1000xm4»), служебные слова — вне
function tokenize(s){
  return String(s || "").toLowerCase()
    .replace(/(\d)[.,](\d)/g, "$1\u0001$2")      // десятичная точка — не разделитель
    .split(/[^a-zа-яё0-9\u0001-]+/).filter(Boolean)
    .map(function(w){ return w.replace(/\u0001/g, ".").replace(/^-+|-+$/g, ""); })
    .filter(function(w){ return w.length >= 2 && FC.STOP.indexOf(w) < 0; });
}

// служебные слова покупки, бюджета и состояния: в текст запроса не попадают
var SKIP = {};
("до не дороже больше максимум за пределах бюджет тысяч тысячи тыс тр руб рубля рублей р к " +
 "куплю заказать дешево дёшево дешевле скидки скидку скидка наличии наличие доставка доставку " +
 "продам продажа продаже недорого стоимость " +
 "бу б у б-у рук руку руками бывший бывшая бывшие употреблении употребления употребляемые " +
 "авито avito used").split(" ").forEach(function(w){ SKIP[w] = 1; });

function lexiconHit(w){
  for (var i = 0; i < LEXICON.length; i++)
    if (w.indexOf(LEXICON[i][0]) === 0) return LEXICON[i];
  return null;
}

// ---- сущности ----------------------------------------------------------------
function extractEntities(q){
  q = normalize(q);
  var budget = extractBudget(q);
  var words = tokenize(budget ? normalize(q.replace(budget.text, " ")) : q);
  var ents = { category: null, categoryRu: null, categoryStem: null, modifiers: [],
               brand: null, model: null, attrs: [], budget: budget, condition: "new" };
  // 1) категория — самое длинное совпадение по словарю среди всех слов
  var best = null;
  words.forEach(function(w){
    var lex = lexiconHit(w);
    if (lex && (!best || lex[0].length > best.lex[0].length)) best = { w: w, lex: lex };
  });
  if (best){ ents.categoryRu = best.w; ents.category = best.lex[1]; ents.categoryStem = best.lex[0]; }
  // 2) всё остальное: уточнения из словаря, атрибуты, бренд, модель
  var brandSeen = false;
  words.forEach(function(w){
    if (SKIP[w] || (best && w === best.w)) return;
    var lex = lexiconHit(w);
    if (lex){ ents.modifiers.push({ ru: w, en: lex[1], stem: lex[0] }); return; }
    if (ATTR_RE.test(w)){ ents.attrs.push(w); return; }
    var latin = /^[a-z0-9.-]+$/.test(w);
    if (latin && !brandSeen && /^[a-z]{2,}$/.test(w)){ ents.brand = w; brandSeen = true; return; }
    if (latin && brandSeen){ ents.model = ents.model ? ents.model + " " + w : w; return; }
    if (latin){                                      // цифра или модель до бренда: «2026», «k2»
      if (/^\d{3,4}$/.test(w)) ents.attrs.push(w);
      else ents.model = ents.model ? ents.model + " " + w : w;
      return;
    }
    // русское слово вне словаря: уточнение, в английском запросе остаётся как есть
    ents.modifiers.push({ ru: w, en: w, stem: null });
  });
  if (USED_RE.test(q)) ents.condition = "used";
  return ents;
}

function isBuying(intent){ return intent === "buy" || intent === "used"; }

var INTENT_RU = { buy: "купить", used: "купить б/у", choose: "выбрать", research: "изучить" };

function detectIntent(q, ents){
  if (USED_RE.test(q)) return "used";
  if (BUY_RE.test(q) || ents.budget) return "buy";
  if (CHOOSE_RE.test(q)) return "choose";
  if (RESEARCH_RE.test(q)) return "research";
  if (ents.brand && (ents.model || ents.category)) return "buy";
  // «ноутбук 16gb 512gb», «кроссовки 42» — конфигурация уже выбрана, это покупка
  if (ents.category && ents.attrs.length) return "buy";
  if (ents.category) return "choose";
  return "research";
}

// ---- тексты запросов (P1–P4, P9) --------------------------------------------
var MINUS_RU = ["обзор", "отзыв", "отзывы", "youtube", "форум", "распаковка", "инструкция"];
var MINUS_EN = ["review", "reviews", "youtube", "forum", "unboxing", "manual"];
var LADDER_NAMES = ["строгий запрос", "убрать минус-слова", "убрать маркер покупки",
                    "убрать кавычки", "убрать атрибуты", "без категории и модификаторов"];

function buildQuery(ents, lang, intent, f){
  var parts = [];
  if (f.brand && ents.brand)
    parts.push(/^[a-z]+$/.test(ents.brand) ? ents.brand.toUpperCase() : ents.brand);
  if (ents.model) parts.push(f.quotes ? '"' + ents.model + '"' : ents.model);
  var cat = lang === "ru" ? ents.categoryRu : ents.category;
  if (f.category && cat) parts.push(cat);
  if (f.modifiers)
    ents.modifiers.forEach(function(m){ parts.push(lang === "ru" ? m.ru : (m.en || m.ru)); });
  if (f.attrs) ents.attrs.forEach(function(a){ parts.push(a); });
  var s = parts.join(" ");
  if (!s) return "";
  // P9: маркер состояния — только поисковикам; Авито и так б/у, Ozon — новый
  if (f.used && ents.condition === "used") s += lang === "ru" ? " б/у" : " used";
  // P4: маркер покупки и P3: минус-слова — поисковикам при покупке (нового и б/у)
  if (f.buy && isBuying(intent)) s += lang === "ru" ? " купить" : " buy";
  if (f.exclusions && isBuying(intent))
    s += " " + (lang === "ru" ? MINUS_RU : MINUS_EN).map(function(w){ return "-" + w; }).join(" ");
  return s;
}

// «рыночный» текст для площадок: без кавычек, «купить», минус-слов и маркера б/у
var MARKET_FLAGS = { brand: 1, quotes: 0, category: 1, modifiers: 1, attrs: 1, buy: 0, exclusions: 0, used: 0 };

var STRICT = { brand: 1, quotes: 1, category: 1, modifiers: 1, attrs: 1, buy: 1, exclusions: 1, used: 1 };

// P14: шаги по одному, начиная с наименее важного; неизменившиеся шаги
// пропускаются, как и шаг, после которого остаётся один маркер (« б/у»)
function buildLadder(ents, lang, intent){
  var steps = [
    Object.assign({}, STRICT),
    Object.assign({}, STRICT, { exclusions: 0 }),
    Object.assign({}, STRICT, { exclusions: 0, buy: 0 }),
    Object.assign({}, STRICT, { exclusions: 0, buy: 0, quotes: 0 }),
    Object.assign({}, STRICT, { exclusions: 0, buy: 0, quotes: 0, attrs: 0 }),
    Object.assign({}, STRICT, { exclusions: 0, buy: 0, quotes: 0, attrs: 0, category: 0, modifiers: 0 })
  ];
  var out = [];
  steps.forEach(function(f, i){
    var q = buildQuery(ents, lang, intent, f);
    if (!q || !q.replace(/ (б\/у|used)$/, "").trim()) return;
    if (!out.length || out[out.length - 1].q !== q)
      out.push({ step: out.length, name: LADDER_NAMES[i], q: q });
  });
  return out;
}

// P10: три-четыре источника по намерению вместо десяти вкладок
function routeSources(intent){
  if (intent === "used") return ["avito", "yandex", "google"];
  if (intent === "choose") return ["google", "yandex", "ddg"];
  if (intent === "research") return ["google", "ddg"];
  return ["yandex", "ozon", "google"];
}

var MARKET = { ozon: 1, avito: 1, ali: 1 };
var SERP_RU = { yandex: 1 };      // русский запрос — Яндексу, остальным поисковикам — английский

function coreBuildUrl(id, q){
  var C = (typeof window !== "undefined" && window.FSCore) ||
          (typeof require !== "undefined" ? require("./core.js") : null);
  return C ? C.buildEngineUrl(id, q) : null;
}

function buildPlan(raw){
  var norm = normalize(raw);
  var fixed = fixLayout(norm);
  var q = fixed || norm;
  var ents = extractEntities(q);
  var intent = detectIntent(q, ents);
  var phrase = normalize(ents.budget ? q.replace(ents.budget.text, " ") : q);
  var shopping = intent === "buy" || intent === "used";
  var queries, ladder;
  if (shopping){
    queries = {
      ru: buildQuery(ents, "ru", intent, STRICT),
      en: buildQuery(ents, "en", intent, STRICT),
      market: buildQuery(ents, "ru", intent, MARKET_FLAGS),
      marketEn: buildQuery(ents, "en", intent, MARKET_FLAGS)
    };
    ladder = { ru: buildLadder(ents, "ru", intent), en: buildLadder(ents, "en", intent) };
  } else {
    // «выбрать» и «изучить»: вопрос ищется как написан — «какой детский
    // велосипед выбрать», а не «велосипед детский»
    queries = { ru: phrase, en: phrase,
                market: buildQuery(ents, "ru", intent, MARKET_FLAGS),
                marketEn: buildQuery(ents, "en", intent, MARKET_FLAGS) };
    ladder = { ru: [{ step: 0, name: "исходный запрос", q: phrase }],
               en: [{ step: 0, name: "исходный запрос", q: phrase }] };
  }
  var sources = routeSources(intent);
  var urls = {};
  sources.forEach(function(id){ urls[id] = coreBuildUrl(id, engineQuery({ queries: queries, ladder: ladder }, id, 0)); });
  var plan = {
    raw: String(raw == null ? "" : raw), normalized: norm, layoutFixed: fixed, phrase: phrase,
    intent: intent, intentRu: INTENT_RU[intent], entities: ents,
    queries: queries, ladder: ladder, sources: sources, urls: urls, shoppingUrl: null,
    // запрос про сам аксессуар (чехол, кабель) — правило аксессуара не применяется
    accessoryQuery: !!(ents.categoryRu && (ACC_RU.test(ents.categoryRu) || FC.ACCESSORY.test(ents.category)))
  };
  // P7: фильтр цены в Google Shopping — адрес строится, но открывается только
  // после проверки этапа 0 (эффект параметра tbs на живой выдаче не измерен)
  if (ents.budget && shopping)
    plan.shoppingUrl = "https://www.google.com/search?q=" + encodeURIComponent(queries.market) +
      "&tbm=shop&tbs=mr:1,price:1,ppr_min:0,ppr_max:" + ents.budget.amount;
  return plan;
}

// текст запроса для источника на шаге лестницы: площадкам — короткий «рыночный»
// запрос без кавычек, минус-слов и «купить», поисковикам — свой диалект
function engineQuery(plan, id, step){
  if (!plan) return null;
  if (MARKET[id]) return plan.queries.market;
  var lad = SERP_RU[id] ? plan.ladder.ru : plan.ladder.en;
  if (!lad.length) return null;
  var st = lad[Math.max(0, Math.min(step || 0, lad.length - 1))];
  return st ? st.q : null;
}

function engineUrl(plan, id, step){
  var q = engineQuery(plan, id, step);
  return q ? coreBuildUrl(id, q) : null;
}

// ---- взвешенная релевантность (P15) ------------------------------------------
var WEIGHTS = { brand: 3, model: 3, attr: 2, attrCap: 4, modifier: 1, category: 1,
                infoNoise: -4, infoNoiseCap: -6, noPrice: -1,
                trusted: 2, inBudget: 1, mainRatio: 0.6, similarRatio: 0.35, mainMin: 3 };

function has(t, s){ return (" " + s + " ").indexOf(" " + t + " ") >= 0; }
// фраза модели: «al pro» находит и «AL Pro», и «ALPRO», и «AL-Pro»; «wh-1000xm4» — «WH 1000XM4»
function squeeze(s){ return String(s || "").toLowerCase().replace(/[^a-zа-яё0-9]+/g, ""); }
function phraseIn(phrase, title){
  if (!phrase) return false;
  if (has(phrase, title)) return true;
  var p = squeeze(phrase);
  return p.length >= 3 && squeeze(title).indexOf(p) >= 0;
}
// слово или основа словаря среди слов названия: «детск» → «детские», «bike» → «bikes»
function wordIn(word, toks, stem){
  if (!word) return false;
  if (stem && toks.some(function(t){ return t.indexOf(stem) === 0; })) return true;
  if (toks.indexOf(word) >= 0) return true;
  return word.length >= 4 && toks.some(function(t){ return t.indexOf(word) === 0; });
}
function termIn(term, toks, stem){
  if (!term) return false;
  if (term.indexOf(" ") >= 0) return phraseIn(term, toks.join(" "));
  return wordIn(term, toks, stem);
}

function maxPossible(plan){
  var e = plan.entities, w = WEIGHTS, buying = isBuying(plan.intent);
  var m = 0;
  if (e.brand) m += w.brand;
  if (e.model) m += w.model;
  if (e.category) m += w.category;
  m += w.modifier * e.modifiers.length;
  if (e.attrs.length) m += w.attrCap;
  if (buying) m += w.trusted;
  if (e.budget && buying) m += w.inBudget;
  return Math.max(m, 1);
}

// три жёстких правила скрывают карточку независимо от баллов: нет бренда из
// запроса, аксессуар или запчасть вместо товара, другая модель того же бренда
// (аксессуар проверяем раньше модели: «педали для SAVA» — это запчасть, а не
// «другая модель»; причина в отчёте должна называть настоящую проблему)
function scoreOffer(plan, offer){
  var e = plan.entities, w = WEIGHTS, buying = isBuying(plan.intent);
  var raw = String(offer.title || "");
  var title = FC.normText(raw);
  var toks = title ? title.split(" ") : [];
  var why = [], score = 0;
  var max = maxPossible(plan);
  function verdictOf(v, reason){ return { score: score, max: max, verdict: v, reason: reason, why: why }; }
  // обзор при намерении «купить» может не пройти и по жёсткому правилу (нет слов
  // модели) — причина называет и то, и другое
  var noisy = buying && INFO_RE.test(raw) ? "; к тому же это обзор или видео, а не предложение" : "";

  if (e.brand && !has(e.brand, title)) return verdictOf("hidden", "нет бренда запроса («" + e.brand + "»)" + noisy);
  if (!plan.accessoryQuery && isAccessoryText(raw))
    return verdictOf("hidden", "аксессуар или запчасть, а не сам товар" + noisy);
  if (e.model && !phraseIn(e.model, title))
    return verdictOf("hidden", "другая модель бренда (нет «" + e.model + "»)" + noisy);
  if (e.brand){ score += w.brand; why.push("бренд +" + w.brand); }
  if (e.model){ score += w.model; why.push("модель +" + w.model); }
  if (e.category){
    if (termIn(e.categoryRu, toks, e.categoryStem) || termIn(e.category, toks, null)){
      score += w.category; why.push("категория +" + w.category);
    } else why.push("категория +0");
  }
  e.modifiers.forEach(function(m){
    if (termIn(m.ru, toks, m.stem) || termIn(m.en, toks, null)){
      score += w.modifier; why.push("уточнение «" + m.ru + "» +" + w.modifier);
    }
  });
  var attrHits = 0;
  e.attrs.forEach(function(a){ if (has(FC.normText(a), title)) attrHits++; });
  if (attrHits){ var as = Math.min(attrHits * w.attr, w.attrCap); score += as; why.push("атрибуты +" + as); }

  // информационный шум штрафуется только при намерении «купить»: для
  // «выбрать» и «изучить» обзоры — нужный результат
  var infoPen = 0;
  if (buying && INFO_RE.test(raw)){
    infoPen = Math.max((raw.match(INFO_RE_G) || []).length * w.infoNoise, w.infoNoiseCap);
    score += infoPen; why.push("информационный шум " + infoPen);
  }
  var trusted = !!offer.trusted;
  if (trusted && buying){ score += w.trusted; why.push("площадка или карточка товара +" + w.trusted); }

  var overBudget = 0;
  if (offer.price && e.budget && e.budget.currency === offer.currency){
    if (offer.price <= e.budget.amount){
      if (buying){ score += w.inBudget; why.push("в бюджете +" + w.inBudget); }
    } else {
      overBudget = Math.round((offer.price - e.budget.amount) / e.budget.amount * 100);
      why.push("дороже бюджета на " + overBudget + "%");
    }
  } else if (!offer.price && buying && !trusted){
    score += w.noPrice; why.push("нет цены " + w.noPrice);
  }

  var ratio = score / max;
  var mainMin = buying ? w.mainMin : 0;
  var verdict = "hidden", reason = "ниже порога похожих";
  if (ratio >= w.mainRatio && score >= mainMin){ verdict = "main"; reason = ""; }
  else if (ratio >= w.similarRatio){ verdict = "similar"; reason = ""; }
  // бюджет — почти жёсткое условие: дороже заданного не бывает «основной» карточкой
  if (verdict === "main" && overBudget > 0){ verdict = "similar"; reason = "дороже бюджета на " + overBudget + "%"; }
  if (verdict === "hidden"){
    if (infoPen < 0) reason = "обзор, видео или форум, а не предложение товара";
    else if (overBudget > 0) reason = "дороже бюджета на " + overBudget + "%";
    else reason = "мало совпадений с запросом: " + score + " из " + max + " баллов" +
                  (why.length ? " (" + why.join(", ") + ")" : "");
  }
  return verdictOf(verdict, reason);
}

// ---- обучение по первой выдаче (P12, вторая волна): частые атрибуты названий --
var TYPE_WORDS = ["mtb", "carbon", "карбоновый", "mountain", "горный", "шоссейный", "дорожный", "складной"];
function learnFromTitles(titles){
  var counts = {};
  (titles || []).forEach(function(t){
    t = String(t).replace(/(\d)[.,](\d)/g, "$1\u0001$2");
    var nums = (t.match(/\b\d{1,2}(?:\u0001\d)?\b/g) || []).map(function(x){ return x.replace("\u0001", "."); });
    nums.concat(FC.normText(t.replace(/\u0001/g, ".")).split(" ").filter(function(x){
      return TYPE_WORDS.indexOf(x) >= 0;
    })).forEach(function(tok){ counts[tok] = (counts[tok] || 0) + 1; });
  });
  return Object.keys(counts).map(function(k){ return { token: k, count: counts[k] }; })
    .sort(function(a, b){ return b.count - a.count || a.token.localeCompare(b.token); });
}

// ---- «наш» ли запрос у отчёта вкладки ----------------------------------------
function qnorm(s){
  return String(s || "").toLowerCase().replace(/["«»„“”‘’]/g, " ").replace(/\s+/g, " ").trim();
}
function isKnownQuery(plan, text){
  if (!plan || !text) return false;
  var t = qnorm(text);
  if (!t) return false;
  var known = [plan.raw, plan.normalized, plan.layoutFixed, plan.phrase,
               plan.queries.ru, plan.queries.en, plan.queries.market, plan.queries.marketEn]
    .concat(plan.ladder.ru.map(function(s){ return s.q; }), plan.ladder.en.map(function(s){ return s.q; }));
  for (var i = 0; i < known.length; i++) if (qnorm(known[i]) === t) return true;
  // поисковик мог переписать запрос (убрать кавыки, переставить слова):
  // сравниваем слова без операторов — не менее 70 % слов отчёта должны быть из плана
  var bag = {};
  tokenize(known.join(" ").replace(/(^|\s)-[^\s]+/g, " ")).forEach(function(w){ bag[w] = 1; });
  var tw = tokenize(String(text).replace(/(^|\s)-[^\s]+/g, " "));
  if (!tw.length) return false;
  var hit = tw.filter(function(w){ return bag[w]; }).length;
  return hit / tw.length >= 0.7;
}

// ---- журнал: план строками для страницы и отчёта ------------------------------
function describePlan(plan){
  var e = plan.entities, out = [];
  out.push(["намерение", plan.intentRu]);
  if (plan.layoutFixed) out.push(["раскладка", "«" + plan.normalized + "» → «" + plan.layoutFixed + "»"]);
  var ents = [];
  if (e.category) ents.push("категория: " + e.categoryRu + " / " + e.category);
  if (e.modifiers.length)
    ents.push("уточнения: " + e.modifiers.map(function(m){ return m.en && m.en !== m.ru ? m.ru + " / " + m.en : m.ru; }).join(", "));
  if (e.brand) ents.push("бренд: " + e.brand);
  if (e.model) ents.push("модель: " + e.model);
  if (e.attrs.length) ents.push("атрибуты: " + e.attrs.join(", "));
  if (e.budget) ents.push("бюджет: " + e.budget.amount + " " + e.budget.currency + " («" + e.budget.text + "»)");
  if (e.condition === "used") ents.push("состояние: б/у");
  out.push(["разбор запроса", ents.length ? ents.join(" · ") : "сущности не распознаны"]);
  if (isBuying(plan.intent)){
    out.push(["Яндекс", plan.queries.ru]);
    out.push(["Google и остальные поисковики", plan.queries.en]);
    out.push(["площадки", plan.queries.market]);
    out.push(["лестница ослабления", plan.ladder.ru.length + " шагов: " +
      plan.ladder.ru.map(function(s){ return s.step + " — " + s.name; }).join(" · ")]);
  } else {
    out.push(["запрос как написан", plan.queries.ru]);
  }
  out.push(["источники", plan.sources.join(", ")]);
  if (plan.shoppingUrl) out.push(["Google Shopping (проверка этапа 0)", plan.shoppingUrl]);
  return out;
}

// ---- этап 0: тридцать контрольных запросов ------------------------------------
// По десять запросов вида «бренд модель» и с бюджетом или атрибутами, по пять
// про б/у и про выбор. Состав набора — рабочий: документ задаёт структуру.
var CONTROL_QUERIES = [
  { kind: "brand-model", q: "велосипед sava al pro" },
  { kind: "brand-model", q: "sava a7l carbon road bike" },
  { kind: "brand-model", q: "велосипед stels navigator 500" },
  { kind: "brand-model", q: "велосипед merida big nine 20" },
  { kind: "brand-model", q: "горный велосипед giant talon" },
  { kind: "brand-model", q: "клавиатура keychron k2" },
  { kind: "brand-model", q: "механическая клавиатура varmilo va87" },
  { kind: "brand-model", q: "наушники sony wh-1000xm4" },
  { kind: "brand-model", q: "ноутбук lenovo thinkpad t14" },
  { kind: "brand-model", q: "рюкзак thule subterra" },
  { kind: "budget-attr", q: "детский велосипед до 20 тысяч" },
  { kind: "budget-attr", q: "велосипед до 30 тысяч рублей" },
  { kind: "budget-attr", q: "ноутбук до 50 тысяч" },
  { kind: "budget-attr", q: "наушники до 100 долларов" },
  { kind: "budget-attr", q: "механическая клавиатура до 10 тыс" },
  { kind: "budget-attr", q: "велосипед sava 29" },
  { kind: "budget-attr", q: "ноутбук 16gb 512gb" },
  { kind: "budget-attr", q: "кроссовки 42" },
  { kind: "budget-attr", q: "iphone 15 pro 256gb" },
  { kind: "budget-attr", q: "велосипед 27.5 карбоновый" },
  { kind: "used", q: "велосипед б/у" },
  { kind: "used", q: "купить б/у ноутбук" },
  { kind: "used", q: "sava a7l бу" },
  { kind: "used", q: "горный велосипед с рук" },
  { kind: "used", q: "велосипед бу до 15 тысяч" },
  { kind: "choose", q: "какой детский велосипед выбрать" },
  { kind: "choose", q: "лучший карбоновый велосипед" },
  { kind: "choose", q: "механическая клавиатура рейтинг" },
  { kind: "choose", q: "sava al pro отзывы" },
  { kind: "choose", q: "велосипед stels или stern что лучше" }
];

var Planner = {
  buildPlan: buildPlan, scoreOffer: scoreOffer, maxPossible: maxPossible,
  engineQuery: engineQuery, engineUrl: engineUrl, isKnownQuery: isKnownQuery,
  learnFromTitles: learnFromTitles, describePlan: describePlan,
  extractBudget: extractBudget, extractEntities: extractEntities, detectIntent: detectIntent,
  normalize: normalize, fixLayout: fixLayout, tokenize: tokenize,
  WEIGHTS: WEIGHTS, INTENT_RU: INTENT_RU, INFO_RE: INFO_RE, LADDER_NAMES: LADDER_NAMES,
  CONTROL_QUERIES: CONTROL_QUERIES, MARKET: MARKET, MINUS_RU: MINUS_RU, MINUS_EN: MINUS_EN
};

if (typeof module !== "undefined" && module.exports) module.exports = Planner;
else root.FSPlanner = Planner;
})(typeof window !== "undefined" ? window : globalThis);
