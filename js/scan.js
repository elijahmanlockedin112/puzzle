/* scan.js — the pipeline that turns a photo into a puzzle.
   photo -> grayscale -> adaptive threshold -> grid blob -> corners -> perspective
   warp -> cell crops -> glyph classifier. Every step is local. */
const Scan = (function () {
  'use strict';

  /* Find the outer border of a ruled grid. Returns corners in the coordinate
     space of the (downscaled) working image, plus a 0..1 quality score. */
  function findGridQuad(imageData, workingSize) {
    const img = Vision.resize(Vision.gray(imageData), workingSize || 720);
    const bin = Vision.adaptiveThreshold(img, 0.045, 8);
    const minArea = img.w * img.h * 0.004;
    const { labels, comps } = Vision.components(bin, img.w, img.h, minArea);

    let best = null, bestScore = 0, bestQuad = null;
    for (const comp of comps) {
      const boxArea = comp.w * comp.h;
      if (boxArea < img.w * img.h * 0.05) continue;
      const aspect = comp.w / comp.h;
      if (aspect < 0.5 || aspect > 2.0) continue;
      const quad = Vision.quadFromComponent(labels, img.w, comp);
      const q = Vision.quadQuality(quad, img.w, img.h);
      const score = q * Math.sqrt(boxArea);
      if (score > bestScore) { bestScore = score; best = comp; bestQuad = quad; }
    }
    if (!bestQuad) return { img, quad: null, quality: 0 };
    return { img, quad: bestQuad, quality: Vision.quadQuality(bestQuad, img.w, img.h), comp: best };
  }

  /* Full sudoku read. Returns everything the review screen needs. */
  function sudoku(imageData) {
    const t0 = performance.now();
    const steps = [];
    const { img, quad, quality } = findGridQuad(imageData, 760);

    if (!quad || quality < 0.15) {
      steps.push({ ok: false, label: 'Grid outline', detail: 'no square grid border found' });
      return { ok: false, steps, timeMs: performance.now() - t0, reason: 'no-grid' };
    }
    steps.push({ ok: true, label: 'Grid outline detected', detail: Math.round(quality * 100) + '% confidence' });

    const S = 468; // 9 x 52 px cells
    const warped = Vision.warpSquare(img, quad, S);
    if (!warped) {
      steps.push({ ok: false, label: 'Perspective correction', detail: 'could not straighten the grid' });
      return { ok: false, steps, timeMs: performance.now() - t0, reason: 'warp-failed' };
    }
    steps.push({ ok: true, label: '9 × 9 grid squared up', detail: S + '×' + S + ' px' });

    const cells = Vision.gridCells(warped, 9, 0.13);
    const grid = [], conf = [];
    let clues = 0, confSum = 0;
    for (let r = 0; r < 9; r++) {
      const gRow = [], cRow = [];
      for (let c = 0; c < 9; c++) {
        const cell = cells[r * 9 + c];
        if (!cell.mask) { gRow.push(0); cRow.push(1); continue; }
        const res = OCR.classifyCell(cell, OCR.DIGITS);
        const digit = parseInt(res.ch, 10);
        if (!digit) { gRow.push(0); cRow.push(0); continue; }
        gRow.push(digit);
        cRow.push(res.conf);
        clues++;
        confSum += res.conf;
      }
      grid.push(gRow);
      conf.push(cRow);
    }

    const avg = clues ? confSum / clues : 0;
    steps.push({
      ok: clues >= 17,
      label: clues + ' clue' + (clues === 1 ? '' : 's') + ' recognized',
      detail: clues >= 17
        ? Math.round(avg * 100) + '% average match'
        : 'a valid sudoku needs at least 17 — check the photo'
    });

    return {
      ok: clues >= 17, steps, grid, conf, warped, quad, quality,
      clues, avgConf: avg, timeMs: performance.now() - t0
    };
  }

  const WS_ERRORS = {
    'too-few-marks': 'almost no ink in this photo — get closer and add light',
    'not-enough-letters': 'fewer than 25 letters found — fill the frame with just the grid',
    'no-lattice': 'letters found, but they don\'t line up in a grid',
    'no-grid-rows': 'no band of full rows — crop tighter around the grid',
    'no-grid-columns': 'rows found, but no consistent columns'
  };

  /* Word search read (delegates the layout work to WordSearch.extractGrid). */
  function wordsearch(imageData) {
    const t0 = performance.now();
    const steps = [];
    const res = WordSearch.extractGrid(imageData);
    if (res.error || !res.rows) {
      steps.push({ ok: false, label: 'Letter grid not found', detail: WS_ERRORS[res.error] || 'no grid in this photo' });
      return { ok: false, steps, timeMs: performance.now() - t0, reason: res.error || 'no-grid' };
    }
    steps.push({
      ok: true,
      label: res.blobs + ' letters found',
      detail: 'pen and highlighter marks filtered out'
    });
    steps.push({
      ok: true,
      label: res.rows + ' × ' + res.cols + ' grid locked',
      detail: 'tilt ' + res.skewDeg.toFixed(1) + '° corrected · ' + res.pitch.toFixed(0) + ' px pitch'
    });
    const rate = res.total ? res.recognized / res.total : 0;
    steps.push({
      ok: rate > 0.75,
      label: res.recognized + ' of ' + res.total + ' cells read',
      detail: Math.round(rate * 100) + '% — blanks become ? and still match'
    });
    return {
      ok: true, steps, grid: res.grid, conf: res.conf,
      rows: res.rows, cols: res.cols, timeMs: performance.now() - t0
    };
  }

  /* Second photo: the word bank. */
  function wordbank(imageData) {
    const t0 = performance.now();
    const steps = [];
    const res = WordSearch.extractWords(imageData);
    if (res.error || !res.words.length) {
      steps.push({ ok: false, label: 'No word list found', detail: 'point at just the list of words and try again' });
      return { ok: false, steps, words: [], timeMs: performance.now() - t0, reason: res.error || 'no-words' };
    }
    const solid = res.words.filter(w => w.conf > 0.5).length;
    steps.push({ ok: true, label: res.words.length + ' words read', detail: res.lines + ' lines of text' });
    steps.push({
      ok: solid >= res.words.length * 0.6,
      label: solid + ' read cleanly',
      detail: 'check the list before solving'
    });
    return { ok: true, steps, words: res.words, timeMs: performance.now() - t0 };
  }

  return { findGridQuad, sudoku, wordsearch, wordbank };
})();
