/* vision.js — dependency-free computer vision primitives.
   Everything here runs on plain typed arrays. No libraries, no network. */
const Vision = (function () {
  'use strict';

  /* ---------- basics ---------- */

  function gray(imageData) {
    const { data, width: w, height: h } = imageData;
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; p < g.length; i += 4, p++) {
      g[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
    return { data: g, w, h };
  }

  // Box-average downscale so the pipeline cost stays flat regardless of camera size.
  function resize(img, maxDim) {
    const { data, w, h } = img;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    if (scale >= 1) return img;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    const out = new Uint8ClampedArray(nw * nh);
    const sx = w / nw, sy = h / nh;
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.min(h, Math.ceil((y + 1) * sy));
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.min(w, Math.ceil((x + 1) * sx));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) { sum += data[yy * w + xx]; n++; }
        }
        out[y * nw + x] = n ? (sum / n) | 0 : 0;
      }
    }
    return { data: out, w: nw, h: nh };
  }

  function integral(img) {
    const { data, w, h } = img;
    const W = w + 1;
    const I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += data[y * w + x];
        I[(y + 1) * W + (x + 1)] = I[y * W + (x + 1)] + row;
      }
    }
    return I;
  }

  /* Mean-C adaptive threshold. Returns Uint8Array where 1 = ink (dark). */
  function adaptiveThreshold(img, winFrac, C) {
    const { data, w, h } = img;
    const I = integral(img);
    const W = w + 1;
    const r = Math.max(3, Math.floor(Math.min(w, h) * (winFrac || 0.05)));
    const bin = new Uint8Array(w * h);
    const c = C == null ? 8 : C;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = I[(y1 + 1) * W + (x1 + 1)] - I[y0 * W + (x1 + 1)]
                  - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
        bin[y * w + x] = data[y * w + x] < sum / area - c ? 1 : 0;
      }
    }
    return bin;
  }

  function otsu(values) {
    const hist = new Float64Array(256);
    for (let i = 0; i < values.length; i++) hist[values[i]]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  /* ---------- connected components (8-connectivity) ---------- */

  function components(bin, w, h, minArea) {
    const labels = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    const all = [];
    for (let i = 0; i < bin.length; i++) {
      if (bin[i] !== 1 || labels[i] !== -1) continue;
      const id = all.length;
      let sp = 0;
      stack[sp++] = i;
      labels[i] = id;
      let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, area = 0, sx = 0, sy = 0;
      while (sp > 0) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        area++; sx += x; sy += y;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if ((!dx && !dy) || nx < 0 || nx >= w) continue;
            const np = ny * w + nx;
            if (bin[np] === 1 && labels[np] === -1) { labels[np] = id; stack[sp++] = np; }
          }
        }
      }
      all.push({
        id, minx, miny, maxx, maxy, area,
        cx: sx / area, cy: sy / area,
        w: maxx - minx + 1, h: maxy - miny + 1
      });
    }
    return { labels, comps: minArea ? all.filter(c => c.area >= minArea) : all };
  }

  /* Extreme-point corners of a blob: TL/TR/BR/BL. */
  function quadFromComponent(labels, w, comp) {
    let tl = null, tr = null, br = null, bl = null;
    let minSum = Infinity, maxSum = -Infinity, maxDiff = -Infinity, minDiff = Infinity;
    for (let y = comp.miny; y <= comp.maxy; y++) {
      for (let x = comp.minx; x <= comp.maxx; x++) {
        if (labels[y * w + x] !== comp.id) continue;
        const s = x + y, d = x - y;
        if (s < minSum) { minSum = s; tl = [x, y]; }
        if (s > maxSum) { maxSum = s; br = [x, y]; }
        if (d > maxDiff) { maxDiff = d; tr = [x, y]; }
        if (d < minDiff) { minDiff = d; bl = [x, y]; }
      }
    }
    return (tl && tr && br && bl) ? [tl, tr, br, bl] : null;
  }

  /* 0..1 score: how much does this quad look like a photographed square grid? */
  function quadQuality(q, imgW, imgH) {
    if (!q) return 0;
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const sides = [d(q[0], q[1]), d(q[1], q[2]), d(q[2], q[3]), d(q[3], q[0])];
    const min = Math.min.apply(null, sides), max = Math.max.apply(null, sides);
    if (min < 20) return 0;
    const balance = min / max;                       // near 1 for a square-ish quad
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      area += q[i][0] * q[j][1] - q[j][0] * q[i][1];
    }
    area = Math.abs(area) / 2;
    const coverage = area / (imgW * imgH);
    const covScore = coverage < 0.06 ? coverage / 0.06 : Math.min(1, (1 - coverage) / 0.25 + 0.25);
    return Math.max(0, Math.min(1, balance * balance * covScore));
  }

  /* ---------- perspective warp ---------- */

  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      const t = M[col]; M[col] = M[piv]; M[piv] = t;
      const p = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= p;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (!f) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map(row => row[n]);
  }

  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    const h = solveLinear(A, b);
    if (!h) return null;
    h.push(1);
    return h;
  }

  function sample(img, x, y) {
    const { data, w, h } = img;
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x > w - 1) x = w - 1; if (y > h - 1) y = h - 1;
    const x0 = x | 0, y0 = y | 0;
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = data[y0 * w + x0], b = data[y0 * w + x1];
    const c = data[y1 * w + x0], d = data[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /* Straighten the quad into an S×S square image. */
  function warpSquare(img, corners, S) {
    const square = [[0, 0], [S, 0], [S, S], [0, S]];
    const H = homography(square, corners); // square -> source, so we can inverse-map directly
    if (!H) return null;
    const out = new Uint8ClampedArray(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const den = H[6] * x + H[7] * y + 1;
        const u = (H[0] * x + H[1] * y + H[2]) / den;
        const v = (H[3] * x + H[4] * y + H[5]) / den;
        out[y * S + x] = sample(img, u, v) | 0;
      }
    }
    return { data: out, w: S, h: S };
  }

  /* ---------- grid cell extraction ---------- */

  /* Cut an S×S warped grid into n×n cells and isolate the glyph in each.
     Returns per cell: { mask, w, h, box, ink } with mask 1 = ink, box tight around the glyph. */
  function gridCells(warped, n, marginFrac) {
    const S = warped.w;
    const step = S / n;
    const m = Math.round(step * (marginFrac == null ? 0.14 : marginFrac));
    const cells = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x0 = Math.round(c * step) + m, y0 = Math.round(r * step) + m;
        const x1 = Math.round((c + 1) * step) - m, y1 = Math.round((r + 1) * step) - m;
        const cw = x1 - x0, ch = y1 - y0;
        const sub = new Uint8ClampedArray(cw * ch);
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) sub[y * cw + x] = warped.data[(y0 + y) * S + x0 + x];
        }
        const thr = otsu(sub);
        const bin = new Uint8Array(cw * ch);
        for (let i = 0; i < sub.length; i++) bin[i] = sub[i] < thr - 6 ? 1 : 0;

        // Keep only the biggest blob that doesn't hug the cell border (drops leftover grid lines).
        const { labels, comps } = components(bin, cw, ch, 6);
        let best = null;
        for (const comp of comps) {
          const touches = comp.minx <= 0 || comp.miny <= 0 || comp.maxx >= cw - 1 || comp.maxy >= ch - 1;
          if (touches) continue;
          if (!best || comp.area > best.area) best = comp;
        }
        // Too small to be a real digit = a speck, or pencilled candidate notes.
        if (!best || best.area < cw * ch * 0.012 || best.h < ch * 0.34) {
          cells.push({ mask: null, w: cw, h: ch, ink: 0 });
          continue;
        }
        const mask = new Uint8Array(cw * ch);
        for (let i = 0; i < labels.length; i++) if (labels[i] === best.id) mask[i] = 1;
        cells.push({
          mask, w: cw, h: ch,
          box: { x: best.minx, y: best.miny, w: best.w, h: best.h },
          ink: best.area / (cw * ch)
        });
      }
    }
    return cells;
  }

  /* ---------- ink extraction ---------- */

  /* Luma + saturation in one pass, both downscaled together. Saturation is what
     lets us tell printed black ink from a blue pen circle or a highlighter. */
  function channels(imageData, maxDim) {
    const { data, width: w, height: h } = imageData;
    const g = new Uint8ClampedArray(w * h);
    const s = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; p < g.length; i += 4, p++) {
      const r = data[i], gg = data[i + 1], b = data[i + 2];
      g[p] = (r * 0.299 + gg * 0.587 + b * 0.114) | 0;
      s[p] = Math.max(r, gg, b) - Math.min(r, gg, b);
    }
    return { gray: resize({ data: g, w, h }, maxDim), sat: resize({ data: s, w, h }, maxDim) };
  }

  /* opts: { maxDim, winFrac, C, rejectColor, satThreshold } */
  function inkMask(imageData, opts) {
    opts = opts || {};
    const ch = channels(imageData, opts.maxDim || 1000);
    const img = ch.gray;
    const bin = adaptiveThreshold(img, opts.winFrac || 0.045, opts.C == null ? 9 : opts.C);
    if (opts.rejectColor) {
      const thr = opts.satThreshold == null ? 68 : opts.satThreshold;
      const s = ch.sat.data;
      for (let i = 0; i < bin.length; i++) if (s[i] > thr) bin[i] = 0;
    }
    return { img, bin, w: img.w, h: img.h, sat: ch.sat };
  }

  /* ---------- robust stats & layout ---------- */

  function median(arr) {
    if (!arr.length) return 0;
    const s = Array.prototype.slice.call(arr).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Median where each value counts in proportion to its weight. Used to find the
     typical glyph height with component area as the weight: sensor noise produces
     a great many tiny blobs, and a plain median would follow them instead of the
     letters. */
  function weightedMedian(values, weights) {
    if (!values.length) return 0;
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let acc = 0;
    for (const i of order) {
      acc += weights[i];
      if (acc >= total / 2) return values[i];
    }
    return values[order[order.length - 1]];
  }

  /* Median of the middle band only — throws away specks and page-sized blobs
     before computing the "typical glyph" scale. */
  function trimmedMedian(arr, lo, hi) {
    if (!arr.length) return 0;
    const s = Array.prototype.slice.call(arr).sort((a, b) => a - b);
    const a = Math.floor(s.length * (lo == null ? 0.15 : lo));
    const b = Math.ceil(s.length * (hi == null ? 0.85 : hi));
    return median(s.slice(a, Math.max(a + 1, b)));
  }

  /* Rotation (radians) that packs blob centres into the tightest horizontal rows.
     A 4° page tilt is enough to scramble naive row clustering, so this runs first. */
  function estimateSkew(points, unit, maxDeg) {
    const limit = maxDeg == null ? 12 : maxDeg;
    const binSize = Math.max(1, unit / 3);
    let best = 0, bestScore = -1;
    for (let deg = -limit; deg <= limit; deg += 0.4) {
      const rad = deg * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const hist = new Map();
      for (let i = 0; i < points.length; i++) {
        const y = points[i].cy * cos - points[i].cx * sin;
        const k = Math.round(y / binSize);
        hist.set(k, (hist.get(k) || 0) + 1);
      }
      let score = 0;
      hist.forEach(v => { score += v * v; });
      if (score > bestScore) { bestScore = score; best = rad; }
    }
    return best;
  }

  function rotatePoint(x, y, rad) {
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return [x * cos + y * sin, y * cos - x * sin];
  }

  /* Spacing of a repeating row/column comb, by autocorrelating the 1-D histogram of
     positions. Far steadier than medianing neighbour gaps, which a single split
     glyph or noise blob throws off. Returns the smallest lag reaching 82% of the
     peak, so it locks onto the fundamental rather than a harmonic. */
  function estimatePitch(values, minLag, maxLag) {
    if (values.length < 4) return 0;
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const n = Math.ceil(hi - lo) + 1;
    if (n < 8) return 0;

    const hist = new Float64Array(n);
    for (const v of values) {
      const i = Math.round(v - lo);
      if (i >= 0 && i < n) hist[i]++;
    }
    // Light gaussian blur so near-misses still correlate.
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        s += hist[j] * Math.exp(-k * k / 2);
      }
      sm[i] = s;
    }

    const from = Math.max(2, Math.round(minLag));
    const to = Math.min(n - 2, Math.round(maxLag));
    if (to <= from) return 0;
    const score = new Float64Array(to + 1);
    let peak = 0;
    for (let lag = from; lag <= to; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += sm[i] * sm[i + lag];
      s /= (n - lag);
      score[lag] = s;
      if (s > peak) peak = s;
    }
    if (peak <= 0) return 0;
    for (let lag = from; lag <= to; lag++) if (score[lag] >= peak * 0.82) return lag;
    return 0;
  }

  /* Circular-mean phase of values modulo `pitch` — the grid's column offset. */
  function latticePhase(values, pitch) {
    let sx = 0, sy = 0;
    for (let i = 0; i < values.length; i++) {
      const a = 2 * Math.PI * (values[i] / pitch);
      sx += Math.cos(a); sy += Math.sin(a);
    }
    let phase = Math.atan2(sy, sx) / (2 * Math.PI) * pitch;
    if (phase > pitch / 2) phase -= pitch;
    return phase;
  }

  /* The autocorrelation pitch is only integer-accurate, and a half-pixel error
     compounds into a whole cell by the tenth row. So: assign indices with the rough
     pitch, least-squares fit position against index using only the inliers, repeat.
     Converges in two or three passes and drops residuals to near zero, which is what
     makes the "is this row part of the grid" test sharp. */
  function refineLattice(values, pitch, phase) {
    for (let iter = 0; iter < 4; iter++) {
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < values.length; i++) {
        const t = (values[i] - phase) / pitch;
        const k = Math.round(t);
        if (Math.abs(t - k) > 0.35) continue;
        n++; sx += k; sy += values[i]; sxx += k * k; sxy += k * values[i];
      }
      if (n < 4) break;
      const den = n * sxx - sx * sx;
      if (Math.abs(den) < 1e-9) break;
      const p = (n * sxy - sx * sy) / den;
      const ph = (sy - p * sx) / n;
      if (!isFinite(p) || !isFinite(ph) || p <= 1) break;
      const moved = Math.abs(p - pitch) + Math.abs(ph - phase);
      pitch = p; phase = ph;
      if (moved < 1e-3) break;
    }
    return { pitch, phase };
  }

  /* Longest run of consecutive indices whose score clears the bar. This is how the
     grid gets separated from a title above it or a word bank beside it. */
  function longestRun(scores, minScore) {
    let bestStart = 0, bestLen = 0, start = -1;
    for (let i = 0; i <= scores.length; i++) {
      const ok = i < scores.length && scores[i] >= minScore;
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) {
        if (i - start > bestLen) { bestLen = i - start; bestStart = start; }
        start = -1;
      }
    }
    return { start: bestStart, len: bestLen };
  }

  /* ---------- rendering helpers ---------- */

  function toCanvas(img, canvas) {
    canvas.width = img.w;
    canvas.height = img.h;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(img.w, img.h);
    for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
      out.data[p] = out.data[p + 1] = out.data[p + 2] = img.data[i];
      out.data[p + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
  }

  return {
    gray, resize, adaptiveThreshold, otsu, components,
    quadFromComponent, quadQuality, homography, warpSquare,
    gridCells, toCanvas,
    channels, inkMask, median, trimmedMedian, weightedMedian,
    estimateSkew, rotatePoint, estimatePitch, latticePhase, refineLattice, longestRun
  };
})();
