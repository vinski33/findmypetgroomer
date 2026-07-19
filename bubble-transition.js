(function () {
  'use strict';

  var COVER_MS = 800;
  var REVEAL_DELAY_MS = 150;
  var REVEAL_FALLBACK_MS = 1500;
  var LEAVE_MS = 1000;
  var BUBBLE_COUNT = 80;
  var FLAG = 'bubbleWipeCover';
  var SPECS_KEY = 'bubbleWipeSpecs';

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  // biased toward the low end so most bubbles are small, with occasional larger ones
  function biasedRand(min, max, bias) {
    return Math.pow(Math.random(), bias) * (max - min) + min;
  }

  // resting-state properties only (position/size/travel) — shared across the
  // navigation boundary so the incoming page's covered frame matches the
  // outgoing page's last frame exactly, with no reshuffle.
  function generateSpecs(count) {
    var specs = [];
    for (var i = 0; i < count; i++) {
      specs.push({
        left: rand(0, 100),
        size: biasedRand(7, 150, 2.4),
        rise: rand(55, 100),
        drift: rand(-60, 60)
      });
    }
    return specs;
  }

  function buildOverlay(specs) {
    var overlay = document.createElement('div');
    overlay.className = 'bubble-wipe';
    overlay.setAttribute('aria-hidden', 'true');

    var backdrop = document.createElement('div');
    backdrop.className = 'bw-backdrop';
    overlay.appendChild(backdrop);

    for (var i = 0; i < specs.length; i++) {
      var s = specs[i];
      var b = document.createElement('span');
      b.className = 'bw-bubble';
      b.style.setProperty('--left', s.left.toFixed(1) + '%');
      b.style.setProperty('--size', s.size.toFixed(0) + 'px');
      b.style.setProperty('--delay', rand(0, 140).toFixed(0) + 'ms');
      b.style.setProperty('--dur', rand(420, 620).toFixed(0) + 'ms');
      b.style.setProperty('--rise', '-' + s.rise.toFixed(0) + 'vh');
      b.style.setProperty('--drift', s.drift.toFixed(0) + 'px');
      b.style.setProperty('--leave-delay', rand(0, 180).toFixed(0) + 'ms');
      b.style.setProperty('--leave-dur', rand(420, 700).toFixed(0) + 'ms');
      overlay.appendChild(b);
    }

    document.body.appendChild(overlay);
    return overlay;
  }

  function isTransitionable(a) {
    if (!a || !a.getAttribute) return false;
    if (a.target && a.target !== '' && a.target !== '_self') return false;
    if (a.hasAttribute('download') || a.hasAttribute('data-no-transition')) return false;
    var raw = a.getAttribute('href');
    if (!raw || raw.indexOf('#') === 0) return false;
    var url;
    try {
      url = new URL(a.href, window.location.href);
    } catch (e) {
      return false;
    }
    if (url.origin !== window.location.origin) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') return false;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return false;
    return true;
  }

  function goWithTransition(a) {
    var href = a.href;
    if (reduceMotion) {
      window.location.href = href;
      return;
    }
    try {
      var specs = generateSpecs(BUBBLE_COUNT);
      var overlay = buildOverlay(specs);
      requestAnimationFrame(function () {
        overlay.classList.add('active');
      });
      window.setTimeout(function () {
        try {
          sessionStorage.setItem(FLAG, '1');
          sessionStorage.setItem(SPECS_KEY, JSON.stringify(specs));
        } catch (e) {}
        window.location.href = href;
      }, COVER_MS);
    } catch (err) {
      window.location.href = href;
    }
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!isTransitionable(a)) return;
    e.preventDefault();
    goWithTransition(a);
  }, true);

  function revealIfIncoming() {
    var pending = false;
    try {
      pending = sessionStorage.getItem(FLAG) === '1';
    } catch (e) {}
    if (!pending) return;

    var specs = null;
    try {
      var raw = sessionStorage.getItem(SPECS_KEY);
      if (raw) specs = JSON.parse(raw);
    } catch (e) {}

    try {
      sessionStorage.removeItem(FLAG);
      sessionStorage.removeItem(SPECS_KEY);
    } catch (e) {}

    if (reduceMotion) return;
    if (!specs || !specs.length) specs = generateSpecs(BUBBLE_COUNT);

    var overlay = buildOverlay(specs);
    overlay.classList.add('active', 'covered');

    var started = false;
    function startLeaving() {
      if (started) return;
      started = true;
      window.setTimeout(function () {
        overlay.classList.remove('covered');
        overlay.classList.add('leaving');
        window.setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, LEAVE_MS);
      }, REVEAL_DELAY_MS);
    }

    if (document.readyState === 'complete') {
      startLeaving();
    } else {
      window.addEventListener('load', startLeaving, { once: true });
      window.setTimeout(startLeaving, REVEAL_FALLBACK_MS);
    }
  }

  if (document.body) {
    revealIfIncoming();
  } else {
    document.addEventListener('DOMContentLoaded', revealIfIncoming);
  }
})();
