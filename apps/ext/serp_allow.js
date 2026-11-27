// ============================================================================
// serp_allow.js — allowlist URL поисковых выдач для моста.
// Расширение с host_permissions http/https могло бы фетчить что угодно —
// мост сознательно ограничен страницами поисковой выдачи: ни личные кабинеты,
// ни произвольные сайты. Файл грузится и importScripts'ом в service worker,
// и require'ом в тестах (guard по typeof module).
// ============================================================================
"use strict";

var SERP_ALLOW = [
  /^https:\/\/(www\.)?google\.[a-z.]{2,10}\/search\?/i,
  /^https:\/\/yandex\.[a-z.]{2,10}\/search\/\?/i,
  /^https:\/\/www\.bing\.com\/search\?/i,
  /^https:\/\/html\.duckduckgo\.com\/html\/\?/i,
  /^https:\/\/lite\.duckduckgo\.com\/lite\/\?/i,
  /^https:\/\/www\.mojeek\.com\/search\?/i,
  /^https:\/\/marginalia-search\.com\/search\?/i,
  /^https:\/\/search\.marginalia\.nu\/search\?/i
];

function serpAllowed(url){
  url = String(url || "");
  for (var i = 0; i < SERP_ALLOW.length; i++)
    if (SERP_ALLOW[i].test(url)) return true;
  return false;
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { serpAllowed: serpAllowed, SERP_ALLOW: SERP_ALLOW };
