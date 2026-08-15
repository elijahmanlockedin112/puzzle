/* app.js — screens, camera, and the glue between the scanner and the solvers. */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const HISTORY_KEY = 'psplus.history.v1';
  const PALETTE = ['#7c5cff', '#22d3ee', '#34d399', '#f5b544', '#f87171', '#f472b6', '#a3e635', '#60a5fa'];

  const state = {
    mode: 'auto',        // what the user asked to scan
    type: null,          // what we actually recognized: 'sudoku' | 'wordsearch'
    target: 'puzzle',    // 'puzzle' or 'wordbank' — which photo we're taking
    sudoku: null,        // { grid, conf, given }
    ws: null,            // { grid, conf, words }
    steps: [],
    warped: null,
    lastResult: null
  };

  const els = {
    back: $('#backBtn'),
    video: $('#video'),
    overlay: $('#overlay'),
    stage: $('#stage'),
    stageMsg: $('#stageMsg'),
    shutter: $('#shutterBtn'),
    upload: $('#uploadBtn'),
    file: $('#fileInput'),
    typeBtn: $('#typeBtn'),
    auto: $('#autoCapture'),
    scanStep: $('#scanStep'),
    scanStepNum: $('#scanStepNum'),
    scanStepText: $('#scanStepText'),
    skipStep: $('#skipStep'),
    scanBank: $('#scanBankBtn'),
    uploadBank: $('#uploadBankBtn'),
    bankFile: $('#bankFileInput'),
    reviewMain: $('#reviewMain'),
    reviewTitle: $('#reviewTitle'),
    reviewSub: $('#reviewSub'),
    stepsList: $('#stepsList'),
    warpPreview: $('#warpPreview'),
    wordsPanel: $('#wordsPanel'),
    wordsInput: $('#wordsInput'),
    solve: $('#solveBtn'),
    hint: $('#hintBtn'),
    rescan: $('#rescanBtn'),
    notice: $('#reviewNotice'),
    resultTitle: $('#resultTitle'),
    resultStat: $('#resultStat'),
    resultBody: $('#resultBody'),
    edit: $('#editBtn'),
    copy: $('#copyBtn'),
    toast: $('#toast'),
    historyWrap: $('#historyWrap'),
    historyList: $('#historyList')
  };

  /* ───────────────────────── screens ───────────────────────── */

  let current = 'home';
  const backTo = { home: null, scan: 'home', review: 'scan', result: 'review' };

  function go(name) {
    if (name !== 'scan') stopCamera();
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $('#screen-' + name).classList.add('active');
    els.back.hidden = !backTo[name];
    current = name;
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  els.back.addEventListener('click', () => {
    const target = backTo[current];
    if (!target) return;
    if (target === 'scan' && !state.fromCamera) return go('home');
    go(target);
    if (target === 'scan') startCamera();
  });

  function toast(msg, ms) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { els.toast.hidden = true; }, ms || 2200);
  }

  /* ───────────────────────── camera ───────────────────────── */

  let stream = null, loopTimer = null, stableFrames = 0, lastQuad = null;
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  /* The word search needs two photos, so the scan screen carries a step banner. */
  function setScanStep() {
    const twoStep = state.mode === 'wordsearch' || (state.type === 'wordsearch' && state.target === 'wordbank');
    els.scanStep.hidden = !twoStep;
    if (!twoStep) return;
    const onBank = state.target === 'wordbank';
    els.scanStepNum.textContent = onBank ? '2 / 2' : '1 / 2';
    els.scanStepText.textContent = onBank
      ? 'Now photograph the word list'
      : 'Photograph the letter grid only';
    els.skipStep.hidden = !onBank;
  }

  async function startCamera() {
    stableFrames = 0; lastQuad = null;
    setScanStep();
    setStageMsg(
      state.target === 'wordbank' ? 'Fill the frame with the word list'
        : state.mode === 'wordsearch' ? 'Fill the frame with the letter grid'
          : 'Looking for a grid…', false);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return cameraUnavailable('This browser has no camera API here.');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false
      });
      els.video.srcObject = stream;
      await els.video.play();
      startDetectLoop();
    } catch (err) {
      cameraUnavailable(
        location.protocol === 'file:'
          ? 'Camera needs a local server (see README) — use 🖼️ Photo for now.'
          : 'Camera blocked — use 🖼️ Photo instead.'
      );
    }
  }

  function cameraUnavailable(msg) {
    setStageMsg(msg, false);
    els.shutter.disabled = true;
    els.shutter.style.opacity = .35;
  }

  function stopCamera() {
    clearInterval(loopTimer);
    loopTimer = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    els.video.srcObject = null;
  }

  function setStageMsg(text, locked) {
    els.stageMsg.textContent = text;
    els.stageMsg.classList.toggle('locked', !!locked);
  }

  function startDetectLoop() {
    clearInterval(loopTimer);
    // Only a ruled sudoku border can be locked onto; letter grids and word lists
    // have no outline, so those are tap-to-capture.
    if (state.mode === 'wordsearch' || state.target === 'wordbank') return;
    loopTimer = setInterval(detectFrame, 340);
  }

  function detectFrame() {
    const v = els.video;
    if (!v.videoWidth) return;
    const w = 320, h = Math.round(320 * v.videoHeight / v.videoWidth);
    probe.width = w; probe.height = h;
    probeCtx.drawImage(v, 0, 0, w, h);
    let res;
    try { res = Scan.findGridQuad(probeCtx.getImageData(0, 0, w, h), 320); }
    catch (e) { return; }

    drawOverlay(res.quad, res.img, res.quality);

    if (res.quad && res.quality > 0.45) {
      const cx = res.quad.reduce((s, p) => s + p[0], 0) / 4;
      const cy = res.quad.reduce((s, p) => s + p[1], 0) / 4;
      if (lastQuad && Math.hypot(cx - lastQuad[0], cy - lastQuad[1]) < res.img.w * 0.04) stableFrames++;
      else stableFrames = 1;
      lastQuad = [cx, cy];
      setStageMsg(stableFrames >= 2 ? 'Grid locked — hold still' : 'Grid found, hold steady…', stableFrames >= 2);
      if (stableFrames >= 3 && els.auto.checked) capture();
    } else {
      stableFrames = 0; lastQuad = null;
      setStageMsg('Looking for a grid…', false);
    }
  }

  function drawOverlay(quad, img, quality) {
    const c = els.overlay;
    const rect = els.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== rect.width * dpr) { c.width = rect.width * dpr; c.height = rect.height * dpr; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!quad) return;

    // The video is object-fit: cover — replicate that mapping for the overlay.
    const vw = els.video.videoWidth, vh = els.video.videoHeight;
    if (!vw) return;
    const scale = Math.max(rect.width / vw, rect.height / vh);
    const offX = (rect.width - vw * scale) / 2, offY = (rect.height - vh * scale) / 2;
    const k = vw / img.w;
    const pt = p => [offX + p[0] * k * scale, offY + p[1] * k * scale];

    ctx.beginPath();
    quad.forEach((p, i) => { const q = pt(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
    ctx.closePath();
    ctx.strokeStyle = quality > 0.45 ? '#34d399' : 'rgba(124,92,255,.85)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = quality > 0.45 ? 'rgba(52,211,153,.12)' : 'rgba(124,92,255,.08)';
    ctx.fill();
    quad.forEach(p => {
      const q = pt(p);
      ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle; ctx.fill();
    });
  }

  /* ───────────────────────── capture & analyze ───────────────────────── */

  function capture() {
    const v = els.video;
    if (!v.videoWidth) return;
    clearInterval(loopTimer); loopTimer = null;
    const maxW = 1280;
    const scale = Math.min(1, maxW / v.videoWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    state.fromCamera = true;
    analyze(c.getContext('2d').getImageData(0, 0, c.width, c.height));
  }

  function analyze(imageData) {
    setStageMsg(state.target === 'wordbank' ? 'Reading the word list…' : 'Reading the puzzle…', true);
    // Yield a frame so the message paints before the synchronous CV work.
    setTimeout(() => {
      if (state.target === 'wordbank') return analyzeBank(imageData);

      let res = null, type = null;
      if (state.mode === 'sudoku' || state.mode === 'auto') {
        res = Scan.sudoku(imageData);
        if (res.ok) type = 'sudoku';
      }
      if (!type && (state.mode === 'wordsearch' || state.mode === 'auto')) {
        const ws = Scan.wordsearch(imageData);
        if (ws.ok) { res = ws; type = 'wordsearch'; }
        else if (state.mode === 'wordsearch') res = ws;
      }
      stopCamera();

      if (!type) {
        state.steps = (res && res.steps) || [{ ok: false, label: 'Nothing recognized', detail: 'no grid in this photo' }];
        openReviewFallback();
        return;
      }
      state.type = type;
      state.steps = res.steps;
      state.warped = res.warped || null;
      if (type === 'sudoku') {
        state.sudoku = { grid: res.grid, conf: res.conf };
        return openReview();
      }

      state.ws = { grid: res.grid, conf: res.conf, words: [] };
      // Grid is in hand — go straight on to photo two rather than making the
      // user type the word bank out.
      if (state.fromCamera && !els.wordsInput.value.trim()) {
        state.gridSteps = res.steps;
        state.target = 'wordbank';
        go('scan');
        startCamera();
        toast('Grid captured — now the word list');
        return;
      }
      openReview();
    }, 40);
  }

  function analyzeBank(imageData) {
    const res = Scan.wordbank(imageData);
    stopCamera();
    state.target = 'puzzle';
    state.steps = (state.gridSteps || []).concat(res.steps);
    if (res.ok) {
      const existing = els.wordsInput.value.trim();
      const scanned = res.words.map(w => w.text).join('\n');
      els.wordsInput.value = existing ? existing + '\n' + scanned : scanned;
    }
    openReview();
    if (!res.ok) {
      setNotice('Couldn\'t read the word list from that photo. Try again with just the list in frame, or type the words in below.', 'warn');
    } else {
      const shaky = res.words.filter(w => w.conf <= 0.5 || w.text.indexOf('?') >= 0);
      if (shaky.length) {
        setNotice(shaky.length + ' word' + (shaky.length === 1 ? '' : 's') +
          ' came back uncertain — check the list before solving.', 'warn');
      }
    }
  }

  function openReviewFallback() {
    // Recognition failed: still give the user a grid to type into rather than a dead end.
    state.type = state.mode === 'wordsearch' ? 'wordsearch' : 'sudoku';
    if (state.type === 'sudoku') state.sudoku = { grid: blankSudoku(), conf: allConf(9, 9, 1) };
    else state.ws = { grid: blankWS(12, 12), conf: allConf(12, 12, 1), words: [] };
    openReview();
    setNotice('Couldn\'t read that photo — the grid below is blank so you can rescan or type it in. Best results: fill the frame, keep the page flat, avoid shadows.', 'warn');
  }

  /* ───────────────────────── review ───────────────────────── */

  function openReview() {
    renderSteps();
    els.notice.hidden = true;
    els.hint.hidden = state.type !== 'sudoku';
    els.wordsPanel.hidden = state.type !== 'wordsearch';
    els.warpPreview.hidden = !state.warped;
    if (state.warped) Vision.toCanvas(state.warped, els.warpPreview);

    if (state.type === 'sudoku') {
      els.reviewTitle.textContent = 'Check the clues';
      els.reviewSub.textContent = 'Amber cells are the ones the reader was least sure about. Fix anything wrong, then solve.';
      renderSudokuEditor();
    } else {
      els.reviewTitle.textContent = 'Check the letters';
      els.reviewSub.textContent = 'Red cells were unreadable, amber were uncertain. A few "?" are fine — the finder works around them.';
      renderWSEditor();
    }
    go('review');
  }

  function renderSteps() {
    els.stepsList.innerHTML = '';
    state.steps.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'step ' + (s.ok ? 'ok' : 'no');
      d.style.animationDelay = (i * 110) + 'ms';
      d.innerHTML = '<span class="tick">' + (s.ok ? '✓' : '✕') + '</span><span><span class="sl">' +
        esc(s.label) + '</span><span class="sd">' + esc(s.detail || '') + '</span></span>';
      els.stepsList.appendChild(d);
    });
  }

  function setNotice(text, kind) {
    els.notice.hidden = false;
    els.notice.className = 'notice ' + (kind || '');
    els.notice.textContent = text;
  }

  function blankSudoku() { return Array.from({ length: 9 }, () => new Array(9).fill(0)); }
  function blankWS(r, c) { return Array.from({ length: r }, () => new Array(c).fill('')); }
  function allConf(r, c, v) { return Array.from({ length: r }, () => new Array(c).fill(v)); }

  function renderSudokuEditor() {
    const { grid, conf } = state.sudoku;
    const wrap = document.createElement('div');
    wrap.className = 'sgrid';
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell' + (c % 3 === 2 && c !== 8 ? ' br' : '') + (r % 3 === 2 && r !== 8 ? ' bb' : '');
        if (grid[r][c] && conf[r][c] < 0.6) cell.classList.add('low');
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.inputMode = 'numeric';
        inp.maxLength = 1;
        inp.value = grid[r][c] || '';
        inp.dataset.r = r; inp.dataset.c = c;
        inp.addEventListener('input', onSudokuInput);
        inp.addEventListener('keydown', onGridKey);
        inp.addEventListener('focus', () => inp.select());
        cell.appendChild(inp);
        wrap.appendChild(cell);
      }
    }
    els.reviewMain.innerHTML = '';
    els.reviewMain.appendChild(wrap);
    markConflicts();
  }

  function onSudokuInput(e) {
    const v = e.target.value.replace(/[^1-9]/g, '');
    e.target.value = v;
    const cell = e.target.parentElement;
    cell.classList.remove('low', 'hint');
    if (v) focusOffset(e.target, 1);
    markConflicts();
  }

  function onGridKey(e) {
    const map = { ArrowRight: 1, ArrowLeft: -1 };
    const inputs = [].slice.call(els.reviewMain.querySelectorAll('input'));
    const i = inputs.indexOf(e.target);
    const cols = state.type === 'sudoku' ? 9 : state.ws.grid[0].length;
    let target = -1;
    if (e.key in map) target = i + map[e.key];
    else if (e.key === 'ArrowDown') target = i + cols;
    else if (e.key === 'ArrowUp') target = i - cols;
    else if (e.key === 'Backspace' && !e.target.value) target = i - 1;
    else return;
    if (e.key !== 'Backspace') e.preventDefault();
    if (target >= 0 && target < inputs.length) inputs[target].focus();
  }

  function focusOffset(el, delta) {
    const inputs = [].slice.call(els.reviewMain.querySelectorAll('input'));
    const i = inputs.indexOf(el) + delta;
    if (i >= 0 && i < inputs.length) inputs[i].focus();
  }

  function readSudokuGrid() {
    const grid = blankSudoku();
    els.reviewMain.querySelectorAll('input').forEach(inp => {
      grid[+inp.dataset.r][+inp.dataset.c] = parseInt(inp.value, 10) || 0;
    });
    return grid;
  }

  function markConflicts() {
    if (state.type !== 'sudoku') return;
    const grid = readSudokuGrid();
    const cells = els.reviewMain.querySelectorAll('.cell');
    cells.forEach(c => c.classList.remove('conflict'));
    const bad = new Set();
    const check = list => {
      const seen = {};
      list.forEach(([r, c]) => {
        const v = grid[r][c];
        if (!v) return;
        if (seen[v]) { bad.add(r * 9 + c); bad.add(seen[v]); }
        else seen[v] = r * 9 + c;
      });
    };
    for (let i = 0; i < 9; i++) {
      check(Array.from({ length: 9 }, (_, j) => [i, j]));
      check(Array.from({ length: 9 }, (_, j) => [j, i]));
      const r0 = ((i / 3) | 0) * 3, c0 = (i % 3) * 3;
      check(Array.from({ length: 9 }, (_, j) => [r0 + ((j / 3) | 0), c0 + (j % 3)]));
    }
    bad.forEach(idx => cells[idx].classList.add('conflict'));
    return bad.size > 0;
  }

  function renderWSEditor() {
    const { grid, conf } = state.ws;
    const rows = grid.length, cols = grid[0].length;
    const wrap = document.createElement('div');
    wrap.className = 'wsgrid';
    wrap.style.gridTemplateColumns = 'repeat(' + cols + ', auto)';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.maxLength = 1;
        const ch = grid[r][c] || '';
        inp.value = ch === '?' ? '' : ch;
        inp.dataset.r = r; inp.dataset.c = c;
        if (!inp.value) inp.classList.add('unknown');
        else if (conf[r] && conf[r][c] < 0.55) inp.classList.add('low');
        inp.addEventListener('input', e => {
          e.target.value = e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase();
          e.target.classList.remove('low', 'unknown');
          // A letter the user typed is certain, so the finder must stop treating
          // it as a wildcard.
          state.ws.conf[+e.target.dataset.r][+e.target.dataset.c] = 1;
          if (e.target.value) focusOffset(e.target, 1);
        });
        inp.addEventListener('keydown', onGridKey);
        inp.addEventListener('focus', () => inp.select());
        wrap.appendChild(inp);
      }
    }
    const tools = document.createElement('div');
    tools.className = 'gridtools';
    [['+ row', () => resizeWS(1, 0)], ['− row', () => resizeWS(-1, 0)],
     ['+ column', () => resizeWS(0, 1)], ['− column', () => resizeWS(0, -1)]]
      .forEach(([label, fn]) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', fn);
        tools.appendChild(b);
      });
    els.reviewMain.innerHTML = '';
    els.reviewMain.appendChild(wrap);
    els.reviewMain.appendChild(tools);
  }

  function readWSGrid() {
    const rows = state.ws.grid.length, cols = state.ws.grid[0].length;
    const grid = blankWS(rows, cols);
    els.reviewMain.querySelectorAll('input').forEach(inp => {
      grid[+inp.dataset.r][+inp.dataset.c] = (inp.value || '?').toUpperCase();
    });
    return grid;
  }

  function resizeWS(dr, dc) {
    const grid = readWSGrid();
    let rows = grid.length + dr, cols = grid[0].length + dc;
    rows = Math.max(2, Math.min(40, rows));
    cols = Math.max(2, Math.min(40, cols));
    const next = blankWS(rows, cols);
    for (let r = 0; r < Math.min(rows, grid.length); r++) {
      for (let c = 0; c < Math.min(cols, grid[0].length); c++) next[r][c] = grid[r][c];
    }
    state.ws.grid = next;
    state.ws.conf = allConf(rows, cols, 1);
    renderWSEditor();
  }

  /* ───────────────────────── solve ───────────────────────── */

  els.solve.addEventListener('click', () => {
    if (state.type === 'sudoku') solveSudoku();
    else solveWordSearch();
  });

  els.hint.addEventListener('click', () => {
    const grid = readSudokuGrid();
    if (markConflicts()) return setNotice('Two of the same digit share a row, column or box — fix the red cells first.', 'bad');
    const h = Sudoku.hint(grid);
    if (!h) return setNotice('No single-step move from here — this one needs the full solve.', 'warn');
    const cells = els.reviewMain.querySelectorAll('.cell');
    cells.forEach(c => c.classList.remove('hint'));
    const cell = cells[h.r * 9 + h.c];
    cell.classList.add('hint');
    cell.scrollIntoView({ block: 'nearest' });
    setNotice('R' + (h.r + 1) + 'C' + (h.c + 1) + ' is ' + h.value + ' — ' + h.rule + ': ' + h.detail + '.', '');
  });

  function solveSudoku() {
    const grid = readSudokuGrid();
    const clues = grid.flat().filter(Boolean).length;
    if (clues < 17) return setNotice('Only ' + clues + ' clues. A sudoku with a single answer needs at least 17 — add the missing ones.', 'warn');
    if (markConflicts()) return setNotice('Two of the same digit share a row, column or box — fix the red cells first.', 'bad');

    const res = Sudoku.solve(grid);
    if (res.status === 'invalid') {
      return setNotice('The clue at R' + (res.conflict.r + 1) + 'C' + (res.conflict.c + 1) + ' contradicts another one.', 'bad');
    }
    if (res.status === 'unsolvable') {
      return setNotice('No solution exists for these clues — one of them is probably misread.', 'bad');
    }
    state.lastResult = { grid, solution: res.solution, res };
    renderSudokuResult(grid, res);
    saveHistory('sudoku', grid, clues + ' clues');
    go('result');
  }

  function renderSudokuResult(given, res) {
    els.resultTitle.textContent = res.status === 'multiple' ? 'Solved (one of several)' : 'Solved';
    els.resultStat.className = 'stat' + (res.status === 'multiple' ? ' warn' : '');
    els.resultStat.textContent = 'solved in ' + res.timeMs.toFixed(2) + ' ms' +
      (res.status === 'multiple' ? ' · puzzle has more than one answer' : ' · unique solution');

    const wrap = document.createElement('div');
    wrap.className = 'sgrid';
    let n = 0;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell' + (c % 3 === 2 && c !== 8 ? ' br' : '') + (r % 3 === 2 && r !== 8 ? ' bb' : '');
        const span = document.createElement('span');
        const isGiven = !!given[r][c];
        span.className = 'val ' + (isGiven ? 'given' : 'solved');
        span.textContent = res.solution[r][c];
        if (!isGiven) span.style.animationDelay = (n++ * 7) + 'ms';
        cell.appendChild(span);
        wrap.appendChild(cell);
      }
    }
    els.resultBody.innerHTML = '';
    els.resultBody.appendChild(wrap);
  }

  function solveWordSearch() {
    const grid = readWSGrid();
    const words = els.wordsInput.value.split(/[\n,;]+/).map(w => w.trim()).filter(w => WordSearch.normalizeWord(w).length > 1);
    if (!words.length) return setNotice('Add the words you\'re looking for — one per line, in the box on the right.', 'warn');
    state.ws.grid = grid;
    state.ws.words = words;

    const res = WordSearch.solve(grid, words, state.ws.conf);
    state.lastResult = { grid, res };
    renderWSResult(grid, res);
    saveHistory('wordsearch', { grid, words }, res.found.length + '/' + words.length + ' words');
    go('result');
  }

  function renderWSResult(grid, res) {
    const rows = grid.length, cols = grid[0].length;
    const cell = 30, pad = 18;
    const W = cols * cell + pad * 2, H = rows * cell + pad * 2;
    const cx = c => pad + c * cell + cell / 2;
    const cy = r => pad + r * cell + cell / 2;

    let svg = '<svg class="wsvg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" xmlns="http://www.w3.org/2000/svg">';
    res.found.forEach((f, i) => {
      const color = PALETTE[i % PALETTE.length];
      const er = f.r + f.dr * (f.letters.length - 1), ec = f.c + f.dc * (f.letters.length - 1);
      svg += '<line x1="' + cx(f.c) + '" y1="' + cy(f.r) + '" x2="' + cx(ec) + '" y2="' + cy(er) +
        '" stroke="' + color + '" stroke-width="' + (cell * 0.78) + '" stroke-linecap="round" opacity="0.30"/>';
    });
    const inWord = new Set();
    res.found.forEach(f => {
      for (let i = 0; i < f.letters.length; i++) inWord.add((f.r + f.dr * i) * cols + (f.c + f.dc * i));
    });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const hot = inWord.has(r * cols + c);
        svg += '<text x="' + cx(c) + '" y="' + cy(r) + '" text-anchor="middle" dominant-baseline="central" ' +
          'font-family="ui-monospace, Consolas, monospace" font-size="15" font-weight="' + (hot ? '700' : '400') + '" ' +
          'fill="' + (hot ? '#e8ecf5' : '#8b95ad') + '">' + esc(grid[r][c] === '?' ? '·' : grid[r][c]) + '</text>';
      }
    }
    svg += '</svg>';

    let list = '<div class="wordlist">';
    res.found.forEach((f, i) => {
      list += '<span class="wordtag"><span class="dot" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
        esc(f.word) + ' <span style="color:var(--muted)">R' + (f.r + 1) + 'C' + (f.c + 1) + ' ' + f.dir +
        (f.fuzzy ? ' · ' + f.fuzzy + ' guessed' : '') + '</span></span>';
    });
    res.missing.forEach(w => { list += '<span class="wordtag miss">' + esc(w) + '</span>'; });
    list += '</div>';

    els.resultTitle.textContent = res.found.length + ' of ' + (res.found.length + res.missing.length) + ' words found';
    els.resultStat.className = 'stat' + (res.missing.length ? ' warn' : '');
    els.resultStat.textContent = 'searched in ' + res.timeMs.toFixed(2) + ' ms · ' + rows + '×' + cols + ' grid · 8 directions';
    els.resultBody.innerHTML = svg + list;
  }

  /* ───────────────────────── history ───────────────────────── */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
  }

  function saveHistory(type, data, summary) {
    const list = loadHistory();
    list.unshift({ type, data, summary, ts: Date.now() });
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 12))); } catch (e) { /* quota — fine */ }
    renderHistory();
  }

  function renderHistory() {
    const list = loadHistory();
    els.historyWrap.hidden = !list.length;
    els.historyList.innerHTML = '';
    list.slice(0, 6).forEach(item => {
      const b = document.createElement('button');
      b.className = 'histitem';
      const when = new Date(item.ts);
      b.innerHTML = '<div class="ht">' + (item.type === 'sudoku' ? '🔢 Sudoku' : '🔤 Word Search') + '</div>' +
        '<div class="hs">' + esc(item.summary) + ' · ' + when.toLocaleDateString() + ' ' +
        when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</div>';
      b.addEventListener('click', () => restore(item));
      els.historyList.appendChild(b);
    });
  }

  function restore(item) {
    state.type = item.type;
    state.warped = null;
    state.fromCamera = false;
    state.steps = [{ ok: true, label: 'Loaded from history', detail: item.summary }];
    if (item.type === 'sudoku') {
      state.sudoku = { grid: item.data, conf: allConf(9, 9, 1) };
    } else {
      state.ws = { grid: item.data.grid, conf: allConf(item.data.grid.length, item.data.grid[0].length, 1), words: item.data.words };
      els.wordsInput.value = (item.data.words || []).join('\n');
    }
    openReview();
  }

  $('#clearHistory').addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
    toast('History cleared');
  });

  /* ───────────────────────── wiring ───────────────────────── */

  document.querySelectorAll('[data-scan]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.scan;
      state.target = 'puzzle';
      state.gridSteps = null;
      state.fromCamera = true;
      els.shutter.disabled = false;
      els.shutter.style.opacity = 1;
      go('scan');
      startCamera();
    });
  });

  document.querySelectorAll('[data-manual]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.manual;
      state.type = btn.dataset.manual;
      state.fromCamera = false;
      state.target = 'puzzle';
      state.gridSteps = null;
      state.warped = null;
      state.steps = [{ ok: true, label: 'Manual entry', detail: 'type the puzzle in below' }];
      if (state.type === 'sudoku') state.sudoku = { grid: blankSudoku(), conf: allConf(9, 9, 1) };
      else state.ws = { grid: blankWS(12, 12), conf: allConf(12, 12, 1), words: [] };
      openReview();
    });
  });

  els.shutter.addEventListener('click', capture);
  els.typeBtn.addEventListener('click', () => {
    stopCamera();
    state.type = state.mode === 'wordsearch' ? 'wordsearch' : 'sudoku';
    state.fromCamera = false;
    state.warped = null;
    state.steps = [{ ok: true, label: 'Manual entry', detail: 'type the puzzle in below' }];
    if (state.type === 'sudoku') state.sudoku = { grid: blankSudoku(), conf: allConf(9, 9, 1) };
    else state.ws = { grid: blankWS(12, 12), conf: allConf(12, 12, 1), words: [] };
    openReview();
  });

  function readImageFile(file, cb) {
    const img = new Image();
    img.onload = () => {
      const maxW = 1400;
      const scale = Math.min(1, maxW / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      cb(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => toast('Could not open that image');
    img.src = URL.createObjectURL(file);
  }

  els.upload.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    readImageFile(file, data => {
      state.fromCamera = false;
      if (current !== 'scan') go('scan');
      analyze(data);
    });
  });

  /* Word-list photo, taken separately from the grid. */
  els.scanBank.addEventListener('click', () => {
    state.target = 'wordbank';
    state.gridSteps = state.steps;
    state.fromCamera = true;
    els.shutter.disabled = false;
    els.shutter.style.opacity = 1;
    go('scan');
    startCamera();
  });

  els.uploadBank.addEventListener('click', () => els.bankFile.click());
  els.bankFile.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    readImageFile(file, data => {
      state.target = 'wordbank';
      state.fromCamera = false;
      state.gridSteps = state.steps;
      setTimeout(() => analyzeBank(data), 10);
    });
  });

  els.skipStep.addEventListener('click', () => {
    state.target = 'puzzle';
    stopCamera();
    state.steps = state.gridSteps || state.steps;
    openReview();
  });

  els.rescan.addEventListener('click', () => {
    state.target = 'puzzle';
    state.gridSteps = null;
    els.shutter.disabled = false;
    els.shutter.style.opacity = 1;
    go('scan');
    startCamera();
  });
  els.edit.addEventListener('click', () => go('review'));

  els.copy.addEventListener('click', () => {
    let text = '';
    if (state.type === 'sudoku' && state.lastResult) {
      text = state.lastResult.solution.map(r => r.join('')).join('\n');
    } else if (state.lastResult) {
      const r = state.lastResult.res;
      text = r.found.map(f => f.word + ' — R' + (f.r + 1) + 'C' + (f.c + 1) + ' ' + f.dir).join('\n');
      if (r.missing.length) text += '\nnot found: ' + r.missing.join(', ');
    }
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => toast('Copied'),
      () => toast('Clipboard blocked here')
    );
  });

  window.addEventListener('resize', () => { if (current === 'scan') drawOverlay(null); });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  renderHistory();
  // Build the glyph templates while the user is still reading the home screen.
  OCR.preload(OCR.DIGITS)
    .then(() => OCR.preload(OCR.LETTERS))
    .then(() => OCR.preload(OCR.MIXED));
})();
