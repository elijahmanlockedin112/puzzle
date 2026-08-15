/* sudoku.js — constraint propagation + MRV backtracking. Exact, not heuristic. */
const Sudoku = (function () {
  'use strict';

  const ALL = 0x1FF; // bits 0..8 => digits 1..9

  function boxOf(r, c) { return ((r / 3) | 0) * 3 + ((c / 3) | 0); }
  function bit(d) { return 1 << (d - 1); }
  function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }
  function lowestDigit(x) { return 32 - Math.clz32(x & -x); }

  function makeState(grid) {
    const cells = new Int32Array(81).fill(ALL);
    const rows = new Int32Array(9).fill(ALL);
    const cols = new Int32Array(9).fill(ALL);
    const boxes = new Int32Array(9).fill(ALL);
    const values = new Int32Array(81);
    const st = { cells, rows, cols, boxes, values, filled: 0 };
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const d = grid[r][c];
        if (!d) continue;
        if (!assign(st, r * 9 + c, d)) return { error: { r, c, d } };
      }
    }
    return st;
  }

  function assign(st, idx, d) {
    const r = (idx / 9) | 0, c = idx % 9, b = boxOf(r, c);
    const m = bit(d);
    if (!(st.rows[r] & m) || !(st.cols[c] & m) || !(st.boxes[b] & m)) return false;
    st.values[idx] = d;
    st.cells[idx] = 0;
    st.rows[r] &= ~m; st.cols[c] &= ~m; st.boxes[b] &= ~m;
    st.filled++;
    return true;
  }

  function candidates(st, idx) {
    if (st.values[idx]) return 0;
    const r = (idx / 9) | 0, c = idx % 9;
    return st.rows[r] & st.cols[c] & st.boxes[boxOf(r, c)];
  }

  function clone(st) {
    return {
      cells: st.cells.slice(), rows: st.rows.slice(), cols: st.cols.slice(),
      boxes: st.boxes.slice(), values: st.values.slice(), filled: st.filled
    };
  }

  /* Repeatedly apply naked singles then hidden singles. Returns false on contradiction. */
  function propagate(st, log) {
    let progress = true;
    while (progress) {
      progress = false;
      for (let idx = 0; idx < 81; idx++) {
        if (st.values[idx]) continue;
        const cand = candidates(st, idx);
        if (!cand) return false;
        if (popcount(cand) === 1) {
          const d = lowestDigit(cand);
          if (!assign(st, idx, d)) return false;
          if (log) log.push({ idx, d, rule: 'naked single', detail: 'only one digit fits this cell' });
          progress = true;
        }
      }
      const units = unitList();
      for (const unit of units) {
        for (let d = 1; d <= 9; d++) {
          const m = bit(d);
          let spot = -1, count = 0;
          for (const idx of unit.cells) {
            if (st.values[idx] === d) { count = -1; break; }
            if (st.values[idx]) continue;
            if (candidates(st, idx) & m) { spot = idx; count++; }
          }
          if (count === 0) return false;
          if (count === 1) {
            if (!assign(st, spot, d)) return false;
            if (log) log.push({ idx: spot, d, rule: 'hidden single', detail: `only cell in this ${unit.kind} that can hold ${d}` });
            progress = true;
          }
        }
      }
    }
    return true;
  }

  let _units = null;
  function unitList() {
    if (_units) return _units;
    _units = [];
    for (let r = 0; r < 9; r++) {
      const cells = [];
      for (let c = 0; c < 9; c++) cells.push(r * 9 + c);
      _units.push({ kind: 'row', cells });
    }
    for (let c = 0; c < 9; c++) {
      const cells = [];
      for (let r = 0; r < 9; r++) cells.push(r * 9 + c);
      _units.push({ kind: 'column', cells });
    }
    for (let b = 0; b < 9; b++) {
      const cells = [];
      const r0 = ((b / 3) | 0) * 3, c0 = (b % 3) * 3;
      for (let r = r0; r < r0 + 3; r++) for (let c = c0; c < c0 + 3; c++) cells.push(r * 9 + c);
      _units.push({ kind: 'box', cells });
    }
    return _units;
  }

  /* Depth-first search on the most-constrained cell. Stops after `limit` solutions. */
  function search(st, limit, found) {
    if (!propagate(st)) return;
    if (st.filled === 81) { found.push(st.values.slice()); return; }
    let bestIdx = -1, bestCand = 0, bestCount = 10;
    for (let idx = 0; idx < 81; idx++) {
      if (st.values[idx]) continue;
      const cand = candidates(st, idx);
      const n = popcount(cand);
      if (n < bestCount) { bestCount = n; bestIdx = idx; bestCand = cand; if (n === 2) break; }
    }
    if (bestIdx < 0) return;
    for (let d = 1; d <= 9; d++) {
      if (!(bestCand & bit(d))) continue;
      const next = clone(st);
      if (!assign(next, bestIdx, d)) continue;
      search(next, limit, found);
      if (found.length >= limit) return;
    }
  }

  function toGrid(values) {
    const g = [];
    for (let r = 0; r < 9; r++) {
      const row = [];
      for (let c = 0; c < 9; c++) row.push(values[r * 9 + c]);
      g.push(row);
    }
    return g;
  }

  /* grid: 9x9 array of ints, 0 = blank. */
  function solve(grid) {
    const t0 = performance.now();
    const st = makeState(grid);
    if (st.error) {
      return { status: 'invalid', conflict: st.error, timeMs: performance.now() - t0 };
    }
    const found = [];
    search(clone(st), 2, found);
    const timeMs = performance.now() - t0;
    if (!found.length) return { status: 'unsolvable', timeMs };
    return {
      status: found.length > 1 ? 'multiple' : 'ok',
      solution: toGrid(found[0]),
      solutions: found.length,
      timeMs
    };
  }

  /* One human-style next move, for the hint button. */
  function hint(grid) {
    const st = makeState(grid);
    if (st.error) return null;
    const log = [];
    propagate(clone(st), log);
    if (!log.length) return null;
    const first = log[0];
    return { r: (first.idx / 9) | 0, c: first.idx % 9, value: first.d, rule: first.rule, detail: first.detail };
  }

  function isComplete(grid) {
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (!grid[r][c]) return false;
    return true;
  }

  return { solve, hint, isComplete };
})();
