/* ocr.js — tiny glyph classifier built from locally rendered font templates.
   No model file, no download: we draw the alphabet with the system's own fonts,
   normalize each glyph to a 16x16 vector, and nearest-neighbour match by cosine
   similarity. Good enough for printed puzzle grids, and it costs 0 KB. */
const OCR = (function () {
  'use strict';

  const N = 16;                 // feature grid is N x N
  const PRINT_FONTS = [
    '400 76px "Times New Roman", serif',
    '700 76px "Times New Roman", serif',
    '400 76px Arial, Helvetica, sans-serif',
    '700 76px Arial, Helvetica, sans-serif',
    '400 76px "Courier New", monospace',
    '700 76px "Courier New", monospace',
    '400 76px Georgia, serif',
    '400 76px Verdana, Geneva, sans-serif',
    '700 76px Verdana, Geneva, sans-serif',
    '400 76px Tahoma, sans-serif',
    '700 76px "Segoe UI", sans-serif',
    '400 76px "Lucida Console", monospace'
  ];

  /* For puzzles that are already part-filled in by hand. Whichever of these the
     device actually has installed gets used; the rest silently fall back to the
     default face and just add harmless duplicate templates. */
  const HAND_FONTS = [
    '400 76px "Segoe Script"',
    '400 76px "Ink Free"',
    '400 76px "Comic Sans MS"',
    '400 76px "Bradley Hand ITC"',
    '400 76px "Bradley Hand"',
    '400 76px "Marker Felt"',
    '400 76px Noteworthy',
    '400 76px Chalkduster',
    '700 76px "Comic Sans MS"'
  ];

  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';

  /* A bank is a labelled set of templates. `extra` glyphs carry the label of the
     matching entry in `chars` — that's how lowercase word-list text reads back
     as uppercase without a second alphabet. */
  const BANKS = {
    digits: { chars: '123456789', fonts: PRINT_FONTS.concat(HAND_FONTS) },
    letters: { chars: UPPER, fonts: PRINT_FONTS },
    mixed: { chars: UPPER, extra: LOWER, fonts: PRINT_FONTS }
  };

  const render = document.createElement('canvas');
  render.width = render.height = 128;
  const rctx = render.getContext('2d', { willReadFrequently: true });

  const src = document.createElement('canvas');
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const dst = document.createElement('canvas');
  dst.width = dst.height = N;
  const dctx = dst.getContext('2d', { willReadFrequently: true });

  const banks = Object.create(null);

  /* Normalize an arbitrary ink mask into a unit-length N*N feature vector.
     Aspect ratio is preserved (so a narrow "1" stays narrow) and the glyph is
     centered — that removes translation and scale from the comparison. */
  function featurize(mask, mw, mh, box) {
    const bw = box.w, bh = box.h;
    src.width = bw; src.height = bh;
    const id = sctx.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const on = mask[(box.y + y) * mw + box.x + x] === 1 ? 255 : 0;
        const p = (y * bw + x) * 4;
        id.data[p] = id.data[p + 1] = id.data[p + 2] = on;
        id.data[p + 3] = 255;
      }
    }
    sctx.putImageData(id, 0, 0);

    const pad = 1;
    const avail = N - pad * 2;
    const scale = Math.min(avail / bw, avail / bh);
    const dw = Math.max(1, bw * scale), dh = Math.max(1, bh * scale);
    dctx.fillStyle = '#000';
    dctx.fillRect(0, 0, N, N);
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(src, (N - dw) / 2, (N - dh) / 2, dw, dh);

    const px = dctx.getImageData(0, 0, N, N).data;
    const vec = new Float32Array(N * N);
    let mean = 0;
    for (let i = 0, p = 0; i < vec.length; i++, p += 4) { vec[i] = px[p] / 255; mean += vec[i]; }
    mean /= vec.length;
    let norm = 0;
    for (let i = 0; i < vec.length; i++) { vec[i] -= mean; norm += vec[i] * vec[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  function renderTemplate(ch, font) {
    rctx.fillStyle = '#fff';
    rctx.fillRect(0, 0, 128, 128);
    rctx.fillStyle = '#000';
    rctx.font = font;
    rctx.textAlign = 'center';
    rctx.textBaseline = 'middle';
    rctx.fillText(ch, 64, 64);
    const px = rctx.getImageData(0, 0, 128, 128).data;
    const mask = new Uint8Array(128 * 128);
    let minx = 128, miny = 128, maxx = -1, maxy = -1;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        if (px[(y * 128 + x) * 4] < 128) {
          mask[y * 128 + x] = 1;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }
    if (maxx < 0) return null;
    return featurize(mask, 128, 128, { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 });
  }

  /* name: 'digits' | 'letters' | 'mixed'. Built once, then cached. */
  function bank(name) {
    if (banks[name]) return banks[name];
    const spec = BANKS[name];
    if (!spec) throw new Error('unknown OCR bank: ' + name);
    const list = [];
    const add = (glyph, label) => {
      for (const font of spec.fonts) {
        const vec = renderTemplate(glyph, font);
        if (vec) list.push({ ch: label, vec });
      }
    };
    for (let i = 0; i < spec.chars.length; i++) {
      add(spec.chars[i], spec.chars[i]);
      if (spec.extra && spec.extra[i]) add(spec.extra[i], spec.chars[i]);
    }
    banks[name] = list;
    return list;
  }

  function classifyVector(vec, bankName) {
    const templates = bank(bankName);
    let best = null, bestSim = -2, runnerUp = -2;
    for (const t of templates) {
      let s = 0;
      for (let i = 0; i < vec.length; i++) s += vec[i] * t.vec[i];
      if (s > bestSim) {
        if (best !== t.ch) runnerUp = bestSim;
        bestSim = s; best = t.ch;
      } else if (t.ch !== best && s > runnerUp) {
        runnerUp = s;
      }
    }
    // Confidence blends absolute match quality with the margin over the next-best character.
    const quality = Math.max(0, Math.min(1, (bestSim - 0.35) / 0.4));
    const margin = Math.max(0, Math.min(1, (bestSim - runnerUp) * 6));
    return { ch: best, conf: Math.max(0, Math.min(1, quality * 0.55 + margin * 0.45)), sim: bestSim };
  }

  /* cell: { mask, w, h, box } straight out of Vision.gridCells / blob extraction. */
  function classifyCell(cell, bankName) {
    if (!cell || !cell.mask || !cell.box) return { ch: '', conf: 0 };
    return classifyVector(featurize(cell.mask, cell.w, cell.h, cell.box), bankName);
  }

  /* Warm the template cache off the critical path. */
  function preload(bankName) {
    return new Promise(resolve => setTimeout(() => { bank(bankName); resolve(); }, 0));
  }

  return {
    classifyCell, classifyVector, featurize, preload,
    DIGITS: 'digits', LETTERS: 'letters', MIXED: 'mixed'
  };
})();
