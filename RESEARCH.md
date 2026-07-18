# Chessable — Deep Research

> A reverse-engineered, evidence-cited reference document describing how Chessable's
> MoveTrainer®, spaced-repetition scheduler, course/PGN structure, and training flow
> actually work. Intended as a specification for an open-source reimplementation
> (`Open-Chessable`) and as a comparison point for our SM-2 implementation.

**Document scope**

1. The SRS algorithm (default schedule, custom, cyclical, FastTrack, soft fails, learning status).
2. Course / chapter / variation hierarchy and PGN import pipeline.
3. The MoveTrainer training experience end-to-end (Learn, Review, Whole vs Randomized).
4. Openings vs tactics vs endgames — what is the same and what differs.
5. The training data model: what a "move to learn" actually stores.
6. Inferred algorithm + pseudo-code for an SM-2-style chess trainer and how it
   would have to be extended to cover the observed behaviour.

All factual claims are footnoted with a source URL. Where Chessable is silent
(closed source) and we are inferring, the text is explicitly labelled
**Inferred**.

---

## 1. Executive summary

| Question | Answer | Source |
|---|---|---|
| What algorithm does Chessable use? | A **deterministic 8-level spaced-repetition scheduler** (not classic SM-2, not FSRS). Each "move to learn" carries a level (1–8), each level has a fixed interval. | [support: scheduling](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work) |
| How do correct/wrong answers change timing? | Correct → level + 1 (capped at 8, then keeps cycling at 8). Wrong → level = 1. | [support: scheduling](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work) |
| Where is state stored? | Per move, not per variation or per card. Every move in a variation has its own level/timer. | [support: whole vs randomized](https://support.chessable.com/en/articles/9047490-review-whole-variation-vs-randomized) |
| What is the input format? | A course is a PGN file (with chapters as headers) imported into Chessable. | [Course Creation Guide](https://go.chessable.com/create/chessable-course-creation-guide) |
| What is the unit of study? | A **trainable variation** — a contiguous sequence of moves (mainline or sub-variation) in the PGN tree, optionally with annotations shown between moves. | [Course Creation Guide](https://go.chessable.com/create/chessable-course-creation-guide) |
| How is correctness judged? | The user must play the next move in the variation (SAN). Engine-evaluated "soft fail" alternatives are accepted in openings (≤ 0.3 eval margin), tactics (≤ 1.0 eval) and endgames (tablebase-equivalent). | [support: soft fail](https://support.chessable.com/en/articles/9043806-what-are-soft-fail-moves) |
| What is the review queue? | The list of all moves whose level-1+ interval has elapsed, optionally expanded to the rest of the variation. | [support: whole vs randomized](https://support.chessable.com/en/articles/9047490-review-whole-variation-vs-randomized) |
| What is "Time Planner"? | A dashboard widget forecasting how many reviews are due in the next few hours, with traffic-light workload colours. | [support: time planner](https://support.chessable.com/en/articles/9047647-what-is-the-time-planner) |
| How does the analysis board work? | Chessable has its own analysis board (an embedded engine). Users frequently hack around it with a bookmarklet that opens the position in Lichess. | [forum: lichess bookmarklet](https://www.chessable.com/discussion/thread/1121755/tool-to-launch-lichess-analysis-from-chessable/1123051) |

**Bottom line.** Chessable is *not* Anki. It is a per-move, deterministic,
level-based scheduler. It is closer in spirit to a hand-rolled, chess-specific
SuperMemo variant than to either SM-2 or FSRS, and the rest of this document
extracts the rules precisely enough to re-implement.

---

## 2. The spaced-repetition algorithm

### 2.1 Default 8-level schedule

Chessable's default schedule is published in full in their help centre. The
exact table is:

| Level | Time until next review | XP earned |
|------:|------------------------|----------:|
| 1 | 4 hours  | +40 |
| 2 | 1 day    | +50 |
| 3 | 3 days   | +60 |
| 4 | 1 week   | +70 |
| 5 | 2 weeks  | +80 |
| 6 | 1 month  | +90 |
| 7 | 3 months | +100 |
| 8 | 6 months | >100 (cycles) |

*Source: [How does the spaced repetition scheduling work?](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work),
[What is the Schedule setting?](https://support.chessable.com/en/articles/9043243-what-is-the-schedule-setting).*

Observations:

- The interval roughly doubles every 2 levels. `Level 8` is the asymptote —
  Chessable does **not** keep growing the interval past 6 months, it just
  cycles. *"If you get above 100 XP points on a move, it means that you've
  correctly guessed another Level 8."* ([source](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work))
- Each move stores its own level and timestamp. *"Each move in a variation
  has its own timer, so you can be at different levels within the same
  variation."* ([source](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work))
- The XP curve is a *cosmetic overlay*; the algorithm itself is purely the
  level+interval table.
- The intervals are **suggestions**, not strict deadlines. If a user is a few
  days late the move is still shown at the same next level (unless they get it
  wrong, in which case it drops to level 1). ([source](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work))

### 2.2 What "right" and "wrong" do

The state-transition rules are *not* published as a single table, but can be
reconstructed from three facts:

1. *"If you get things right, the timing between revisions increases. If you
   get things wrong, you are back to the beginning and the timing until the
   next revision reverts to a shorter period of time again."*
   ([source](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work))
2. *"At worst, you will get a position wrong, and it will revert back to
   Level 1."*
   ([source](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work))
3. *"The correct moves will move on to the next level while the incorrect
   move will fall back to level one and will be due for review after 4
   hours."*
   ([source](https://support.chessable.com/en/articles/9047490-review-whole-variation-vs-randomized))

So the transition function is:

```
review(move m, outcome o):
    if o == CORRECT:
        m.level = min(8, m.level + 1)
        m.xp   += XP_TABLE[m.level]              # post-increment or pre?
    else:                                       # WRONG or SOFT_FAIL_DROP
        m.level = 1
        m.xp   -= some penalty (not public)     # see §2.5
    m.next_due = now() + INTERVALS[m.level]
```

The single-step on a correct answer is confirmed by users who observe
*"I've reduced the default settings from 4 hours x2.5, to 4 hours x2, which
gives level 8 spacing at 1 month"* — i.e. doubling the *base* interval
halves the *final* interval, which only makes sense if the schedule is
geometric with one step per correct answer. ([source](https://www.chessable.com/discussion/thread/445916/struggling-with-spaced-repetition/455320))

**Inferred.** The interval is therefore `BASE_LEVEL_K` (one value per level,
not a running product), exactly as published. A passing resemblance to SM-2's
`I(n) = I(n-1) * EF` is a coincidence: SM-2's ease factor lives on the
*card*, Chessable's "ease" lives on the *user schedule* and is constant per
level.

### 2.3 Soft fails: an in-between outcome

Soft fails are Chessable's answer to *"what if the user played a different
but reasonable move?"* Three evaluation policies are documented:

| Course type | Soft-fail rule |
|---|---|
| **Endgame** | All alternative moves the 6-piece Lomonosov tablebase considers equivalent / winning. |
| **Tactics** | Moves that also lead to mate or to a position within a 1.0-pawn evaluation margin. |
| **Opening** | Alternative moves within a 0.3-pawn margin of the engine's best move, computed by a dedicated multi-core engine given 5 s per position. |

*Source: [What are "soft fail" moves?](https://support.chessable.com/en/articles/9043806-what-are-soft-fail-moves).*

Behaviour of a soft-fail on a *Learn* review is documented separately:

> *"Soft fail: usually they are alternative or slightly weaker moves that do
> not have an impact on the points you earn... If you make a soft fail move,
> the timer [does not reset]."*
> ([source](https://www.chessable.com/discussion/thread/333210/how-are-points-for-the-moves-determined))

So a soft fail is a **third outcome**, distinct from CORRECT and WRONG. It
*does not* drop the level back to 1. The exact XP delta is not published
(community tests suggest a smaller credit than a clean correct). For our
re-implementation we model it as a graded outcome between correct and wrong.

### 2.4 Other schedule modes

In addition to the default 8-level schedule, three other scheduling modes
exist:

1. **Custom schedule** — user enters an interval for each level, or sets a
   single "interval multiplier" applied to all default intervals.
   *"Level 1 – 0 days, 6 hours. Level 8 – 83 days, 20 hours"*
   ([source](https://www.chessable.com/discussion/thread/1296899/optimizing-the-spaced-repetition-schedule-srs-settings))
2. **Cyclical schedule** — the user sets a date; all reviews are deferred to
   that date. Used by the Woodpecker Method and similar cycle-based training.
   *"With a cyclical schedule, you can set your own date when your exercises
   should next pop up for review."*
   ([source](https://support.chessable.com/en/articles/9043243-what-is-the-schedule-setting))
   Implementation detail: *"Setting a cyclical date/period will delay all
   existing reviews until this date, even if they are ready."*
3. **FastTrack** (PRO feature) — skip the early levels.
   *"When you set this in your book options, the scheduling will fast forward
   through the early reviews and present the position to you only after a
   week or a month, depending on what you've chosen."* (Fast / Super Fast
   options.)
   ([source](https://www.chessable.com/blog/fasttrack-the-new-pro-feature-that-lets-you-set-the-pace))
   Failure semantics are unchanged — a wrong answer at the FastTrack level
   still drops to rock bottom.

### 2.5 Why this is **not** SM-2 and **not** FSRS

Many users (correctly) notice that Chessable is similar to Anki but is not
Anki:

> *"Spaced repetition in Chessable is basically spacing intervals to the
> next repetition in a deterministic way, i.e. 4 hours, 1 day, 3 days, etc."*
> ([source](https://www.chessable.com/discussion/thread/1293280/anki-spaced-repetition-fsrs/1293885))

Differences from SM-2 / FSRS:

- **No per-card ease factor.** Chessable's intervals are a function of the
  *level* alone, not of any per-card parameter. A level-5 move always waits
  2 weeks, regardless of past behaviour. SM-2/FSRS vary intervals per card
  based on review history.
- **No partial grading in the default flow.** SM-2 takes a 0–5 quality; FSRS
  takes Again/Hard/Good/Easy. Chessable's default review is a binary
  correct/wrong with a third "soft fail" outcome.
- **Deterministic, not stochastic.** The next due date is `now + table[level]`,
  full stop. There is no "forgetting probability" computation.
- **No collection-level optimisation.** FSRS tunes its parameters from a
  user's review history. Chessable's schedule is global and immutable per
  course.

This has two practical consequences for re-implementers:

1. A super-faithful SM-2/FSRS port is **not** what makes Chessable feel like
   Chessable. The 4 h → 1 d → 3 d → 1 w → 2 w → 1 mo → 3 mo → 6 mo cadence
   is the product.
2. The 0.3-eval-margin soft-fail precomputation is a major piece of the
   backend (engine farm, 5 s × ~thousands of positions per course). It is
   the single hardest feature to clone.

### 2.6 Pseudo-code (clean-room re-implementation)

```python
# Chessable default schedule.
LEVELS = 8
INTERVALS = [
    timedelta(hours=4),   # level 1 (never actually shown — see below)
    timedelta(hours=4),   # level 1
    timedelta(days=1),    # level 2
    timedelta(days=3),    # level 3
    timedelta(weeks=1),   # level 4
    timedelta(weeks=2),   # level 5
    timedelta(days=30),   # level 6 (approx 1 month)
    timedelta(days=90),   # level 7
    timedelta(days=180),  # level 8
]
XP_TABLE = {1: 40, 2: 50, 3: 60, 4: 70, 5: 80, 6: 90, 7: 100, 8: 110}

def review(move: Move, outcome: Outcome, now: datetime) -> None:
    if outcome is Outcome.CORRECT:
        move.level = min(LEVELS, move.level + 1)
        move.xp_gain += XP_TABLE[move.level]
    elif outcome is Outcome.SOFT_FAIL:
        # No level change. Soft XP credit (we use +20, unverified).
        move.xp_gain += 20
    else:  # Outcome.WRONG
        move.level = 1
        move.xp_gain = 0          # reset? unclear; not displayed
    move.next_due = now + INTERVALS[move.level]

def due_moves(moves: list[Move], now: datetime) -> list[Move]:
    return [m for m in moves if m.next_due <= now]
```

Notes:

- The "level 0" entry is intentional bookkeeping — a move that has never
  been reviewed is shown as soon as the user enters Learn mode.
- `INTERVALS[1]` is 4 h, so the first *review* of a newly-learned move is
  4 h later. This matches the published table.
- We do not model the +0.5–1 day forgiveness window explicitly; treating
  the due check as `<= now` is sufficient.

---

## 3. The data model — what is a "move to learn"?

A Chessable review queue is a list of "move cards", each roughly shaped as
follows. This is **inferred** from observable behaviour and forum answers;
Chessable has no public schema and the database is closed source.

| Field | Type | Description |
|---|---|---|
| `id` | int | Stable identifier. |
| `user_id` | int | Owning user. |
| `course_id` | int | Owning course. |
| `chapter_id` | int | Owning chapter. |
| `variation_id` | int | Owning variation. |
| `side` | enum {white, black} | Whose turn it is in `position_fen`. |
| `position_fen` | str | FEN **before** the move. |
| `expected_uci` | str | Authoritative move (LAN). |
| `expected_san` | str | Authoritative move (SAN, with disambiguation). |
| `alternates` | list[(uci, san, eval_margin)] | Pre-computed soft-fail alternatives. |
| `is_tactics_puzzle` | bool | Treated as puzzle, not opening. |
| `key_move` | bool | Marked as a "key move" by the author (priority line). |
| `level` | int ∈ {1..8} | Current spaced-repetition level. |
| `next_due` | datetime | When the move is due for review. |
| `xp_total` | int | Lifetime XP earned on this card. |
| `fail_count` | int | Times the user has got this wrong. Used to compute "Difficult" status. |
| `last_reviewed_at` | datetime | Last review timestamp (nullable). |
| `paused` | bool | Excluded from the queue. |

Three things follow directly from this shape:

1. **State is per-move, not per-variation.** A 15-move variation has 15
   independent level/timer/due triples.
   ([source](https://support.chessable.com/en/articles/9047490-review-whole-variation-vs-randomized))
2. **The PGN is the source of truth, not the database.** A move is uniquely
   identified by `(course, chapter, variation, side, position_fen, expected_uci)`.
   Re-importing the same PGN re-binds moves to the same cards. (Inferred from
   Chessable's "Beta test re-import" workflow in the
   [Course Creation Guide](https://go.chessable.com/create/chessable-course-creation-guide).)
3. **`position_fen` + `side` + `expected_uci` is a complete training prompt.**
   The board is set up at `position_fen`; the user must play `expected_uci` (or
   an `alternates` entry) to count as correct.

---

## 4. Course structure

### 4.1 The hierarchy

```
Course          — a published book (e.g. "Keep It Simple 1.e4")
├── Chapter 1   — typically a major part / topic ("Italian Game")
│   ├── Variation 1.1   — mainline (e.g. Giuoco Piano)
│   │   ├── Move 1.1.1  (the "Card")
│   │   ├── Move 1.1.2
│   │   └── …
│   └── Variation 1.2   — sideline
└── Chapter 2   — another part
```

References:

- The **Course Creation Guide** calls a course *"a digital chess book"* and
  shows chapters authored as separate PGN files.
  ([source](https://go.chessable.com/create/chessable-course-creation-guide))
- A **chapter** is a PGN file with one or more games; the games become
  variations within the chapter.
- A **variation** is a contiguous path through the PGN move tree (a line
  of play). In PGN it is either the mainline (no `(...)`) or a Recursive
  Annotation Variation (`( ... )`).
- A **move** is one half-move along a variation, paired with the FEN *before*
  it and the next-move SAN/UCI.

### 4.2 Course types

Chessable offers four course "types":

1. **Openings** — repertoire-style training; soft fails matter, side
   (white/black) matters.
2. **Strategy / Middlegame**.
3. **Tactics** — treated as puzzles; soft-fail margin is 1.0 pawn.
4. **Endgame** — tablebase-driven; soft fails are tablebase-equivalent
   moves.

A course can also have the **"enable tactics functionality"** flag, which
makes individual variations act as tactics puzzles inside an otherwise
non-tactics course. (E.g. an opening book with a "Tactics in the Italian"
chapter.) ([source](https://go.chessable.com/create/chessable-course-creation-guide))

### 4.3 The PGN import pipeline

The Course Creation Guide and several forum threads collectively describe the
import pipeline:

1. **Author writes a PGN per chapter** in ChessBase or any standard PGN
   editor. Annotations go in `{ }` comments; variations go in `( )`. Chessable
   supports the standard seven tags + `[Variant "Fischerandom"]` /
   `[Variant "Standard"]`. ([source](https://www.chessable.com/discussion/thread/214694/creating-a-course-problem/214994))
2. **Visual cues** — `[%csl Yg5][%cal Gf3e5]` arrows/circles — are preserved
   on the rendered board.
3. **Import step "Import all sub-variations as their own item"** — a
   per-PGN toggle that decides whether every `(...)` becomes a *trainable
   sub-variation* or just appears as a comment. *"It will create a trainable
   line for each subvariation your PGN file contains."*
   ([source](https://www.chessable.com/discussion/thread/485029/how-to-import-lines-on-lichess))
4. **Optional **: any line can be marked as a "key move" / "important line"
   so the user can choose to first learn only the critical repertoire.
   ([source](https://www.chessable.com/discussion/thread/694171/comment/694563))
5. **Beta test phase** — the author runs the course end-to-end, then
   publishes.

### 4.4 Course-side (white / black / both)

Openings courses are split by the colour the user is *training to play*.
When you start a course, you pick a side; Chessable then only shows you
moves where `move.side == selected_side`. A "Repertoire" is essentially a
view that lets the user mix lines from multiple courses into a single
side-filtered collection. ([source](https://www.chess.com/news/view/announcing-chessable-repertoire))

The colour binding is per-course: *"in the control panel, opening, strategy
and endgame courses can have the tactics functionality enabled, after which
each trainable line can be manually set to be treated as a tactics puzzle
instead."* ([source](https://go.chessable.com/create/chessable-course-creation-guide))

### 4.5 Lines vs variations vs mainlines

The terms are used slightly loosely on Chessable, but in the PGN sense:

- **Mainline** = the first move at each branch point.
- **Sub-variation** = any `(...)` block.
- **Sideline** = a sub-variation the author marks as low-priority or
  off-the-beaten-path (this is a *narrative* notion, not a PGN one).
- **Line** = any continuous sequence of moves, mainline or not.

In the training UI a "line" is what the user drills: a sequence of moves
shown with commentary between them, all played in order, with the
opponent's moves auto-played by the system. Since June 2025 any subvariation
can be promoted to a "trainable variation" and added to the user's
personal Repertoire. ([source](https://www.chessable.com/blog/train-any-line-you-want-subvariations-are-now-trainable))

---

## 5. The training experience

### 5.1 Two top-level modes

Every course has two tabs at the top of the training page (the exact naming
varies by version but the semantics are stable):

- **Learn** — queue of moves that have never been learned (level 0 / not
  yet introduced) or are below the user's current focus level. The user
  is *introduced* to the line; commentary and diagrams are shown.
- **Review** — queue of moves whose `next_due <= now`. Pure drill, no
  commentary by default; minimum overstudy.

A third mode, **Drill** / **Practice** in some products, does not exist on
Chessable in the same form; it is a setting inside Learn/Review.

### 5.2 Step-by-step: Learn mode

This sequence was reconstructed from Chessable's help docs, the John
Bartholomew MoveTrainer 2.0 demo, and several walkthrough videos. ([MoveTrainer 2.0 video](https://www.youtube.com/watch?v=bJiaLhLlbEw),
[MoveTrainer About page](https://www.chessable.com/movetrainer),
[support: how to use](https://www.chessable.com/discussion/thread/227779/movetrainerhow-to-use-).)

1. **Pick a course and a side** (e.g. "Keep It Simple 1.e4", side = white).
2. **Pick a chapter and a variation.** Many authors use the "Priority Lines"
   setting so that only the most important lines are introduced first.
3. **The board appears** with the starting FEN of the variation. The first
   move is yours (the "opponent's move" was either the literal book start
   or was played by the engine in the previous review).
4. **A short comment** about the position is shown above the board. The
   user is invited to drag the correct move.
5. **The user makes a move.**
   - If the move is the expected one (or a soft-fail alternate), the
     comment for the *next* position is loaded, the opponent's reply is
     auto-played, and the user is invited to play the move after that.
   - If the move is wrong, a "Try again" or "show me" message appears;
     the user can either retry (same level, no XP) or give up (move is
     flagged for review, level 1).
6. **When the variation ends**, the system shows the "All moves" recap and
   pushes the line into the review queue at level 1.

### 5.3 Step-by-step: Review mode

1. **The Time Planner** shows how many due moves exist now and in the
   next hours/days. ([source](https://support.chessable.com/en/articles/9047647-what-is-the-time-planner))
2. **User clicks "Start review"**. The system picks the next due move
   (FIFO within the course, but multiple courses are interleaved).
3. **The board is set to the move's FEN.** No commentary is shown (this
   is the key difference from Learn).
4. **The opponent's previous move is *not* shown as a comment**, but the
   board is already set up at the position *after* the opponent's move —
   the user only ever plays their own side's moves.
5. **User plays a move.**
   - Correct → level + 1, XP awarded, next due move is fetched.
   - Soft fail → no level change, partial XP, next due move is fetched.
   - Wrong → level = 1, immediate re-show of the same move (or the
     remainder of the variation, depending on the *Whole vs Randomized*
     setting — see §5.4).
6. **Session ends** when the queue is empty or the user quits.

### 5.4 Whole-variation vs Randomized review

This is the most important per-course training setting:

- **Whole Variation** — when one move in a variation is due, the system
  replays the *entire* variation, and you play every move in order. This
  "overstudies" the moves you already know but provides context.
  ([source](https://support.chessable.com/en/articles/9047490-review-whole-variation-vs-randomized))
- **Randomized** — only the due moves are shown. They are presented as
  random positions, so you play move 7 without having played 1–6. Lower
  context but no overstudy.
  ([source](https://support.chessable.com/en/articles/9047490-review-whole-variation-vs-randomized))

The setting is per-course; default depends on the author's choice.

### 5.5 How the opponent's moves are played

A naive reading of "play move 5 of the Italian Game" is wrong; the user
does not see any chess engine output. The system is doing this:

- For each "learn" or "review" move card, the FEN is the position **after**
  the opponent's last move and **before** the user's move.
- That FEN is the one shown on the board.
- The user's only required action is to play the next move of their side.

The opponent's move is therefore *baked into the position*, not played
interactively. This is also why the system can drill specific branches of a
variation: each branch simply corresponds to a different FEN in the database.

If the user *wants* the opponent's move to be played dynamically (e.g. to
respond to the user's move in an unmodelled line), they are pushed to the
"Train Against Bots" feature, launched in 2026, which uses a Chess.com bot
from a chosen position. ([source](https://www.chessable.com/blog/train-against-bots-the-highly-requested-feature-is-here))

### 5.6 Variants on the flow

- **"All moves" / "Key moves"** — pick whether the user must play every
  ply or only the ones the author flagged. ([source](https://www.chessable.com/discussion/thread/694171/comment/694563))
- **"Sequentially"** — go through the chapter in order rather than
  randomly. ([source](https://www.chessable.com/discussion/thread/999721/setting-movie-trainer-to-drill-opening-variations-sequentially-/999798))
- **Pause** — exclude a variation from the queue without deleting it.
- **"Overstudied" badge** — when a card is reviewed too soon after its last
  review. ([source](https://support.chessable.com/en/articles/9047490-review-whole-variation-vs-randomized))

---

## 6. How openings, tactics, and endgames differ

The same MoveTrainer engine runs all four course types. The differences are
in the soft-fail policy, in the way PGN is structured, and in the "feel":

| Aspect | Openings | Tactics | Endgames | Strategy |
|---|---|---|---|---|
| **Soft-fail margin** | 0.3 pawn (engine-evaluated) | 1.0 pawn | tablebase-equivalent | usually none |
| **Side selection** | yes (white/black) | no | no | usually no |
| **PGN source** | repertoire games | puzzle FENs + solution | studies with tablebase annotations | annotated model games |
| **Key moves** | very common (repertoire priorities) | rare | rare | rare |
| **Default schedule** | 8-level SRS | 8-level SRS | 8-level SRS | 8-level SRS |
| **Cyclical mode useful?** | sometimes (Woodpecker) | very often (Woodpecker Method) | rare | rare |
| **Whole vs Randomized** | often Randomized (move-order matters less) | often Whole Variation | depends | depends |

([source: support: soft fail](https://support.chessable.com/en/articles/9043806-what-are-soft-fail-moves),
[Course Creation Guide](https://go.chessable.com/create/chessable-course-creation-guide),
[Woodpecker Method](https://www.chessable.com/discussion/thread/33561/the-woodpecker-method-thread/old))

Practically:

- **Tactics + Cyclical = the Woodpecker Method.** This is the dominant
  Chessable tactics flow. A puzzle set is drilled in a 4-week cycle, then
  re-drilled in a 2-week cycle, then a 1-week cycle, etc., until
  everything is solved in <5 min. The "Set the cycle end date" feature
  implements this directly. ([source](https://support.chessable.com/en/articles/9043243-what-is-the-schedule-setting))
- **Openings + Soft-fail + Randomized = serious repertoire training.** The
  user only needs to enter the *right kind* of move, not the exact book
  move, as long as the engine agrees.
- **Endgames + tablebase = unique** because the soft-fail list is exact
  and finite; the user can in principle play *any* move that draws or
  wins, and the system will accept it. This is why endgame courses are
  the easiest to "drill through" without error.

---

## 7. Auxiliary features

### 7.1 Learning status

A per-course dashboard classifies every variation into one of:

- **Not learned** — never touched.
- **Paused** — user paused.
- **Learning** — currently at levels 1–7.
- **Mature** — at level 8+.
- **Difficult** — frequently failed. (Triggered when the XP never climbs
  past ~60.)

([source: support: learning status](https://support.chessable.com/en/articles/9027843-what-is-learning-status),
[support: how calculated](https://support.chessable.com/en/articles/9044158-how-is-the-learning-status-calculated),
[community thread](https://www.chessable.com/discussion/thread/254527/difficult-moves-in-learning-status))

Note the "Difficult" status is **per move**, not per variation — a single
move that the user keeps failing will tag the whole variation as Difficult
even if the rest is mature.

### 7.2 Time Planner

A simple widget that shows "**X reviews due in next Y hours**" with
traffic-light colour coding (Very low / Low / Normal / High / Very High)
based on the next 4 hours and the next 24 hours. The thresholds are
empirical; the help article shows a screenshot. ([source](https://support.chessable.com/en/articles/9047647-what-is-the-time-planner))

Inferred schema: `due_count(now, +4h)` and `due_count(now, +24h)` over the
union of all enrolled courses. A user request to "show by variation" has
not been implemented as of writing.

### 7.3 Analysis board

Chessable's own analysis board is an in-page engine (community reports
suggest Stockfish) that loads the current FEN and lets the user explore.
There is no API; it is purely visual.

Workarounds:

- A community-maintained **bookmarklet** that takes the current page's FEN
  and opens it in Lichess's analysis board. The bookmarklet is essentially
  a "click → redirect to `https://lichess.org/analysis/<FEN>`" glue.
  ([source](https://www.chessable.com/discussion/thread/1121755/tool-to-launch-lichess-analysis-from-chessable/1123051))
- A "Find FEN in courses" tool under **Tools → Analysis Board**: paste a
  FEN, see which courses/variations contain it.
  ([source](https://www.chessable.com/discussion/thread/448338/tools-dropdown-find-fen-in-courses/old))

### 7.4 Repertoire builder

A 2024 feature that lets a user cherry-pick lines from *any* course they
own and assemble a personal Repertoire. Each line can be edited (comments,
key moves, alternative moves) without affecting the source course.
([source: Chess.com announcement](https://www.chess.com/news/view/announcing-chessable-repertoire))
Combined with the June 2025 *"Train any line you want"* update, every
clickable sub-variation can now be promoted to a trainable variation in
the user's Repertoire. ([source](https://www.chessable.com/blog/train-any-line-you-want-subvariations-are-now-trainable))

### 7.5 Bot training (2026)

A "play from this position against a Chess.com bot" feature, free for all
users. The bot plays the opponent's side; the user practices carrying the
position out of the book into the middlegame. Elo range 250–3200.
([source](https://www.chessable.com/blog/train-against-bots-the-highly-requested-feature-is-here))

### 7.6 FastTrack

PRO-only. Compresses the early levels: "Fast" skips to a 1-week first
review, "Super Fast" skips to a 1-month first review. Subsequent failures
still drop to level 1. ([source](https://www.chessable.com/blog/fasttrack-the-new-pro-feature-that-lets-you-set-the-pace))

### 7.7 Gamification (XP, rubies, streaks)

Each correct review awards XP per the table in §2.1. The "rubies" currency
is awarded at end-of-course and can be spent on board themes. There is a
"streak" counter for consecutive days of review. None of this affects the
algorithm. ([gamification blog](https://www.chessable.com/blog/gamification-rubies-on-chessable) — community notes)

---

## 8. Algorithmic pseudocode for the MoveTrainer core

Putting §2–§5 together, a clean-room re-implementation of the per-card
scheduler is small:

```python
# Configurable per course.
DEFAULT_LEVELS = [
    timedelta(hours=4),   # level 1
    timedelta(days=1),    # level 2
    timedelta(days=3),    # level 3
    timedelta(weeks=1),   # level 4
    timedelta(weeks=2),   # level 5
    timedelta(days=30),   # level 6
    timedelta(days=90),   # level 7
    timedelta(days=180),  # level 8
]
XP = {1: 40, 2: 50, 3: 60, 4: 70, 5: 80, 6: 90, 7: 100, 8: 110}

# State.
@dataclass
class Card:
    fen: str
    expected_uci: str
    expected_san: str
    alternates: list[tuple[str, str, float]] = field(default_factory=list)
    side: Side = Side.WHITE
    level: int = 0
    next_due: datetime = field(default_factory=lambda: datetime.min)
    fail_count: int = 0
    xp_total: int = 0
    paused: bool = False

# Core loop.
def review(card: Card, move: Move, schedule=DEFAULT_LEVELS, now=None) -> Outcome:
    if _is_correct(card, move):
        card.level = min(8, max(1, card.level + 1))
        card.xp_total += XP[card.level]
        card.next_due = now + schedule[card.level - 1]
        return Outcome.CORRECT
    if _is_soft_fail(card, move):
        # No level change; partial XP.
        card.xp_total += 20
        card.next_due = now + schedule[card.level - 1]
        return Outcome.SOFT_FAIL
    # Wrong
    card.level = 1
    card.fail_count += 1
    card.next_due = now + schedule[0]
    return Outcome.WRONG

def due_queue(cards: list[Card], now) -> list[Card]:
    return [c for c in cards if not c.paused and c.next_due <= now]

def learn_intro(card: Card) -> None:
    # Walk the variation. Play opponent moves from the PGN. Queue the
    # user-side cards for review at level 1.
    ...
```

### 8.1 Where this differs from a plain SM-2 port

| Concern | Plain SM-2 (current Open-Chessable) | Chessable MoveTrainer |
|---|---|---|
| Ease factor | per card | not used; level only |
| Quality grades | 0–5 | correct / soft-fail / wrong |
| Interval formula | `prev * EF` | `TABLE[level]` |
| Long-term ceiling | unbounded | 6 months (cycles) |
| Partial credit | yes (q = 3 vs q = 4) | soft-fail (engine-judged) |
| Soft fails | not modelled | core feature |
| Per-move vs per-card | per-card | per-move (cards = positions-to-move) |

A faithful Chessable clone does not need SM-2; the table-based scheduler is
simpler and produces the right "feel". The *interesting* engineering is
elsewhere: PGN parsing, soft-fail precomputation, and the variation-aware
review queue.

---

## 9. Recommended data model for Open-Chessable

To stay close to Chessable's behaviour while keeping the SM-2 backbone
already in the codebase, the recommended schema is a hybrid:

```sql
-- Per-move card (Chessable-style) sits on top of per-card SM-2 state.
CREATE TABLE cards (
    id              INTEGER PRIMARY KEY,
    course_id       INTEGER NOT NULL,
    chapter_id      INTEGER NOT NULL,
    variation_id    INTEGER NOT NULL,
    side            TEXT CHECK(side IN ('white','black')),
    position_fen    TEXT NOT NULL,
    expected_uci    TEXT NOT NULL,
    expected_san    TEXT NOT NULL,
    alternates_json TEXT,         -- soft-fail list
    key_move        BOOLEAN DEFAULT 0,
    is_tactics      BOOLEAN DEFAULT 0,

    -- Spaced-repetition state (Chessable-style).
    level           INTEGER DEFAULT 0,  -- 0 = not learned
    next_due        DATETIME,
    fail_count      INTEGER DEFAULT 0,
    xp_total        INTEGER DEFAULT 0,
    paused          BOOLEAN DEFAULT 0,

    -- Optional SM-2 mirror for backwards compat.
    ease_factor     REAL DEFAULT 2.5,
    interval_days   REAL DEFAULT 0,
    repetitions     INTEGER DEFAULT 0,
    last_reviewed   DATETIME,

    UNIQUE (course_id, variation_id, position_fen, expected_uci)
);
```

The scheduler function should dispatch on `course.schedule_type`:

```python
def schedule(card, outcome, now):
    if course.schedule_type == "chessable_default":
        return chessable_default_review(card, outcome, now)
    elif course.schedule_type == "chessable_custom":
        return chessable_custom_review(card, outcome, now, course.intervals)
    elif course.schedule_type == "chessable_cyclical":
        return chessable_cyclical_review(card, outcome, now, course.cycle_end)
    elif course.schedule_type == "chessable_fasttrack":
        return chessable_fasttrack_review(card, outcome, now, course.fasttrack_mode)
    elif course.schedule_type == "sm2":
        return sm2_review(card, outcome, now)
    else:
        raise ValueError(...)
```

This keeps the existing SM-2 code path intact (and so keeps the existing
README examples and test data valid) while exposing a second, more
faithful Chessable-like scheduler behind a feature flag.

---

## 10. Source bibliography

Authoritative documentation (Chessable Help Center):

- [How does the spaced repetition scheduling work?](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work)
- [What is the Schedule setting?](https://support.chessable.com/en/articles/9043243-what-is-the-schedule-setting)
- [What is "Learning Status"?](https://support.chessable.com/en/articles/9027843-what-is-learning-status)
- [How is the learning status calculated?](https://support.chessable.com/en/articles/9044158-how-is-the-learning-status-calculated)
- [What are "soft fail" moves?](https://support.chessable.com/en/articles/9043806-what-are-soft-fail-moves)
- [Review 'Whole Variation' vs 'Randomized'](https://support.chessable.com/en/articles/9047490-review-whole-variation-vs-randomized)
- [What is the time planner?](https://support.chessable.com/en/articles/9047647-what-is-the-time-planner)

Chessable blog posts:

- [FastTrack: The new PRO feature that lets you set the pace](https://www.chessable.com/blog/fasttrack-the-new-pro-feature-that-lets-you-set-the-pace)
- [Train Against Bots: The Highly Requested Feature Is Here!](https://www.chessable.com/blog/train-against-bots-the-highly-requested-feature-is-here)
- [Train any line you want: Subvariations are now trainable](https://www.chessable.com/blog/train-any-line-you-want-subvariations-are-now-trainable)
- [Changes to Chessable and Chessable PRO (Jan 2025)](https://www.chessable.com/blog/new-year-big-changes-to-chessable-pro)
- [About MoveTrainer](https://www.chessable.com/movetrainer)

Author guides:

- [Chessable Course Creation Guide](https://go.chessable.com/create/chessable-course-creation-guide)
- [Content Creation Guide - Opening Course 2023 (mirrored)](https://www.cliffsnotes.com/study-notes/21864741)

Forum threads (community-observed behaviour):

- [Spaced repetition in Chessable is deterministic](https://www.chessable.com/discussion/thread/1293280/anki-spaced-repetition-fsrs/1293885)
- [Default Spaced Repetition](https://www.chessable.com/discussion/thread/1045428/default-spaced-repetition)
- [Struggling with spaced repetition](https://www.chessable.com/discussion/thread/445916/struggling-with-spaced-repetition/455320)
- [Difficult moves in learning status](https://www.chessable.com/discussion/thread/254527/difficult-moves-in-learning-status)
- [Mature learning status](https://www.chessable.com/discussion/thread/478620/mature-learning-status)
- [How are points for the moves determined?](https://www.chessable.com/discussion/thread/333210/how-are-points-for-the-moves-determined)
- [Import all sub-variations as their own item](https://www.chessable.com/discussion/thread/485029/how-to-import-lines-on-lichess)
- [Tool to launch Lichess Analysis from Chessable](https://www.chessable.com/discussion/thread/1121755/tool-to-launch-lichess-analysis-from-chessable/1123051)
- [Tools dropdown: Find FEN in courses](https://www.chessable.com/discussion/thread/448338/tools-dropdown-find-fen-in-courses/old)
- [The Woodpecker Method Thread](https://www.chessable.com/discussion/thread/33561/the-woodpecker-method-thread/old)

External / context:

- [Andy's working notes: Chessable MoveTrainer](https://notes.andymatuschak.org/zDr94hP6bG3jJYrdYy8B5hx)
- [Disco Chess vs Chessable](https://www.discochess.com/blog/comparisons/disco-chess-vs-chessable)
- [Chess.com announcement of Repertoire feature](https://www.chess.com/news/view/announcing-chessable-repertoire)
- [MoveTrainer 2.0 video (John Bartholomew)](https://www.youtube.com/watch?v=bJiaLhLlbEw)
- [SM-2 vs FSRS background (Diane AI)](https://www.diane.app/en/guides/fsrs-vs-sm2)
- [Anki FAQ: spaced repetition algorithms](https://faqs.ankiweb.net/what-spaced-repetition-algorithm)

---

## 11. Open questions and inferred behaviour

These are things we *think* Chessable does but where we lack direct
confirmation. Useful to verify before relying on them in a clone:

1. **Is `next_due` actually `last_reviewed + INTERVAL[level]`, or `now +
   INTERVAL[level]` at the moment of review?** All evidence points to
   `now + INTERVAL[level]` (i.e. the next due is anchored to the moment of
   review, not the originally scheduled time), but a user being "a few
   days late" is explicitly OK, which suggests the check is just
   `next_due <= now` with no penalty. (Inferred from
   [support: scheduling](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work).)
2. **What is the exact XP delta on a soft fail?** Probably 0–30, but no
   document we found states it. (Inferred.)
3. **Does a successful Level 8 review reset the timer to 6 months or stay
   at 6 months?** The XP table is ambiguous; the safest interpretation is
   "stays at 6 months, keeps cycling". (Inferred.)
4. **Is the "Difficult" status purely based on `fail_count > threshold`?**
   Plausible; community says "Once you get +60 for a move, the move is
   promoted from 'Difficult' to the 'Learning' status."
   ([source](https://www.chessable.com/discussion/thread/254527/difficult-moves-in-learning-status))
   So *XP*, not fail count, drives the transition.
5. **Is there any per-user tuning?** No evidence of any; the schedule is
   global.
6. **How is the soft-fail list actually exposed at review time?** Almost
   certainly precomputed at import time and stored on the card
   (`alternates_json` in §9). Recomputing at review time would not scale.

---

## 12. TL;DR for the Open-Chessable roadmap

If we want a re-implementation that *feels* like Chessable, the priority
order is:

1. **Per-move state model** with `level`, `next_due`, `xp_total`, `fail_count`.
2. **8-level default scheduler** (the table in §2.1). Drop in addition to
   the existing SM-2.
3. **Per-move card generation from PGN** with sub-variations as separate
   cards when the import flag is on. Currently the codebase already walks
   the PGN tree but treats it as one card per leaf; we need to
   *intermediate* FENs as cards.
4. **Soft-fail alternates** — ship a v1 with author-supplied
   `[alt moves]` annotations in the PGN; leave engine precomputation as
   a v2.
5. **Whole-variation vs Randomized review** setting.
6. **Time Planner** widget.
7. **Cyclical schedule** (Woodpecker Mode).
8. **FastTrack** (PRO feature analogue).
9. **Bot training** (much later — requires a real opponent engine).

Steps 1–3 are enough to make Open-Chessable *look* like Chessable; step 4
is what makes it *feel* like Chessable.
