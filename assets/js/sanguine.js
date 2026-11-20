// Sanguine: redraws images as red chalk (sanguine) sketches, stroke by stroke.
//
// Post pages: after the reader has been idle for a while, every visible image
// is sketched over while the photo beneath fades to white. Any click, mouse move, key press,
// touch, scroll or resize brings the page back.
//
// Home page: hovering or focusing a post title that carries a data-sketch image
// URL sketches that image across the whole screen, over the text.
//
// Images are traced on a canvas, so only same-origin images are sketched.
(function () {
  'use strict';

  var script = document.currentScript;
  var params = new URLSearchParams(window.location.search);
  var idleSeconds = parseFloat(params.get('idle') || (script && script.dataset.idleSeconds) || '0');
  var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var canHover = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);

  var INKS = ['124,48,48', '146,60,44', '168,78,54', '104,38,36'];
  var LIGHT_INKS = ['194,108,84', '208,126,100', '182,98,78', '216,140,114'];
  // How finely images are traced: size is the longest side, in pixels, of the
  // image the strokes come from; edges is the share of the weakest edges dropped;
  // hatch is the number of hatching lines across the longest side; light and
  // dark are the shares of the image (darkest first) that get hatched and
  // cross-hatched.
  var STANDARD = { size: 720, edges: 0.72, chains: 3000, minChain: 6, hatch: 90, light: 0.3, dark: 0.1 };

  // ---------------------------------------------------------------------------
  // Analysis: image -> strokes (contours, then hatching in the dark areas).

  var sketches = {};

  function sameOrigin(src) {
    try { return new URL(src, window.location.href).origin === window.location.origin; } catch (e) { return false; }
  }

  function sketchOf(src, img, detail) {
    detail = detail || STANDARD;
    var key = src + '@' + detail.size;
    if (!sameOrigin(src)) return Promise.reject(new Error('cross-origin image'));
    if (!sketches[key]) {
      sketches[key] = new Promise(function (resolve, reject) {
        if (img && img.complete && img.naturalWidth) return resolve(img);
        var loader = new Image();
        loader.onload = function () { resolve(loader); };
        loader.onerror = reject;
        loader.src = src;
      }).then(function (image) { return analyze(image, detail); });
      sketches[key].catch(function () { delete sketches[key]; });
    }
    return sketches[key];
  }

  function percentile(values, p) {
    var sorted = Float32Array.from(values).sort();
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  }

  function blur(src, w, h) {
    var tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    var x, y, i;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        tmp[i] = (src[x > 0 ? i - 1 : i] + 2 * src[i] + src[x < w - 1 ? i + 1 : i]) / 4;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        out[i] = (tmp[y > 0 ? i - w : i] + 2 * tmp[i] + tmp[y < h - 1 ? i + w : i]) / 4;
      }
    }
    return out;
  }

  function analyze(img, detail) {
    var scale = Math.min(1, detail.size / Math.max(img.naturalWidth, img.naturalHeight));
    var w = Math.max(8, Math.round(img.naturalWidth * scale));
    var h = Math.max(8, Math.round(img.naturalHeight * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;

    var n = w * h, lum = new Float32Array(n), i;
    for (i = 0; i < n; i++) lum[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    lum = blur(blur(lum, w, h), w, h);

    var strokes = contours(lum, w, h, detail);
    var light = Math.min(percentile(lum, detail.light), 0.7);
    var dark = Math.min(percentile(lum, detail.dark), 0.45);
    var spacing = Math.max(3, Math.round(Math.max(w, h) / detail.hatch));
    strokes = strokes.concat(
      hatch(lum, w, h, light, -Math.PI / 3, spacing, 0.55),
      hatch(lum, w, h, dark, Math.PI / 6, spacing, 0.45)
    );
    return { w: w, h: h, strokes: strokes };
  }

  // Sobel edges, thinned with non-maximum suppression and traced into polylines.
  function contours(lum, w, h, detail) {
    var n = w * h, mag = new Float32Array(n), dir = new Uint8Array(n);
    var x, y, i;
    for (y = 1; y < h - 1; y++) {
      for (x = 1; x < w - 1; x++) {
        i = y * w + x;
        var tl = lum[i - w - 1], t = lum[i - w], tr = lum[i - w + 1];
        var l = lum[i - 1], r = lum[i + 1];
        var bl = lum[i + w - 1], b = lum[i + w], br = lum[i + w + 1];
        var gx = tr + 2 * r + br - tl - 2 * l - bl;
        var gy = bl + 2 * b + br - tl - 2 * t - tr;
        mag[i] = Math.sqrt(gx * gx + gy * gy);
        dir[i] = ((Math.round(Math.atan2(gy, gx) / (Math.PI / 4)) % 4) + 4) % 4;
      }
    }

    var threshold = Math.max(0.06, percentile(mag.filter(function (m) { return m > 0.01; }), detail.edges));
    var across = [[1, 0], [1, 1], [0, 1], [-1, 1]];
    var edge = new Uint8Array(n);
    for (y = 1; y < h - 1; y++) {
      for (x = 1; x < w - 1; x++) {
        i = y * w + x;
        if (mag[i] < threshold) continue;
        var d = across[dir[i]];
        if (mag[i] >= mag[i + d[1] * w + d[0]] && mag[i] >= mag[i - d[1] * w - d[0]]) edge[i] = 1;
      }
    }

    var around = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    var visited = new Uint8Array(n);

    function walk(start) {
      var path = [], cur = start, heading = -1;
      for (;;) {
        var cx = cur % w, cy = (cur - cx) / w, next = -1, nextHeading = -1;
        for (var k = 0; k < 8 && next < 0; k++) {
          // Prefer to keep going the same way: heading, heading +/- 1, +/- 2, ...
          var o = heading < 0 ? k : (heading + (k % 2 ? (k + 1) / 2 : -k / 2) + 8) % 8;
          var nx = cx + around[o][0], ny = cy + around[o][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var j = ny * w + nx;
          if (edge[j] && !visited[j]) { next = j; nextHeading = o; }
        }
        if (next < 0) return path;
        visited[next] = 1;
        path.push(next);
        cur = next;
        heading = nextHeading;
      }
    }

    var chains = [];
    for (i = 0; i < n; i++) {
      if (!edge[i] || visited[i]) continue;
      visited[i] = 1;
      var forward = walk(i), backward = walk(i);
      var chain = backward.reverse().concat([i], forward);
      if (chain.length < detail.minChain) continue;
      chains.push(chain);
    }
    chains.sort(function (a, b) { return b.length - a.length; });

    return chains.slice(0, detail.chains).map(function (chain) {
      // Subsample, then smooth away the pixel staircase with a moving average.
      var raw = [];
      for (var k = 0; k < chain.length; k += 2) raw.push(chain[k] % w, Math.floor(chain[k] / w));
      var pts = [];
      for (var p = 0; p < raw.length; p += 2) {
        var sx = 0, sy = 0, c = 0;
        for (var q = Math.max(0, p - 4); q <= Math.min(raw.length - 2, p + 4); q += 2) { sx += raw[q]; sy += raw[q + 1]; c++; }
        pts.push(sx / c + (Math.random() - 0.5) * 0.4, sy / c + (Math.random() - 0.5) * 0.4);
      }
      return { pts: pts, width: 0.9 + Math.min(1, chain.length / 120) * 0.9, alpha: 0.85 };
    });
  }

  // Parallel strokes at an angle wherever the image is darker than the threshold.
  function hatch(lum, w, h, threshold, angle, spacing, alpha) {
    var strokes = [];
    var dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
    var half = Math.sqrt(w * w + h * h) / 2, cx = w / 2, cy = h / 2;
    var maxRun = spacing * 7;
    // Uneven spacing reads as hand-made rather than ruled.
    for (var o = -half; o < half; o += spacing * (0.7 + Math.random() * 0.6)) {
      var start = null, last = null, length = 0;
      for (var t = -half; t <= half + 1; t += 1) {
        var x = cx + nx * o + dx * t, y = cy + ny * o + dy * t;
        var inside = x >= 0 && y >= 0 && x < w && y < h && lum[Math.floor(y) * w + Math.floor(x)] < threshold;
        if (inside && start && length < maxRun * (0.6 + Math.random() * 0.4)) {
          last = [x, y];
          length++;
          continue;
        }
        if (start && length >= 3) {
          var j = spacing * 0.15;
          strokes.push({
            pts: [start[0] + (Math.random() - 0.5) * j, start[1] + (Math.random() - 0.5) * j,
              last[0] + (Math.random() - 0.5) * j, last[1] + (Math.random() - 0.5) * j],
            width: 0.7 + Math.random() * 0.4,
            alpha: alpha
          });
        }
        start = inside ? [x, y] : null;
        last = start;
        length = 0;
      }
    }
    return strokes;
  }

  // ---------------------------------------------------------------------------
  // Drawing: strokes -> canvas, animated over a duration.

  var grains = null;

  // Chalk grain: ink with uneven alpha and a few gaps, like pigment on paper tooth.
  function grainPatterns(ctx, inks) {
    grains = grains || {};
    var key = inks.join('|');
    if (!grains[key]) {
      grains[key] = inks.map(function (ink) {
        var c = document.createElement('canvas');
        c.width = c.height = 64;
        var g = c.getContext('2d'), image = g.createImageData(64, 64), rgb = ink.split(',');
        for (var i = 0; i < 64 * 64; i++) {
          image.data[i * 4] = +rgb[0];
          image.data[i * 4 + 1] = +rgb[1];
          image.data[i * 4 + 2] = +rgb[2];
          image.data[i * 4 + 3] = Math.random() < 0.18 ? 20 : 120 + Math.random() * 135;
        }
        g.putImageData(image, 0, 0);
        return c;
      });
    }
    return grains[key].map(function (c) { return ctx.createPattern(c, 'repeat'); });
  }

  // Draws a sketch into a canvas of the given CSS size, over duration ms.
  // Returns a function that stops the animation.
  // style: { inks, alpha (multiplier), fine (thin lines whatever the scale) }.
  function draw(canvas, sketch, width, height, duration, style) {
    style = style || {};
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    var ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var patterns = grainPatterns(ctx, style.inks || INKS);
    var kx = canvas.width / sketch.w, ky = canvas.height / sketch.h;
    var strokes = sketch.strokes.map(function (s, index) {
      return { s: s, pattern: patterns[index % patterns.length] };
    });
    var total = 0;
    strokes.forEach(function (s) { total += s.s.pts.length / 2; });

    var si = 0, pi = 0, drawn = 0, started = null, frame = null;

    function advance(budget) {
      while (budget > 0 && si < strokes.length) {
        var stroke = strokes[si], pts = stroke.s.pts, count = pts.length / 2;
        var from = Math.max(0, pi - 1), to = Math.min(count, pi + budget);
        if (to - from >= 2) {
          ctx.globalAlpha = stroke.s.alpha * (style.alpha || 1);
          ctx.strokeStyle = stroke.pattern;
          ctx.lineWidth = stroke.s.width * dpr * (style.fine ? 0.75 : Math.max(1, Math.min(kx, ky) / dpr / 1.6));
          ctx.beginPath();
          ctx.moveTo(pts[from * 2] * kx, pts[from * 2 + 1] * ky);
          for (var k = from + 1; k < to; k++) ctx.lineTo(pts[k * 2] * kx, pts[k * 2 + 1] * ky);
          ctx.stroke();
        }
        budget -= to - pi;
        drawn += to - pi;
        pi = to;
        if (pi >= count) { si++; pi = 0; }
      }
    }

    if (!(duration > 0)) {
      advance(Infinity);
      return function () {};
    }

    function step(now) {
      if (started === null) started = now;
      var target = Math.ceil(total * Math.min(1, (now - started) / duration));
      advance(target - drawn);
      if (si < strokes.length) frame = window.requestAnimationFrame(step);
    }
    frame = window.requestAnimationFrame(step);
    return function () { window.cancelAnimationFrame(frame); };
  }

  function fadeOut(el, ms) {
    el.style.transition = 'opacity ' + ms + 'ms ease, filter ' + ms + 'ms ease';
    el.style.opacity = '0';
    el.style.filter = 'blur(2px)';
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms);
  }

  // ---------------------------------------------------------------------------
  // Post pages: sketch every visible image after the reader has been idle.

  function setupIdle() {
    if (!(idleSeconds > 0) || reducedMotion) return;

    var SKETCH_MS = 7000;
    var idleTimer = null, overlay = null, stops = [];

    function resetIdle() {
      if (overlay) restore();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(sketchPage, idleSeconds * 1000);
    }

    function visibleImages() {
      return Array.prototype.filter.call(document.images, function (img) {
        if (!img.complete || !img.naturalWidth || !sameOrigin(img.currentSrc || img.src)) return false;
        var rect = img.getBoundingClientRect();
        if (rect.width < 60 || rect.height < 60) return false;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
        var style = window.getComputedStyle(img);
        return style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
      });
    }

    function sketchPage() {
      var images = visibleImages();
      if (!images.length) return;

      overlay = document.createElement('div');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
      document.body.appendChild(overlay);

      var current = overlay;
      images.forEach(function (img) {
        var rect = img.getBoundingClientRect();
        sketchOf(img.currentSrc || img.src, img).then(function (sketch) {
          if (overlay !== current) return;
          // The sketch is drawn straight over the picture, while a white veil
          // between them fades in over the same time, so the photo gives way to
          // the drawing as it happens.
          var position = 'position:absolute;left:' + rect.left + 'px;top:' + rect.top + 'px;' +
            'width:' + rect.width + 'px;height:' + rect.height + 'px;';
          var veil = document.createElement('div');
          veil.style.cssText = position + 'background:#fff;opacity:0;transition:opacity ' + SKETCH_MS + 'ms cubic-bezier(0.3, 0.55, 0.6, 1);';
          var canvas = document.createElement('canvas');
          canvas.style.cssText = position;
          overlay.appendChild(veil);
          overlay.appendChild(canvas);
          window.requestAnimationFrame(function () { veil.style.opacity = '1'; });
          var stop = draw(canvas, sketch, rect.width, rect.height, SKETCH_MS, { fine: true });
          stops.push(stop);
        }).catch(function () {});
      });
    }

    function restore() {
      stops.forEach(function (stop) { stop(); });
      stops = [];
      fadeOut(overlay, 400);
      overlay = null;
    }

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll', 'resize'].forEach(function (type) {
      window.addEventListener(type, resetIdle, { passive: true, capture: true });
    });
    resetIdle();
  }

  // ---------------------------------------------------------------------------
  // Home page: sketch a post's image beside the list while its title is hovered.

  function setupHover() {
    var links = document.querySelectorAll('a[data-sketch]');
    if (!links.length || !canHover) return;

    var stage = document.createElement('div');
    stage.setAttribute('aria-hidden', 'true');
    stage.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.body.appendChild(stage);

    var active = null, shown = null, timer = null;

    function hide() {
      if (!shown) return;
      shown.stop();
      fadeOut(shown.frame, 500);
      shown = null;
    }

    function show(link) {
      active = link;
      clearTimeout(timer);
      timer = setTimeout(function () {
        // Full-screen sketches are traced at roughly screen resolution for fine detail.
        var detail = { size: Math.min(1100, Math.round(Math.max(window.innerWidth, window.innerHeight) * 0.75)),
          edges: 0.5, chains: 12000, minChain: 4, hatch: 170, light: 0.45, dark: 0.18 };
        sketchOf(link.dataset.sketch, null, detail).then(function (sketch) {
          if (active !== link || (shown && shown.link === link)) return;
          hide();
          // Cover the whole screen, on top of the text, cropping evenly where the
          // image's proportions differ from the window's.
          var screenW = window.innerWidth, screenH = window.innerHeight;
          var scale = Math.max(screenW / sketch.w, screenH / sketch.h);
          var width = Math.round(sketch.w * scale), height = Math.round(sketch.h * scale);
          var frame = document.createElement('div');
          frame.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
          var canvas = document.createElement('canvas');
          canvas.style.cssText = 'position:absolute;left:' + Math.round((screenW - width) / 2) + 'px;' +
            'top:' + Math.round((screenH - height) / 2) + 'px;';
          frame.appendChild(canvas);
          stage.appendChild(frame);
          shown = { link: link, frame: frame, stop: draw(canvas, sketch, width, height, reducedMotion ? 0 : 2200,
            { inks: LIGHT_INKS, alpha: 0.9, fine: true }) };
        }).catch(function () {});
      }, 80);
    }

    function leave(link) {
      if (active !== link) return;
      active = null;
      clearTimeout(timer);
      hide();
    }

    Array.prototype.forEach.call(links, function (link) {
      link.addEventListener('mouseenter', function () { show(link); });
      link.addEventListener('focus', function () { show(link); });
      link.addEventListener('mouseleave', function () { leave(link); });
      link.addEventListener('blur', function () { leave(link); });
    });
    window.addEventListener('resize', hide);
  }

  setupIdle();
  setupHover();
})();
