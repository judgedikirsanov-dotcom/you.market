// ============================================================================
// filter-core.js — портированное ядро filter.js (проект filter-search), 1:1:
// те же правила «глазами обычного пользователя», тот же словарь перевода.
// Работает в трёх средах через одну UMD-обёртку:
//   • контент-скрипт расширения (serp.js / shop.js читают window.FilterCore);
//   • service worker (background.js — тут фильтр не нужен, но обёртка общая);
//   • Node (tests/ext_tests.js — офлайн-проверка тех же правил).
//
// Ничего не удаляется молча: у каждого скрытого предложения есть причина,
// у каждого показанного — пояснение, почему ему можно верить.
// ============================================================================
(function(root){
"use strict";

var STOP = ["для", "the", "a", "an", "of", "for", "and", "or", "with", "in", "on",
            "buy", "price", "cheap", "лучший", "купить", "цена"];

function normText(s){
  return String(s || "").toLowerCase().replace(/[^a-zа-яё0-9]+/gi, " ").trim();
}

function significantTerms(q){
  return normText(q).split(" ").filter(function(w){
    return w.length >= 2 && STOP.indexOf(w) < 0;
  });
}

// «Жёсткий» термин: содержит цифры (a7l, 105, r7120) или длиннее трёх букв —
// его отсутствие в названии = другой товар. Мягкий (al, pro, xl) может
// потеряться в тайтле магазина, не противореча бренду — показываем с флагом.
function isStrictToken(t){ return /\d/.test(t) || t.length > 3; }

// ---- словарь пользователя: русский запрос → английские слова каталога -------
// Основы (не целые слова) — чтобы ловить падежи: велосипед/велосипеда/велосипеду.
var LEXICON = [
  ["электровелосипед", "electric bike"], ["велосипед", "bike"], ["байк", "bike"],
  ["шоссейн", "road bike"], ["карбон", "carbon"], ["горн", "mountain"],
  ["детск", "kids"], ["подростк", "youth"], ["электросамокат", "electric scooter"],
  ["самокат", "scooter"], ["скейт", "skateboard"], ["роликов", "skates"],
  ["клавиатур", "keyboard"], ["механическ", "mechanical"], ["кейкап", "keycaps"],
  ["кроссовк", "sneakers"], ["обув", "shoes"], ["ботинк", "boots"], ["сандали", "sandals"],
  ["куртк", "jacket"], ["футболк", "t-shirt"], ["худи", "hoodie"],
  ["кофе", "coffee"], ["наушник", "headphones"], ["часы", "watch"],
  ["рюкзак", "backpack"], ["чехол", "case"], ["кабел", "cable"], ["зарядн", "charger"],
  ["стол", "desk"], ["стул", "chair"], ["кресл", "chair"], ["лампа", "lamp"],
  ["гантел", "dumbbell"], ["мыш", "mouse"], ["монитор", "monitor"], ["ноутбук", "laptop"]
].sort(function(a, b){ return b[0].length - a[0].length; });

var TRANSLIT = {
  "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z","и":"i","й":"y",
  "к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f",
  "х":"h","ц":"ts","ч":"ch","ш":"sh","щ":"sh","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"
};

function translateQuery(q){
  var words = String(q || "").toLowerCase().split(/[^a-zа-яё0-9]+/).filter(Boolean);
  var out = [], map = [];
  words.forEach(function(w){
    if (STOP.indexOf(w) >= 0) return;
    if (/^[a-z0-9]+$/.test(w)) { out.push(w); return; }
    var hit = null;
    for (var i = 0; i < LEXICON.length; i++)
      if (w.indexOf(LEXICON[i][0]) === 0) { hit = LEXICON[i][1]; break; }
    if (hit) { out.push(hit); map.push({ from: w, to: hit }); return; }
    var tr = w.split("").map(function(c){ return TRANSLIT[c] !== undefined ? TRANSLIT[c] : c; }).join("");
    out.push(tr);
    if (tr !== w) map.push({ from: w, to: tr });
  });
  return { query: out.join(" ").trim(), translated: map.length > 0, map: map };
}

var JUNK = [
  { re: /\breplica\b|\bкопи[ияя]\b|\bподделк/i, reason: "признаки подделки (replica/копия)" },
  { re: /\bfake\b|\bAAA\s*(quality)?\b|\b1:1\b|\bвосст(ан)?\.?\s*качество/i, reason: "признаки подделки (fake/AAA/1:1)" },
  { re: /\bsample\b|\bgift\s*card\b|\bподарочн(ый|ая)\s*сертификат/i, reason: "не товар (образец/сертификат)" }
];

var REFLAG = /\brefurb|восстановлен|\bused\b|б[уы]-?ш(?:ый|ая|ого)?\b/i;

// «Case Cover for X» — аксессуар для товара, а не сам товар. «…with bag» не
// трогаем — это может быть комплект.
var ACCESSORY = /\b(case|cover|bag|cable|charger|sticker|decal|adapter|holder|sleeve|pouch|protecteur|protector|tube|tire lever|manual)\b[^а-яёa-z0-9]*(\bfor\b|\bcompatible)/i;

// ---- правило 1–4: индивидуальная проверка предложения -----------------------
// termMode: "all" — все значимые слова запроса в названии (поиск площадки
//           уже отфильтровал по запросу, мы строго сверяем);
//           "any" — хотя бы одно слово (листаем каталог глазами).
// trusted — карточка не из веб-выдачи (маркетплейс/магазин/проверенная
//           страница товара): площадка сама искала по нашему запросу, поэтому
//           пропуск слова в названии не прячет её, а лишь помечает флагом.
function checkOffer(offer, terms, termMode, trusted){
  var flags = [];
  var title = normText(offer.title);

  if (!offer.title || !offer.price || offer.price <= 0 || !offer.url)
    return { keep: false, reason: "неполная карточка: нет цены или ссылки", flags: flags };

  if (!offer.available)
    return { keep: false, reason: "нет в наличии", flags: flags };

  for (var i = 0; i < JUNK.length; i++)
    if (JUNK[i].re.test(offer.title) || JUNK[i].re.test((offer.tags || []).join(" ")))
      return { keep: false, reason: JUNK[i].reason, flags: flags };

  var missing = terms.filter(function(t){
    return title.indexOf(t) < 0;
  });
  if (terms.length && missing.length && termMode !== "any"){
    if (trusted){
      // v15: «Sava AL Pro 27.5» при запросе «велосипед sava al pro» — не другой
      // товар, а ответ Ozon на тот же запрос; раньше такие карточки С ЦЕНАМИ
      // прятались целиком, и в итог оставались одни youtube-ролики с дословным
      // названием («карточки только с youtube» — отчёт пользователя)
      flags.push("в названии нет: " + missing.join(", ") +
        " — площадка искала по запросу сама; сверь модификацию вручную");
    } else {
      var missingStrict = missing.filter(isStrictToken);
      if (missingStrict.length)
        return { keep: false,
                 reason: "в названии нет: «" + missing.join(", ") + "» — другой или сопутствующий товар",
                 flags: flags };
      flags.push("в названии нет: " + missing.join(", ") +
        " — возможно, магазин пишет модель иначе; бренд и категория совпали, сверь модификацию сам");
    }
  }
  if (!trusted && terms.length && missing.length >= terms.length && termMode === "any")
    return { keep: false,
             reason: "ни одного слова запроса в названии — листал каталог мимо",
             flags: flags };

  if (ACCESSORY.test(offer.title))
    return { keep: false, reason: "аксессуар для товара (чехол/кабель/крепление), а не сам товар", flags: flags };

  if (REFLAG.test(offer.title) || REFLAG.test((offer.tags || []).join(" ")))
    flags.push("восстановленный/б-у — обычно дешевле, проверьте состояние");

  if (offer.title.split(/\s+/).length > 12)
    flags.push("SEO-название (рекламная простыня) — сверили содержимое с запросом, оно совпадает");

  return { keep: true, reason: "прошла проверку", flags: flags };
}

function median(nums){
  if (!nums.length) return 0;
  var s = nums.slice().sort(function(a, b){ return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- правило 5: цена против рынка (медиана ОТДЕЛЬНО по каждой валюте) -------
function applyPriceFilter(kept){
  var groups = {};
  kept.forEach(function(o){
    var cur = o.currency || "USD";
    (groups[cur] = groups[cur] || []).push(o);
  });
  var medians = {}, out = [], hidden = [];
  Object.keys(groups).forEach(function(cur){
    var med = median(groups[cur].map(function(o){ return o.price; }));
    medians[cur] = med;
    groups[cur].forEach(function(o){
      if (med > 0 && o.price < med * 0.5)
        hidden.push({ offer: o, reason: "цена " + o.price + " " + cur +
          " подозрительно ниже рынка (медиана " + med + " " + cur + ") — не похоже на честное предложение" });
      else {
        if (med > 0 && o.price > med * 2)
          o.flags.push("заметно дороже рынка (медиана " + med + " " + cur + ") — возможно, комплектация или наценка");
        out.push(o);
      }
    });
  });
  var main = Object.keys(medians);
  return { kept: out, hiddenByPrice: hidden, medians: medians,
           median: main.length ? medians[main.sort()[0]] : 0 };
}

function filterOffers(offers, query, opts){
  var termMode = (opts && opts.termMode) || "all";
  var trustedFn = (opts && opts.trustedFn) || null;
  var terms = significantTerms(query);
  var kept = [], hidden = [];
  offers.forEach(function(o){
    var v = checkOffer(o, terms, termMode, trustedFn ? !!trustedFn(o) : false);
    if (v.keep){ o.flags = (o.flags || []).concat(v.flags); o.explain = "проверено: цена, наличие и соответствие запросу"; kept.push(o); }
    else hidden.push({ offer: o, reason: v.reason });
  });
  var pf = applyPriceFilter(kept);
  hidden = hidden.concat(pf.hiddenByPrice);
  return {
    kept: pf.kept,
    hidden: hidden,
    median: pf.median,
    medians: pf.medians,
    terms: terms,
    stats: { total: offers.length, kept: pf.kept.length, hidden: hidden.length }
  };
}

var FilterCore = { filterOffers: filterOffers, checkOffer: checkOffer,
                   significantTerms: significantTerms, isStrictToken: isStrictToken,
                   median: median, normText: normText, translateQuery: translateQuery,
                   applyPriceFilter: applyPriceFilter,
                   STOP: STOP, JUNK: JUNK, REFLAG: REFLAG, ACCESSORY: ACCESSORY,
                   LEXICON: LEXICON };   // LEXICON — общий словарь для planner.js;
                                          // applyPriceFilter —app.js зовёт его отдельно (оценка карточек — в planner.js)

if (typeof module !== "undefined" && module.exports) module.exports = FilterCore;
else root.FilterCore = FilterCore;
})(typeof window !== "undefined" ? window : globalThis);
