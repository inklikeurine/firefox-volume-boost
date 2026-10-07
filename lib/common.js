/* global browser, chrome */

// Shared by the background page, the popup and the content script, and loaded
// before each of them. Only `var` and function declarations, so loading it a
// second time into the same content-script sandbox is harmless.

var API = typeof browser !== "undefined" ? browser : chrome;

// The highest level Volume Boost allows, and the default maximum.
var MAX_PERCENT = 1000;
var DEFAULT_MAX_PERCENT = 200;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

var warnedKeys = new Set();

// Each problem is logged once per page or frame, not on every occurrence.
function warnOnce(key, message, err) {
  if (warnedKeys.has(key)) {
    return;
  }
  warnedKeys.add(key);
  console.warn("[volume-boost] " + message, err && err.message ? err.message : err || "");
}
