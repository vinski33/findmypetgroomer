(function () {
  'use strict';

  var REVEAL_DELAY_MS = 150; // intentional dwell while fully covered — not a completion guess
  var REVEAL_FALLBACK_MS = 1500;
  var BUBBLE_COUNT = 450;
  var FLAG = 'bubbleWipeCover';
  var SPECS_KEY = 'bubbleWipeSpecs';
  var MAX_DPR = 2;
  var SIZE_BUCKETS = 16;
  var SPRITE_SCALE = 2; // supersample sprites so downscaling them stays crisp

  var navigating = false;

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

  function clamp01(t) {
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function easeInCubic(t) {
    return t * t * t;
  }

  // resting-state properties only (position/size/travel) — shared across the
  // navigation boundary so the incoming page's covered frame matches the
  // outgoing page's last frame exactly, with no reshuffle.
  function generateSpecs(count) {
    var specs = [];
    for (var i = 0; i < count; i++) {
      specs.push({
        left: rand(0, 100),
        size: biasedRand(5, 130, 2.4),
        rise: rand(55, 100),
        drift: rand(-60, 60)
      });
    }
    return specs;
  }

  // A small set of pre-rendered bubble bitmaps, bucketed by size. Drawing a
  // few hundred bubbles a frame by re-computing a radial gradient and
  // stroking a path for each one is real per-frame work; blitting a
  // pre-rendered sprite with drawImage is not, so this is what keeps a high
  // bubble count smooth instead of reintroducing the stutter.
  var spriteSheet = null;
  function getSpriteSheet() {
    if (spriteSheet) return spriteSheet;
    spriteSheet = [];
    for (var i = 0; i < SIZE_BUCKETS; i++) {
      var t = i / (SIZE_BUCKETS - 1);
      var size = 5 + t * (130 - 5);
      var px = Math.max(2, Math.ceil(size * SPRITE_SCALE));
      var c = document.createElement('canvas');
      c.width = px;
      c.height = px;
      var sctx = c.getContext('2d');
      var r = px / 2;
      var g = sctx.createRadialGradient(r - r * 0.4, r - r * 0.44, r * 0.05, r, r, r);
      g.addColorStop(0, 'rgba(255,255,255,0.8)');
      g.addColorStop(0.32, 'rgba(255,255,255,0.3)');
      g.addColorStop(0.58, 'rgba(255,255,255,0.08)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      sctx.fillStyle = g;
      sctx.beginPath();
      sctx.arc(r, r, Math.max(0, r - 1), 0, Math.PI * 2);
      sctx.fill();
      sctx.lineWidth = SPRITE_SCALE;
      sctx.strokeStyle = 'rgba(255,255,255,0.35)';
      sctx.stroke();
      spriteSheet.push({ size: size, canvas: c });
    }
    return spriteSheet;
  }

  function pickSprite(sheet, size) {
    var best = sheet[0];
    var bestDiff = Math.abs(sheet[0].size - size);
    for (var i = 1; i < sheet.length; i++) {
      var diff = Math.abs(sheet[i].size - size);
      if (diff < bestDiff) {
        best = sheet[i];
        bestDiff = diff;
      }
    }
    return best;
  }

  function Overlay(specs) {
    this.specs = specs;

    this.el = document.createElement('div');
    this.el.className = 'bubble-wipe';
    this.el.setAttribute('aria-hidden', 'true');

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'bw-backdrop';
    this.el.appendChild(this.backdrop);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bw-canvas';
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    document.body.appendChild(this.el);
    this._resize();

    var sheet = getSpriteSheet();
    this.sprites = specs.map(function (s) {
      return pickSprite(sheet, s.size);
    });

    // Per-bubble entrance/exit timing, randomized fresh every time an
    // overlay is built. This never needs to persist across the navigation
    // boundary: the entrance only ever plays on the outgoing page and the
    // exit only ever plays on the incoming page, so neither has to match
    // anything on the other side — only the resting position (specs) does.
    this.timing = specs.map(function () {
      return {
        delay: rand(0, 260),
        dur: rand(380, 620),
        leaveDelay: rand(0, 200),
        leaveDur: rand(380, 680)
      };
    });

    this.enterTotal = 0;
    this.leaveTotal = 0;
    for (var i = 0; i < this.timing.length; i++) {
      var tm = this.timing[i];
      this.enterTotal = Math.max(this.enterTotal, tm.delay + tm.dur);
      this.leaveTotal = Math.max(this.leaveTotal, tm.leaveDelay + tm.leaveDur);
    }

    this._raf = null;
  }

  Overlay.prototype._resize = function () {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.width = w;
    this.height = h;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  Overlay.prototype._draw = function (sprite, cx, cy, scale, opacity) {
    if (opacity <= 0.002 || scale <= 0.01) return;
    var r = (sprite.size / 2) * scale;
    var d = r * 2;
    this.ctx.globalAlpha = opacity;
    this.ctx.drawImage(sprite.canvas, cx - r, cy - r, d, d);
  };

  // Draws every bubble at its fully-covered resting position — the shared
  // handoff frame rendered identically whether we just finished entering on
  // the outgoing page, or are loading straight into it on the incoming page.
  Overlay.prototype.drawCovered = function () {
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (var i = 0; i < this.specs.length; i++) {
      var s = this.specs[i];
      var baseX = (s.left / 100) * this.width;
      var baseY = this.height * 1.08;
      var cx = baseX + s.drift;
      var cy = baseY - (s.rise / 100) * this.height;
      this._draw(this.sprites[i], cx, cy, 1, 0.9);
    }
  };

  Overlay.prototype._stopLoop = function () {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  };

  // Drives its own rAF loop rather than CSS animations, since the bubbles
  // are canvas-drawn rather than DOM elements. Completion is analytic — the
  // total duration is known up front from the per-bubble delay/duration
  // specs — so it ends exactly at the true end of motion regardless of
  // device speed, instead of guessing a fixed timeout.
  Overlay.prototype._runPhase = function (leaving, onDone) {
    var self = this;
    var start = null;
    var total = leaving ? this.leaveTotal : this.enterTotal;
    this._stopLoop();

    function frame(now) {
      if (start === null) start = now;
      var elapsed = now - start;
      var ctx = self.ctx;
      ctx.clearRect(0, 0, self.width, self.height);

      for (var i = 0; i < self.specs.length; i++) {
        var s = self.specs[i];
        var timing = self.timing[i];
        var local = elapsed - (leaving ? timing.leaveDelay : timing.delay);
        var dur = leaving ? timing.leaveDur : timing.dur;
        var t = clamp01(local / dur);
        var eased = leaving ? easeInCubic(t) : easeOutCubic(t);
        var baseX = (s.left / 100) * self.width;
        var baseY = self.height * 1.08;
        var scale, opacity, cx, cy;

        if (!leaving) {
          scale = 0.35 + 0.65 * eased;
          opacity = 0.9 * Math.min(1, eased / 0.55);
          cx = baseX + s.drift * eased;
          cy = baseY - (s.rise / 100) * self.height * eased;
        } else {
          scale = 1 - 0.25 * eased;
          opacity = 0.9 * (1 - eased);
          cx = baseX + s.drift * (1 + 0.6 * eased);
          var startCy = baseY - (s.rise / 100) * self.height;
          var fallDistance = (s.rise / 100) * self.height + self.height * 0.25;
          cy = startCy + fallDistance * eased;
        }

        self._draw(self.sprites[i], cx, cy, scale, opacity);
      }

      if (elapsed >= total) {
        self._raf = null;
        if (leaving) ctx.clearRect(0, 0, self.width, self.height);
        else self.drawCovered();
        onDone();
        return;
      }
      self._raf = requestAnimationFrame(frame);
    }

    this._raf = requestAnimationFrame(frame);
  };

  Overlay.prototype.enter = function (onDone) {
    this.el.classList.add('entering');
    this._runPhase(false, onDone);
  };

  Overlay.prototype.leave = function (onDone) {
    this.el.classList.remove('covered');
    this.el.classList.add('leaving');
    this._runPhase(true, onDone);
  };

  Overlay.prototype.showCovered = function () {
    this.el.classList.remove('entering');
    this.el.classList.add('covered');
    this.drawCovered();
  };

  Overlay.prototype.remove = function () {
    this._stopLoop();
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  };

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
    if (navigating) return; // ignore extra clicks while one transition is already in flight
    var href = a.href;
    if (reduceMotion) {
      window.location.href = href;
      return;
    }
    navigating = true;
    try {
      var specs = generateSpecs(BUBBLE_COUNT);
      var overlay = new Overlay(specs);
      requestAnimationFrame(function () {
        overlay.enter(function () {
          // Lock in the exact fully-covered frame before navigating — the
          // same frame the next page renders immediately on load, so the
          // frame across the navigation boundary matches exactly.
          overlay.showCovered();
          try {
            sessionStorage.setItem(FLAG, '1');
            sessionStorage.setItem(SPECS_KEY, JSON.stringify(specs));
          } catch (e) {}
          window.location.href = href;
        });
      });
    } catch (err) {
      window.location.href = href;
    }
  }

  document.addEventListener(
    'click',
    function (e) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!isTransitionable(a)) return;
      e.preventDefault();
      goWithTransition(a);
    },
    true
  );

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

    // Straight to the covered frame — no entrance plays here. The rise
    // already happened, visually, on the outgoing page; this page just
    // needs to render that same end state instantly.
    var overlay = new Overlay(specs);
    overlay.showCovered();

    var started = false;
    function startLeaving() {
      if (started) return;
      started = true;
      // Two rAFs guarantee the browser has actually painted the covered
      // frame at least once before we change anything, so the leave can
      // never get coalesced into the same frame as the cover.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          window.setTimeout(function () {
            overlay.leave(function () {
              overlay.remove();
            });
          }, REVEAL_DELAY_MS);
        });
      });
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
