<div align="center">

# ♟ Open-Chessable

**Open-source SRS chess trainer** — learn opening repertoires, tactical motifs, and endgames the smart way with a SuperMemo SM-2 spaced-repetition engine, full PGN import, and a native desktop app.

[Features](#-features) · [Installation](#-installation) · [Usage](#-usage) · [Architecture](#-architecture) · [Roadmap](#-roadmap) · [License](#-license)

</div>

---

## ✨ What is Open-Chessable?

Open-Chessable is a free, self-hosted alternative to paid chess opening trainers. You import any PGN (your own repertoire, a coach's file, a tournament game) and the app extracts every position-to-move pair as a learnable card. The built-in **SM-2 spaced-repetition scheduler** then shows you each position exactly when you're about to forget it — so you spend review time on what actually matters.

Everything runs locally. Your study data never leaves your machine.

## 🚀 Features

- **Spaced Repetition System (SM-2)** — proven SuperMemo algorithm with 0–5 quality grading, ease-factor tracking, and adaptive intervals (1, 3, 7, 14, 28, 56, 112, 224 days).
- **Full PGN import** — recursively walks main lines and side variations (RAV), records FEN + UCI + SAN for every leaf position.
- **Course → Chapter → Move hierarchy** — organize multiple repertoires (White, Black, specific openings) and break them into sub-chapters.
- **Color-side filtering** — train only White moves, only Black moves, or both.
- **Mastery tracking** — every move is tagged *New / Learning / Consolidating / Mastered* based on its current interval.
- **Native desktop app** — built on **pywebview** + Flask; ships as a single window with a real OS chrome (no browser tabs, no Electron).
- **Dark-themed UI** — designed for long study sessions.
- **Local-first storage** — everything in a single SQLite file at `data/openchessable.db`. No accounts, no telemetry, no cloud.
- **Self-contained REST API** — every screen is also an endpoint, so you can script your own training.

## 📦 Installation

### Requirements

- Python **3.10+**
- Linux / macOS / Windows

### Quick start

```bash
# 1. Clone
git clone https://github.com/jojuega/Open-Chessable.git
cd Open-Chessable

# 2. Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Launch the desktop app
python app.py
```

The app opens a native window at `http://127.0.0.1:5000`. On first run it creates `data/openchessable.db` and seeds the schema.

### Headless / browser mode

If you don't want the native window, just run the Flask server:

```bash
python server.py
# then open http://127.0.0.1:5000 in any browser
```

## 🎯 Usage

### 1. Create a course
Click **+ New Course**, name it (e.g. *White vs 1...e5 — Italian*), and pick a color side.

### 2. Add a chapter
Each chapter is a sub-repertoire or themed set (e.g. *Giuoco Pianissimo*, *Anti-Sveshnikov*).

### 3. Import a PGN
Paste a PGN or upload a `.pgn` file. The parser walks the entire game tree — main lines and bracketed variations — and creates one move-card per leaf position.

### 4. Train
Hit **Train Due** to get the 20 positions that are due *today*. Try to find the right move on the board, then grade yourself 0–5. The scheduler updates intervals automatically.

### 5. Track progress
The dashboard shows total moves, due count, mastered count, and how many you've reviewed today.

## 🏗 Architecture

```
Open-Chessable/
├── app.py                     # pywebview desktop entry point
├── server.py                  # Flask REST API + static file server
├── openchessable/             # Core package
│   ├── __init__.py            # Public API surface
│   ├── database.py            # SQLite schema (courses, chapters, moves)
│   ├── pgn_parser.py          # PGN → list of (FEN, UCI, SAN, side, comment)
│   ├── srs.py                 # SM-2 algorithm + mastery labels
│   └── course_manager.py      # Business logic (CRUD, due queries, stats)
├── web/                       # Frontend served by Flask
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js             # Fetch helpers
│       ├── app.js             # Router / shell
│       ├── courses.js         # Course + chapter UI
│       ├── board.js           # Board widget
│       └── trainer.js         # SRS review session
├── data/                      # SQLite database lives here (gitignored)
├── viewer/index.html          # GitHub Pages landing page
├── requirements.txt
└── README.md
```

### Data model

| Table      | Key fields                                                                       |
| ---------- | -------------------------------------------------------------------------------- |
| `courses`  | `id`, `name`, `description`, `video_url`, `color_side` (white/black/both)        |
| `chapters` | `id`, `course_id`, `name`, `sort_order`                                          |
| `moves`    | `id`, `chapter_id`, `fen`, `move_uci`, `move_san`, `side`, `ease_factor`, `interval`, `repetitions`, `next_review`, `last_reviewed` |

### SRS algorithm

Based on the **SuperMemo SM-2** algorithm:

```
IF quality < 3:
    reps = 0
    interval = 1 day          # failed — start over, keep EF
ELSE:
    IF reps == 0: interval = 1
    ELIF reps == 1: interval = 3
    ELSE: interval = round(prev_interval * ease_factor)
    reps += 1

ease_factor = max(1.3, ease_factor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
```

Mastery thresholds: `reps = 0 → New`, `reps ≤ 2 → Learning`, `interval ≥ 28 → Consolidating`, `interval ≥ 112 → Mastered`.

## 🛣 Roadmap

- [ ] PGN export (mirror database back to a repertoire file)
- [ ] Lichess studies import
- [ ] Multi-board puzzle variants (Find the best move → N alternatives)
- [ ] Sync via WebDAV / folder
- [ ] Mobile companion app (read-only)
- [ ] Optional Anki `.apkg` export

## 🤝 Contributing

Pull requests welcome. For larger changes, open an issue first to discuss what you'd like to change.

```bash
# Run the app in dev mode
source .venv/bin/activate
FLASK_DEBUG=1 python server.py
```

## 📄 License

MIT — do whatever you want, just don't blame us if you forget the Berlin.

---

<div align="center">

Built with ♟ by [jojuega](https://github.com/jojuega) and contributors.

</div>
