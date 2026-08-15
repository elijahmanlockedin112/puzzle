/* wordsearch.js — letter-grid recovery, word-list recovery, and the finder.

   Word searches have no ruled border to lock onto, so there is no quad to warp.
   Instead every letter is a connected component and the lattice is recovered from
   blob positions: reject pen marks by colour, estimate the page tilt, cluster rows,
   fit a column pitch, then pick the densest rectangular block — which is what
   separates the grid from the title above it and the word bank below it. */
const WordSearch = (function () {
  'use strict';

  const DIRS = [
    { dr: 0, dc: 1, name: 'right' },
    { dr: 0, dc: -1, name: 'left' },
    { dr: 1, dc: 0, name: 'down' },
    { dr: -1, dc: 0, name: 'up' },
    { dr: 1, dc: 1, name: 'down-right' },
    { dr: -1, dc: -1, name: 'up-left' },
    { dr: 1, dc: -1, name: 'down-left' },
    { dr: -1, dc: 1, name: 'up-right' }
  ];

  /* ---------- shared front end ---------- */

  /* Threshold, label, and keep only the components that look like glyphs.
     Anything far off the typical glyph size is a speck, a pen circle, or the
     edge of the page — all of which we want gone before any layout work. */
  function letterBlobs(imageData, opts) {
    opts = opts || {};
    const ink = Vision.inkMask(imageData, {
      maxDim: opts.maxDim || 1100,
      winFrac: 0.05,
      C: 9,
      rejectColor: opts.rejectColor !== false,
      satThreshold: 68
    });
    // Scale the noise floor to the image: a single dark pixel of sensor noise is a
    // valid component, and there are thousands of them.
    const minArea = Math.max(6, Math.round(ink.w * ink.h / 60000));
    const { labels, comps } = Vision.components(ink.bin, ink.w, ink.h, minArea);
    if (comps.length < 12) return { error: 'too-few-marks', ink };

    // Typical glyph height. Weighted by area so leftover specks can't drag it down
    // and so page edges (pre-filtered by size) can't drag it up.
    const plausible = comps.filter(c => c.h <= ink.h * 0.25 && c.w <= ink.w * 0.25);
    const base = plausible.length >= 8 ? plausible : comps;
    const mh = Vision.weightedMedian(base.map(c => c.h), base.map(c => c.area)) || 1;

    const letters = comps.filter(c =>
      c.h >= mh * 0.42 && c.h <= mh * 1.95 &&
      c.w >= mh * 0.10 && c.w <= mh * 2.3 &&
      c.area >= c.w * c.h * 0.07 &&
      c.h <= ink.h * 0.18 && c.w <= ink.w * 0.18   // drops drawn loops and page edges
    );
    return { ink, labels, blobs: splitWideBlobs(labels, ink.w, letters), mh, allComps: comps.length };
  }

  /* Neighbouring letters often touch once thresholded, and a merged pair reads as
     one wrong glyph ("LA" comes back as "M"). Anything far wider than a typical
     glyph gets cut at the thinnest columns near the expected boundaries. */
  function splitWideBlobs(labels, imgW, letters) {
    const mw = Vision.median(letters.map(c => c.w)) || 1;
    const out = [];
    for (const b of letters) {
      const k = Math.round(b.w / mw);
      if (k < 2 || b.w < mw * 1.55) { out.push(b); continue; }

      const prof = new Int32Array(b.w);
      for (let y = b.miny; y <= b.maxy; y++) {
        const row = y * imgW;
        for (let x = 0; x < b.w; x++) if (labels[row + b.minx + x] === b.id) prof[x]++;
      }
      const cuts = [0];
      const span = Math.max(1, Math.round(mw * 0.3));
      for (let i = 1; i < k; i++) {
        const nominal = Math.round(b.w * i / k);
        let bestX = nominal, bestV = Infinity;
        for (let x = Math.max(1, nominal - span); x <= Math.min(b.w - 2, nominal + span); x++) {
          if (prof[x] < bestV) { bestV = prof[x]; bestX = x; }
        }
        cuts.push(bestX);
      }
      cuts.push(b.w);

      for (let i = 0; i + 1 < cuts.length; i++) {
        const x0 = cuts[i], x1 = cuts[i + 1];
        if (x1 - x0 < 2) continue;
        let area = 0, sx = 0, sy = 0, minY = b.maxy, maxY = b.miny;
        for (let y = b.miny; y <= b.maxy; y++) {
          const row = y * imgW;
          for (let x = x0; x < x1; x++) {
            if (labels[row + b.minx + x] !== b.id) continue;
            area++; sx += b.minx + x; sy += y;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        if (area < 4) continue;
        out.push({
          id: b.id, minx: b.minx + x0, maxx: b.minx + x1 - 1, miny: minY, maxy: maxY,
          w: x1 - x0, h: maxY - minY + 1, area, cx: sx / area, cy: sy / area
        });
      }
    }
    return out;
  }

  function deskew(blobs, mh) {
    const rad = Vision.estimateSkew(blobs, mh);
    for (const b of blobs) {
      const p = Vision.rotatePoint(b.cx, b.cy, rad);
      b.rx = p[0]; b.ry = p[1];
      const lo = Vision.rotatePoint(b.minx, b.cy, rad);
      const hi = Vision.rotatePoint(b.maxx, b.cy, rad);
      b.lx = lo[0]; b.hx = hi[0];
    }
    return rad;
  }

  function clusterRows(blobs, mh, tol) {
    const sorted = blobs.slice().sort((a, b) => a.ry - b.ry);
    const rows = [];
    let cur = [sorted[0]], anchor = sorted[0].ry, sum = sorted[0].ry;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].ry - anchor > mh * (tol || 0.6)) {
        rows.push(cur);
        cur = [sorted[i]]; sum = sorted[i].ry; anchor = sum;
      } else {
        cur.push(sorted[i]); sum += sorted[i].ry; anchor = sum / cur.length;
      }
    }
    rows.push(cur);
    rows.forEach(r => r.sort((a, b) => a.rx - b.rx));
    return rows;
  }

  function classifyBlob(labels, imgW, b, bankName) {
    const cw = b.w, chh = b.h;
    const mask = new Uint8Array(cw * chh);
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        if (labels[(b.miny + y) * imgW + b.minx + x] === b.id) mask[y * cw + x] = 1;
      }
    }
    return OCR.classifyCell({ mask, w: cw, h: chh, box: { x: 0, y: 0, w: cw, h: chh } }, bankName);
  }

  /* ---------- lattice fitting ---------- */

  /* Fit row/column combs to a set of blob centres: autocorrelation for the coarse
     spacing, then least squares for sub-pixel accuracy. `source` is which blobs to
     measure from — deliberately separate from which blobs get assigned, because the
     fit must be taken from the grid alone even while the page also holds a title
     and a word bank. */
  function latticeFit(source, mh) {
    const xs = source.map(b => b.rx), ys = source.map(b => b.ry);
    const px = Vision.estimatePitch(xs, mh * 0.7, mh * 4) || mh * 1.4;
    const py = Vision.estimatePitch(ys, mh * 0.9, mh * 4.5) || px;
    const fx = Vision.refineLattice(xs, px, Vision.latticePhase(xs, px));
    const fy = Vision.refineLattice(ys, py, Vision.latticePhase(ys, py));
    return { pitchX: fx.pitch, phaseX: fx.phase, pitchY: fy.pitch, phaseY: fy.phase };
  }

  function assignToLattice(blobs, fit) {
    for (const b of blobs) {
      const tx = (b.rx - fit.phaseX) / fit.pitchX;
      const ty = (b.ry - fit.phaseY) / fit.pitchY;
      b.col = Math.round(tx); b.row = Math.round(ty);
      b.res = Math.abs(tx - b.col) + Math.abs(ty - b.row);
    }
  }

  function occupancy(blobs, resMax) {
    const rows = blobs.map(b => b.row), cols = blobs.map(b => b.col);
    const minRow = Math.min.apply(null, rows), maxRow = Math.max.apply(null, rows);
    const minCol = Math.min.apply(null, cols), maxCol = Math.max.apply(null, cols);
    const R = maxRow - minRow + 1, C = maxCol - minCol + 1;
    if (R < 3 || C < 3 || R > 90 || C > 90) return null;
    const occ = [];
    for (let r = 0; r < R; r++) occ.push(new Array(C).fill(null));
    for (const b of blobs) {
      if (b.res > resMax) continue;
      const r = b.row - minRow, c = b.col - minCol;
      if (!occ[r][c] || b.area > occ[r][c].area) occ[r][c] = b;
    }
    return { occ, R, C, minRow, minCol };
  }

  /* The grid is the longest consecutive band of rows that are both nearly full and
     sitting tightly on the lattice. Word-bank text lands on the lattice by luck
     often enough to fake the first test, but never the second. */
  function pickBand(occ, resGate, fillFrac) {
    const counts = occ.map(s => s.filter(Boolean).length);
    const residual = occ.map(s => {
      const hits = s.filter(Boolean);
      return hits.length ? hits.reduce((t, b) => t + b.res, 0) / hits.length : 1;
    });
    const peak = Math.max.apply(null, counts);
    if (peak < 4) return null;
    const scores = counts.map((n, i) => (residual[i] <= resGate ? n : 0));
    const run = Vision.longestRun(scores, Math.max(4, peak * fillFrac));
    return run.len >= 3 ? run : null;
  }

  /* ---------- the letter grid ---------- */

  function extractGrid(imageData) {
    const pre = letterBlobs(imageData, { rejectColor: true });
    if (pre.error) return { error: pre.error, grid: [], conf: [] };
    const { ink, labels, blobs, mh } = pre;
    if (blobs.length < 25) return { error: 'not-enough-letters', grid: [], conf: [], debug: { blobs: blobs.length } };

    const skew = deskew(blobs, mh);

    /* Coarse pass: fit from everything just to find roughly where the grid is. */
    let fit = latticeFit(blobs, mh);
    assignToLattice(blobs, fit);
    let o = occupancy(blobs, 0.5);
    if (!o) return { error: 'no-lattice', grid: [], conf: [] };
    let run = pickBand(o.occ, 0.32, 0.55);
    if (!run) return { error: 'no-grid-rows', grid: [], conf: [] };

    /* Fine pass: re-measure the lattice from the grid's own letters only. Fitting
       across the whole page lets 30 px word-bank line spacing drag the row pitch,
       and half a pixel of drift becomes a whole row by the bottom of the grid. */
    const seed = blobs.filter(b => {
      const r = b.row - o.minRow;
      return b.res <= 0.35 && r >= run.start && r < run.start + run.len;
    });
    if (seed.length >= 20) {
      const fineFit = latticeFit(seed, mh);
      assignToLattice(blobs, fineFit);
      const fineOcc = occupancy(blobs, 0.4);
      const fineRun = fineOcc && pickBand(fineOcc.occ, 0.18, 0.7);
      if (fineOcc && fineRun) {
        // Adopt the refined lattice and its band together — the band's indices are
        // only meaningful against the occupancy grid they were measured on.
        fit = fineFit; o = fineOcc; run = fineRun;
      } else {
        assignToLattice(blobs, fit);   // fine pass didn't hold up; restore the coarse one
      }
    }

    /* Trim the edges of the band. A real grid row has a blob in essentially every
       slot even where the reader can't name the letter; a word-bank line that
       happened to clear the gate is patchy. Only the ends are considered, so an
       interior row with a genuine gap is never dropped. */
    let from = run.start, to = run.start + run.len - 1;
    const fillOf = i => o.occ[i].filter(Boolean).length;
    const typical = Vision.median(
      o.occ.slice(run.start, run.start + run.len).map(s => s.filter(Boolean).length)
    );
    while (to > from && fillOf(to) < typical * 0.9) to--;
    while (from < to && fillOf(from) < typical * 0.9) from++;
    const rowRun = { start: from, len: to - from + 1 };
    if (rowRun.len < 3 || rowRun.start + rowRun.len > o.R) {
      return { error: 'no-grid-rows', grid: [], conf: [] };
    }
    const band = o.occ.slice(rowRun.start, rowRun.start + rowRun.len);

    const colScores = [];
    for (let c = 0; c < o.C; c++) {
      let n = 0;
      for (const s of band) if (s[c]) n++;
      colScores.push(n);
    }
    const colRun = Vision.longestRun(colScores, Math.max(2, band.length * 0.55));
    if (colRun.len < 3) return { error: 'no-grid-columns', grid: [], conf: [] };
    const pitchX = fit.pitchX, pitchY = fit.pitchY;

    const grid = [], conf = [];
    let recognized = 0;
    for (const slots of band) {
      const gRow = [], cRow = [];
      for (let c = colRun.start; c < colRun.start + colRun.len; c++) {
        const b = slots[c];
        if (!b) { gRow.push('?'); cRow.push(0); continue; }
        const r = classifyBlob(labels, ink.w, b, OCR.LETTERS);
        gRow.push(r.ch || '?');
        cRow.push(r.conf);
        if (r.ch) recognized++;
      }
      grid.push(gRow);
      conf.push(cRow);
    }

    const total = grid.length * colRun.len;
    return {
      grid, conf,
      rows: grid.length, cols: colRun.len,
      recognized, total,
      blobs: blobs.length,
      skewDeg: skew * 180 / Math.PI,
      pitch: pitchX,
      debug: { ink, labels, occ: o.occ, band: rowRun, colRun, mh, pitchX, pitchY }
    };
  }

  /* ---------- the word list ---------- */

  /* A separate photo of the word bank. Same front end, but instead of a lattice we
     split each text line into words on the large gaps. Two- and three-column banks
     fall out of the same rule, since a column gap is just a very large gap. */
  function extractWords(imageData) {
    const pre = letterBlobs(imageData, { rejectColor: true, maxDim: 1200 });
    if (pre.error) return { error: pre.error, words: [] };
    const { ink, labels, blobs, mh } = pre;
    if (blobs.length < 4) return { error: 'no-text', words: [] };

    deskew(blobs, mh);
    const lines = clusterRows(blobs, mh, 0.55);

    const tokens = [];
    for (const line of lines) {
      const gaps = [];
      for (let i = 1; i < line.length; i++) gaps.push(Math.max(0, line[i].lx - line[i - 1].hx));
      const typical = Vision.trimmedMedian(gaps, 0.1, 0.65);
      const breakAt = Math.max(mh * 0.42, typical * 2.4 + 1);

      let cur = [];
      const flush = () => { if (cur.length >= 2) tokens.push(cur); cur = []; };
      for (let i = 0; i < line.length; i++) {
        if (i > 0 && (line[i].lx - line[i - 1].hx) > breakAt) flush();
        cur.push(line[i]);
      }
      flush();
    }

    const words = [];
    for (const tok of tokens) {
      let text = '', sum = 0;
      for (const b of tok) {
        const r = classifyBlob(labels, ink.w, b, OCR.MIXED);
        text += r.ch || '?';
        sum += r.conf;
      }
      const solid = text.replace(/\?/g, '').length;
      if (solid >= 2 && solid >= text.length * 0.5) {
        words.push({ text, conf: sum / tok.length });
      }
    }
    return { words, lines: lines.length, blobs: blobs.length };
  }

  /* ---------- the finder ---------- */

  function normalizeWord(w) {
    return w.toUpperCase().replace(/[^A-Z]/g, '');
  }

  /* '?' in the grid matches anything, so a few unreadable cells don't wipe out every
     word passing through them. Cells the reader was unsure of are treated the same
     way when a confidence grid is supplied — a letter it only half-believes should
     not be allowed to veto a word. Among all valid placements we keep the one
     relying on the fewest wildcards, so a clean match always beats a guessed one. */
  function solve(grid, words, conf) {
    const t0 = performance.now();
    const G = grid.map(r => (typeof r === 'string' ? r.split('') : r.slice())
      .map(ch => (ch || '?').toUpperCase()));
    const R = G.length, C = R ? G[0].length : 0;
    const soft = (r, c) => conf && conf[r] && conf[r][c] != null && conf[r][c] < 0.5;
    const found = [], missing = [];

    for (const raw of words) {
      const word = normalizeWord(raw);
      if (word.length < 2) continue;
      const maxFuzzy = Math.max(1, Math.floor(word.length * 0.4));
      let best = null;

      for (let r = 0; r < R; r++) {
        for (let c = 0; c < C; c++) {
          const first = G[r][c];
          if (first !== '?' && first !== word[0] && !soft(r, c)) continue;
          for (const d of DIRS) {
            const endR = r + d.dr * (word.length - 1);
            const endC = c + d.dc * (word.length - 1);
            if (endR < 0 || endR >= R || endC < 0 || endC >= C) continue;
            let ok = true, fuzzy = 0;
            for (let i = 0; i < word.length; i++) {
              const rr = r + d.dr * i, cc = c + d.dc * i;
              const ch = G[rr][cc];
              if (ch === word[i]) continue;
              if (ch === '?' || soft(rr, cc)) {
                if (++fuzzy > maxFuzzy) { ok = false; break; }
                continue;
              }
              ok = false; break;
            }
            if (!ok) continue;
            if (word.length - fuzzy < 2) continue;
            if (!best || fuzzy < best.fuzzy) {
              best = { word: String(raw).trim(), letters: word, r, c, dr: d.dr, dc: d.dc, dir: d.name, fuzzy };
              if (!fuzzy) break;
            }
          }
          if (best && !best.fuzzy) break;
        }
        if (best && !best.fuzzy) break;
      }
      if (best) found.push(best); else missing.push(String(raw).trim());
    }
    return { found, missing, timeMs: performance.now() - t0, rows: R, cols: C };
  }

  return { extractGrid, extractWords, solve, DIRS, normalizeWord, letterBlobs, deskew, clusterRows };
})();
