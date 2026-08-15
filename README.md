# 🧩 Puzzle Solver+

**Point your camera at a puzzle. It solves it.**

### ▶ [elijahmanlockedin112.github.io/puzzle](https://elijahmanlockedin112.github.io/puzzle/)

Open that on a phone and scan something. Nothing to install, nothing to sign into.

Everything — grid detection, character recognition, and the solvers — runs on the
device. No account, no backend, no API keys, no network calls of any kind. Open it
on a plane and it still works.

V1 ships two puzzle types, done properly rather than five done badly:

| | |
|---|---|
| 🔢 **Sudoku** | finds the grid border, corrects perspective, reads the clues, solves exactly, and reports whether the puzzle has one answer or many |
| 🔤 **Word Search** | two photos — the grid, then the word list — so you never type the bank out. Rebuilds the letter lattice, reads the words, finds them in all eight directions |

Both handle a puzzle you've already started: handwritten sudoku entries are read as
clues, pencilled candidate notes are ignored, and pen rings around words you've already
found are filtered out before the letters are read.

---

## Running it

The published page above is the easy route — it's plain static files on GitHub Pages,
served over HTTPS, which is all the camera needs. Everything below is for hacking on it.

```bash
serve.bat
```

That starts a tiny static server on `http://localhost:8123` and opens it. The server
exists **only** because browsers require a secure context for camera access, and
`localhost` counts as one — the app never talks to it beyond loading its own files.

You can also just double-click `index.html`. Everything works except the live camera;
use the **🖼️ Photo** button instead.

### On your phone, from your own machine

Only needed if you're testing an unpushed change — otherwise just open the live page.

```bash
phone.bat
```

Starts the server, publishes it to your own tailnet over Tailscale Serve, and prints
the URL — `https://<your-machine>.<your-tailnet>.ts.net:8443`. Open that on any device
signed into the tailnet. **Tailnet only — this is Serve, not Funnel, so it is never
exposed to the public internet.** The PC has to be awake with `phone.bat` running;
close the window and the share goes quiet.

The reason it goes through Tailscale rather than just `http://100.x.y.z:8757` is the
camera: browsers only grant `getUserMedia` on a secure context, and a plain-HTTP LAN
address isn't one. Serve terminates TLS with a real Let's Encrypt certificate for the
`.ts.net` name, so the scanner works on the phone exactly as it does locally. (If the
phone warns about the certificate, enable HTTPS for your tailnet in the Tailscale admin
console under DNS.)

Stop sharing at any time:

```bash
tailscale serve --https=8443 off
```

`phone.js` reads your node's name from `tailscale status` rather than hardcoding it,
takes optional ports — `node phone.js <local-port> <https-port>` — and falls back to a
plain localhost server if Tailscale isn't installed or signed in. It deliberately uses
`:8443` rather than the tailnet root, so it can't clobber another Serve mapping you
already have.

Run `tests/selftest.html` to exercise the whole pipeline on generated puzzle images
(no camera required). Current results:

```
sudoku scan × 4 fonts, tilt/shadow/noise:  30/30 clues each, 22–71 ms  ✓
sudoku part-solved in pen:  30/30 printed, 6/6 handwritten, 0/3 pencil notes misread  ✓
word search × 4 (full page: title + bank in frame, tilt, pen rings):
                            10×10 recovered every time, 96–98% letters  ✓
word bank photo:            10/11 words read exactly  ✓
word finder:                all 10 real words, 1 correctly missing  ✓
```

---

## How the scanner works

The scanner is the actual product; the solvers are the easy half.

```
photo
  └─ grayscale + box downscale to ~760 px
      └─ adaptive threshold (integral image, mean − C)
          └─ connected components → pick the grid blob
              └─ extreme-point corners → homography → perspective warp
                  └─ per-cell Otsu + border-line removal
                      └─ glyph → 16×16 feature vector → nearest template
```

**The OCR has no model file.** On first use it renders `1–9` (or `A–Z`) in a dozen
system fonts to an offscreen canvas, normalizes each glyph to a 16×16 aspect-preserving
vector, and nearest-neighbour matches by cosine similarity. Zero download, ~20 ms to
build, and it also produces a per-character confidence — which is what drives the amber
"check this one" highlighting on the review screen.

**Word searches have no ruled border**, so there's no quad to warp and they take a
completely different path — every letter is a connected component, and the grid is
recovered from where those components sit:

1. Threshold, and drop anything strongly coloured — that's the pen ring around a word
   you already found, not a letter.
2. Estimate the page tilt by finding the rotation that packs blob centres into the
   tightest rows. Four degrees is enough to scramble everything downstream.
3. Fit a lattice, don't cluster. Row clustering chains on neighbour distance, so one
   split glyph spawns a phantom row and breaks the run of real ones. Instead:
   autocorrelate the position histogram for the row/column spacing, then least-squares
   refine it — a half-pixel pitch error compounds into a whole row by the tenth one.
4. Take the longest band of rows that are both nearly full *and* sitting tightly on the
   lattice. Word-bank text is dense enough to fake the first test but never the second,
   which is what lets the grid be found on a page that also has a title and a bank.
5. Split any blob far wider than a typical glyph — touching letters otherwise read as
   one wrong character ("LA" comes back as "M").

Unreadable cells become `?`, and the finder treats both `?` and any cell the reader was
unsure of as a wildcard, capped at 40% of a word, preferring the placement that uses
the fewest. So a handful of misreads doesn't break every word passing through them.

The word list is a **second photo**, run through the same front end but split into words
on the large gaps instead of fitted to a lattice — which also handles multi-column banks,
since a column gap is just a very large gap.

### Files

| file | what's in it |
|---|---|
| `js/vision.js` | thresholding, connected components, homography, perspective warp, cell extraction |
| `js/ocr.js` | font-rendered template bank + the 16×16 classifier |
| `js/scan.js` | the photo → puzzle pipelines and the on-screen detection checklist |
| `js/sudoku.js` | constraint propagation (naked + hidden singles) then MRV backtracking; counts solutions to 2 |
| `js/wordsearch.js` | grid recovery from blobs + the 8-direction finder |
| `js/app.js` | screens, camera, auto-capture, editors, history |
| `serve.js` / `phone.js` | static server, and the Tailscale Serve wrapper for phone access |

Plain `<script>` tags, no modules, no build step, no dependencies. Edit a file, refresh.

---

## Product rules

These are deliberate and worth keeping:

- **Scan → confirm → solve.** Three steps, no interstitial anywhere.
- **One banner.** `#adbar` in `index.html` is a 320×50 slot. Drop an AdSense or AdMob
  unit in and nothing else changes. No rewarded video, no scan limit, no paywall.
- **Never a dead end.** If recognition fails, the review screen still opens with an
  editable grid and an explanation of what went wrong.
- **Confidence is shown, not hidden.** Amber = the reader was unsure, red = unreadable.
  The user fixes two cells instead of wondering why the answer is wrong.

## License

Source-available, **not** open source. See [LICENSE](LICENSE).

Short version: read it, learn from it, run it on your own devices, modify it for
yourself. Don't republish it, fork it, sell it, ship it inside anything else, or feed
it to a model. Ask first if you want to do any of that.

## Roadmap

- **V2** — crossword (grid + clue-list OCR), rotate/deskew control for bad photos
- **V3** — Rubik's cube via colour detection (there's already a solver in `~/Downloads/rubiks-cube-coach` worth borrowing from)
- **V4** — nonogram, KenKen, cryptogram
- Also worth doing: PWA manifest + service worker so it installs to the home screen and
  runs fully offline, and a real-photo test set to replace the synthetic one.
