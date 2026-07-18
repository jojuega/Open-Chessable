<div align="center">

# ♟ Open-Chessable

**Open-source SRS chess trainer** — a free, local-first reimplementation of Chessable's MoveTrainer®.  
8-level deterministic spaced-repetition, full PGN import, native desktop app.

[Features](#-features) · [Installation](#-installation) · [Usage](#-usage) · [Architecture](#-architecture) · [Research](#-research) · [License](#-license)

</div>

---

## ✨ What is Open-Chessable?

Open-Chessable is a free, self-hosted alternative to paid chess opening trainers.  
You import any PGN (your repertoire, a coach's file, a tournament game) and the app
extracts **every position-to-move pair** as a learnable card. The built-in
**Chessable-compatible 8-level scheduler** shows each position exactly when you're
about to forget it — so review time goes where it matters.

Everything runs locally. Your training data never leaves your machine.

## 🚀 Features

- **Chessable 8-level deterministic scheduler** — same 4h → 1d → 3d → 1w → 2w → 1mo → 3mo → 6mo cadence. Correct = level+1, Wrong = reset to level 1. No self-rating needed.
- **Outcome-based review** — correct / wrong / soft_fail. The system observes your performance on the board, it doesn't ask you to grade yourself.
- **Learn & Review queues** — new moves go to Learn (introduction with position context), due moves go to Review (pure drill).
- **Full PGN import** — recursively walks main lines and side variations (RAV). Every half-move in the tree becomes a card.
- **Course → Chapter → Variation hierarchy** — organize multiple repertoires.
- **Color-side filtering** — train White, Black, or both.
- **Native desktop app** — pywebview + Flask. Single window, real OS chrome.
- **Dark-themed UI** — Linear-inspired design system, designed for long study sessions.
- **Local-first SQLite** — `data/openchessable.db`. No accounts, no cloud, no telemetry.
- **SM-2 legacy mode** — optionally switch any course to classic SM-2 scheduling.

## 📦 Installation

### Requirements

- Python **3.10+**
- Linux / macOS / Windows

### Quick start

```bash
git clone https://github.com/jojuega/Open-Chessable.git
cd Open-Chessable
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

### Browser mode (no native window)

```bash
python server.py
# open http://127.0.0.1:5000
```

## 🎯 Usage

### 1. Create a course
Click **+ New Course** → name it, pick a color side. Defaults to Chessable 8-level schedule.

### 2. Add chapters & import PGN
Each chapter = a PGN file. Paste or upload a `.pgn`. The parser extracts every half-move from every variation as a card.

### 3. Train
**Train** button loads the review queue (due moves only).  
You see the position → play the correct move on the board → system judges correct or wrong → advances automatically. No self-rating.

### 4. Dashboard
Shows total moves, due today, mastered, XP earned, and per-course progress.

## 🏗 Architecture

```
Open-Chessable/
├── app.py                     # pywebview desktop entry
├── server.py                  # Flask REST API
├── openchessable/
│   ├── srs.py                 # Chessable 8-level + SM-2 schedulers
│   ├── database.py            # SQLite schema (level, next_due, xp_total...)
│   ├── course_manager.py      # CRUD, PGN import, review logic
│   └── pgn_parser.py          # python-chess PGN → cards
├── web/                       # SPA frontend (Linear dark theme)
│   ├── index.html
│   ├── css/style.css
│   └── js/{app,api,board,courses,trainer}.js
├── viewer/                    # GitHub Pages landing
├── RESEARCH.md                # Full Chessable algorithm analysis
└── README.md
```

### SRS Algorithm (Chessable 8-level)

| Level | Interval | XP |
|------:|---------:|---:|
| 1 | 4 hours | +40 |
| 2 | 1 day | +50 |
| 3 | 3 days | +60 |
| 4 | 1 week | +70 |
| 5 | 2 weeks | +80 |
| 6 | 1 month | +90 |
| 7 | 3 months | +100 |
| 8 | 6 months | +110 |

Correct → `level = min(8, level + 1)`. Wrong → `level = 1`. Soft-fail → level unchanged.

### Data model

| Table | Key fields |
|-------|-----------|
| `courses` | id, name, schedule_type (chessable_8level / sm2), color_side |
| `chapters` | id, course_id, name, video_url |
| `moves` | id, fen, move_uci, move_san, side, **level**, **next_due**, **fail_count**, **xp_total**, paused, key_move, alternates_json |

## 📚 Research

[`RESEARCH.md`](RESEARCH.md) — 854-line deep dive into how Chessable actually works.
37 cited sources, algorithm pseudocode, data model, and comparison with SM-2/FSRS.

## 🤝 Contributing

PRs welcome. Open an issue first for larger changes.

## 📄 License

MIT.

---

<div align="center">
Built with ♟ by <a href="https://github.com/jojuega">jojuega</a>
</div>
