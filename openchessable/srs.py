"""
Open-Chessable: Spaced Repetition System
========================================

Two schedulers live here:

1. **SM-2** (the original SuperMemo SM-2) — the legacy per-card ease-factor
   scheduler. Kept intact for backward compatibility.
2. **Chessable 8-level** — the deterministic, level-based scheduler that
   matches the real Chessable MoveTrainer® behaviour documented in
   ``RESEARCH.md`` §2.1.

The Chessable schedule is a single global table of 8 intervals:

    +-------+--------------------+-------+
    | Level | Interval           | XP    |
    +-------+--------------------+-------+
    |   1   | 4 hours            | +40   |
    |   2   | 1 day              | +50   |
    |   3   | 3 days             | +60   |
    |   4   | 1 week             | +70   |
    |   5   | 2 weeks            | +80   |
    |   6   | 1 month (~30 days) | +90   |
    |   7   | 3 months (~90 days)| +100  |
    |   8   | 6 months (~180 days)| +110  |
    +-------+--------------------+-------+

Outcome rules (see RESEARCH.md §2.2 and §2.3):

* ``correct``  → level = min(8, level + 1), +XP for the new level
* ``soft_fail``→ level unchanged, partial XP credit
* ``wrong``    → level = 1, ``fail_count += 1``

A "level 0" move is a card that has never been reviewed (Learn queue).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional, Iterable


# ════════════════════════════════════════════════════════════════════════
#  SM-2 (legacy) — unchanged from the original implementation.
# ════════════════════════════════════════════════════════════════════════

# SM-2 constants
INITIAL_EASE_FACTOR = 2.5
MIN_EASE_FACTOR = 1.3
INTERVALS = [1, 3, 7, 14, 28, 56, 112, 224]  # Days for first 8 reps (if EF=2.5)


def review_move(move: dict, quality: Optional[int] = None, attempts: int = 1, got_right: bool = True) -> dict:
    """
    Update a move's SRS fields based on training performance.

    Chessable-style SRS: performance is OBSERVED, not self-rated.
    - got_right=True, attempts=1 → quality 5 (perfect)
    - got_right=True, attempts=2 → quality 4 (hesitation)
    - got_right=True, attempts=3+ → quality 3 (difficult)
    - got_right=False → quality 2 (failed, saw answer)

    If `quality` is explicitly provided (backward compat), use that instead.
    """
    if quality is None:
        if got_right and attempts == 1:
            quality = 5  # Perfect — got it on first try
        elif got_right and attempts == 2:
            quality = 4  # Slight hesitation — got it on second try
        elif got_right:
            quality = 3  # Difficult — needed 3+ attempts
        else:
            quality = 2  # Failed — couldn't recall, saw correct answer
    ef = move.get("ease_factor", INITIAL_EASE_FACTOR)
    reps = move.get("repetitions", 0)
    interval = move.get("interval", 0)
    today = date.today().isoformat()
    now = datetime.now().isoformat()

    if quality < 3:
        # Failed — reset repetitions, keep EF, short interval
        reps = 0
        interval = 1
    else:
        # Successful review
        if reps == 0:
            interval = 1
        elif reps == 1:
            interval = 3
        else:
            interval = round(interval * ef)
        reps += 1

    # Update ease factor
    ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    ef = max(MIN_EASE_FACTOR, ef)

    # Calculate next review date
    next_review = (date.today() + timedelta(days=interval)).isoformat()

    return {
        **move,
        "ease_factor": round(ef, 2),
        "interval": interval,
        "repetitions": reps,
        "next_review": next_review,
        "last_reviewed": now,
    }


def get_quality_label(quality: int) -> str:
    """Human-readable label for quality rating."""
    labels = {
        0: "Complete blackout",
        1: "Wrong, looked familiar",
        2: "Wrong, seemed easy",
        3: "Correct, difficult",
        4: "Correct, slight hesitation",
        5: "Perfect recall",
    }
    return labels.get(quality, "Unknown")


def get_mastery_level(move: dict) -> str:
    """Get a human-readable mastery level for a move."""
    reps = move.get("repetitions", 0)
    interval = move.get("interval", 0)

    if reps == 0:
        return "New"
    elif reps <= 2:
        return "Learning"
    elif interval >= 112:
        return "Mastered"
    elif interval >= 28:
        return "Consolidating"
    else:
        return "Learning"


# ════════════════════════════════════════════════════════════════════════
#  Chessable 8-level deterministic scheduler
# ════════════════════════════════════════════════════════════════════════

#: 8 intervals in ``timedelta`` form, indexed by level 1..8.
#: Source: RESEARCH.md §2.1 + https://support.chessable.com/.../9043598
CHESSABLE_LEVELS: int = 8

CHESSABLE_INTERVALS: dict[int, timedelta] = {
    1: timedelta(hours=4),
    2: timedelta(days=1),
    3: timedelta(days=3),
    4: timedelta(weeks=1),
    5: timedelta(weeks=2),
    6: timedelta(days=30),     # ~1 month
    7: timedelta(days=90),     # ~3 months
    8: timedelta(days=180),    # ~6 months
}

#: XP awarded when a card *advances* to this level on a correct review.
#: Source: RESEARCH.md §2.1
CHESSABLE_XP: dict[int, int] = {
    1: 40,
    2: 50,
    3: 60,
    4: 70,
    5: 80,
    6: 90,
    7: 100,
    8: 110,
}

#: Partial XP credit on a soft-fail outcome. RESEARCH.md §2.3 notes the
#: exact number is unpublished; community tests suggest a value well below
#: the correct-advance value, so we use 20.
CHESSABLE_SOFT_FAIL_XP: int = 20

#: Three possible outcomes on a review. The values match the API contract
#: spelled out in the task description.
OUTCOME_CORRECT: str = "correct"
OUTCOME_WRONG: str = "wrong"
OUTCOME_SOFT_FAIL: str = "soft_fail"
VALID_OUTCOMES: tuple[str, ...] = (OUTCOME_CORRECT, OUTCOME_WRONG, OUTCOME_SOFT_FAIL)


# Level categorisation (used by ``get_learning_status`` below).
# Source: RESEARCH.md §7.1
STATUS_NOT_LEARNED: str = "not_learned"
STATUS_PAUSED: str = "paused"
STATUS_LEARNING: str = "learning"
STATUS_MATURE: str = "mature"
STATUS_DIFFICULT: str = "difficult"

#: A move is "Difficult" if it has been failed at least once and its XP
#: has not yet climbed past the level-3 boundary. RESEARCH.md §7.1 and
#: §11.4 (community observation: "Once you get +60 for a move, the move
#: is promoted from 'Difficult' to the 'Learning' status.")
DIFFICULT_XP_THRESHOLD: int = CHESSABLE_XP[3]  # 60


@dataclass
class ChessableCard:
    """A single "move to learn" card in the Chessable model.

    State is per-move (RESEARCH.md §3.1): every position-to-move pair
    carries its own ``level`` and ``next_due``.

    The ``alternates`` field is the soft-fail list — pre-computed at PGN
    import time. Each entry is a ``(uci, san)`` tuple accepted in place
    of the expected move. Engine-eval-margins are an optional third
    element; we keep them only when the importer has them.
    """

    fen: str
    expected_uci: str
    expected_san: str
    side: str = "white"
    alternates: list[tuple[str, str]] = field(default_factory=list)
    key_move: bool = False
    is_tactics: bool = False

    # Spaced-repetition state.
    level: int = 0               # 0 = not learned, 1..8 = trained
    next_due: Optional[datetime] = None
    fail_count: int = 0
    xp_total: int = 0
    paused: bool = False

    # SM-2 mirror (kept for backward compatibility with the legacy DB
    # columns; the SM-2 path writes here when the course uses SM-2).
    ease_factor: float = 2.5
    interval_days: int = 0
    repetitions: int = 0
    last_reviewed: Optional[datetime] = None

    def to_db_dict(self) -> dict:
        """Serialise to the column names used by the SQLite schema."""
        import json as _json
        return {
            "fen": self.fen,
            "move_uci": self.expected_uci,
            "move_san": self.expected_san,
            "side": self.side,
            "level": self.level,
            "next_due": self.next_due.isoformat() if self.next_due else None,
            "fail_count": self.fail_count,
            "xp_total": self.xp_total,
            "paused": int(self.paused),
            "key_move": int(self.key_move),
            "is_tactics": int(self.is_tactics),
            "alternates_json": _json.dumps(
                [list(alt) for alt in self.alternates]
            ) if self.alternates else None,
            "ease_factor": self.ease_factor,
            "interval": self.interval_days,
            "repetitions": self.repetitions,
            "last_reviewed": self.last_reviewed.isoformat() if self.last_reviewed else None,
        }


def interval_for_level(level: int) -> timedelta:
    """Return the Chessable interval for a given level.

    Level 0 (never learned) has no interval — callers should treat
    level-0 cards as immediately due in the Learn queue.
    """
    if level <= 0:
        return timedelta(0)
    if level > CHESSABLE_LEVELS:
        level = CHESSABLE_LEVELS
    return CHESSABLE_INTERVALS[level]


def xp_for_level(level: int) -> int:
    """Return the XP awarded for *reaching* ``level`` after a correct
    review. Level 0 yields 0 (the card was just introduced)."""
    if level <= 0:
        return 0
    if level > CHESSABLE_LEVELS:
        level = CHESSABLE_LEVELS
    return CHESSABLE_XP[level]


def _validate_outcome(outcome: str) -> str:
    """Normalise and validate the outcome string."""
    if outcome is None:
        raise ValueError("outcome is required")
    outcome = str(outcome).lower().strip()
    if outcome not in VALID_OUTCOMES:
        raise ValueError(
            f"outcome must be one of {VALID_OUTCOMES!r}, got {outcome!r}"
        )
    return outcome


def chessable_review(
    move: dict,
    outcome: str,
    now: Optional[datetime] = None,
    intervals: Optional[dict[int, timedelta]] = None,
) -> dict:
    """Apply a Chessable 8-level review to a move dict.

    ``move`` is the card state as a dict (matches the DB row shape). The
    function returns a *new* dict with ``level``, ``next_due``,
    ``fail_count``, ``xp_total``, ``last_reviewed`` updated per the
    deterministic table. The legacy SM-2 columns (``ease_factor``,
    ``interval``, ``repetitions``) are *not* modified here — that
    scheduler is a separate code path.

    Parameters
    ----------
    move:
        Card state. Must contain at least ``level`` (default 0) and may
        contain any other columns; they are passed through unchanged.
    outcome:
        One of ``"correct"``, ``"wrong"``, ``"soft_fail"``.
    now:
        Reference time for the next-due calculation. Defaults to
        ``datetime.now()``.
    intervals:
        Override the default 8-level table (for "custom schedule"
        variants). Defaults to ``CHESSABLE_INTERVALS``.
    """
    outcome = _validate_outcome(outcome)
    if now is None:
        now = datetime.now()
    ivs = intervals or CHESSABLE_INTERVALS

    level = int(move.get("level", 0) or 0)
    xp = int(move.get("xp_total", 0) or 0)
    fail_count = int(move.get("fail_count", 0) or 0)

    if outcome == OUTCOME_CORRECT:
        # Correct → level + 1 (capped at 8). Award XP for the new level.
        new_level = min(CHESSABLE_LEVELS, level + 1) if level >= 1 else 1
        # Promote a fresh (level 0) card to level 1 on its first correct
        # review — RESEARCH.md §5.2 step 6: "the line into the review
        # queue at level 1".
        if level == 0:
            new_level = 1
        xp = xp + xp_for_level(new_level)
        level = new_level

    elif outcome == OUTCOME_SOFT_FAIL:
        # No level change, partial XP credit. RESEARCH.md §2.3.
        xp = xp + CHESSABLE_SOFT_FAIL_XP
        # If the card was level 0, treat the soft-fail as an introduction.
        if level == 0:
            level = 1
        # Note: ``fail_count`` is unchanged — soft fails are not "fails".

    else:  # OUTCOME_WRONG
        # RESEARCH.md §2.2: wrong → level = 1, fail_count += 1.
        level = 1
        fail_count = fail_count + 1

    # Compute next_due from the (possibly new) level.
    interval = ivs.get(level, ivs[CHESSABLE_LEVELS])
    next_due = now + interval

    result = dict(move)  # pass-through any extra columns
    result["level"] = level
    result["xp_total"] = xp
    result["fail_count"] = fail_count
    result["next_due"] = next_due.isoformat()
    result["last_reviewed"] = now.isoformat()
    # Sync the SM-2 mirror columns so the legacy dashboard keeps working.
    result["repetitions"] = max(int(move.get("repetitions", 0) or 0), level)
    result["interval"] = int(interval.total_seconds() // 86400) if interval.total_seconds() >= 86400 else 0
    return result


def is_due(move: dict, now: Optional[datetime] = None) -> bool:
    """True if a move is currently due for *Review* mode.

    A move is due when:
      * ``paused`` is falsy, AND
      * ``level > 0`` (it has been learned — Learn-queue moves are *not*
        due, they're introduced separately), AND
      * ``next_due`` is set and ``<= now``.

    Move-records with ``next_due IS NULL`` are treated as *not yet
    learned* (Learn queue) regardless of level, to match the
    RESEARCH.md "level 0 = not learned" rule.
    """
    if move.get("paused"):
        return False
    if int(move.get("level", 0) or 0) <= 0:
        return False
    nd = move.get("next_due")
    if not nd:
        return False
    if now is None:
        now = datetime.now()
    if isinstance(nd, str):
        try:
            nd = datetime.fromisoformat(nd)
        except ValueError:
            return False
    return nd <= now


def is_in_learn_queue(move: dict) -> bool:
    """True if the move has not been learned yet (level 0 or no
    next_due).  Used by the Learn tab in the trainer UI."""
    if move.get("paused"):
        return False
    return int(move.get("level", 0) or 0) == 0


def get_learning_status(move: dict) -> str:
    """Classify a move into one of the Chessable learning statuses
    (RESEARCH.md §7.1)."""
    if move.get("paused"):
        return STATUS_PAUSED
    level = int(move.get("level", 0) or 0)
    xp = int(move.get("xp_total", 0) or 0)
    if level == 0:
        return STATUS_NOT_LEARNED
    # Difficult = failed at least once AND XP still under the level-3
    # boundary.  See DIFFICULT_XP_THRESHOLD rationale above.
    if int(move.get("fail_count", 0) or 0) > 0 and xp < DIFFICULT_XP_THRESHOLD:
        return STATUS_DIFFICULT
    if level >= CHESSABLE_LEVELS:
        return STATUS_MATURE
    return STATUS_LEARNING


def due_in(moves: Iterable[dict], now: Optional[datetime] = None) -> list[dict]:
    """Filter a list of move dicts to only those currently due.

    Convenience wrapper used by callers that already have the rows in
    memory.
    """
    return [m for m in moves if is_due(m, now=now)]


def learn_queue(moves: Iterable[dict]) -> list[dict]:
    """Filter a list of move dicts to only those in the Learn queue."""
    return [m for m in moves if is_in_learn_queue(m)]


# ════════════════════════════════════════════════════════════════════════
#  Dispatcher — picks the right scheduler per course.
# ════════════════════════════════════════════════════════════════════════

#: Schedule types accepted on a course. The first is the default.
SCHEDULE_CHESSABLE: str = "chessable_8level"
SCHEDULE_CHESSABLE_DEFAULT: str = "chessable_default"  # alias for the above
SCHEDULE_SM2: str = "sm2"
VALID_SCHEDULE_TYPES: tuple[str, ...] = (
    SCHEDULE_CHESSABLE,
    SCHEDULE_CHESSABLE_DEFAULT,
    SCHEDULE_SM2,
)


def apply_review(
    move: dict,
    outcome: Optional[str] = None,
    schedule_type: str = SCHEDULE_CHESSABLE,
    quality: Optional[int] = None,
    attempts: int = 1,
    got_right: bool = True,
    now: Optional[datetime] = None,
) -> dict:
    """Top-level review dispatcher.

    * ``schedule_type == "sm2"`` (or an unknown value, for backward
      compat) → delegate to the legacy SM-2 ``review_move``.
    * ``schedule_type`` starting with ``"chessable"`` →
      ``chessable_review``.

    The legacy ``quality/attempts/got_right`` parameters are ignored
    when the Chessable path is selected (they only make sense for
    SM-2's 0-5 quality scale). They are accepted here so the API can
    pass through whatever the client supplied without branching at
    the call site.
    """
    if schedule_type == SCHEDULE_SM2:
        return review_move(
            move,
            quality=quality,
            attempts=attempts,
            got_right=got_right,
        )
    # Default and any chessable_*-style schedule use the 8-level table.
    return chessable_review(move, outcome or OUTCOME_CORRECT, now=now)


__all__ = [
    # SM-2 (legacy)
    "INITIAL_EASE_FACTOR", "MIN_EASE_FACTOR", "INTERVALS",
    "review_move", "get_quality_label", "get_mastery_level",
    # Chessable 8-level
    "CHESSABLE_LEVELS", "CHESSABLE_INTERVALS", "CHESSABLE_XP",
    "CHESSABLE_SOFT_FAIL_XP",
    "OUTCOME_CORRECT", "OUTCOME_WRONG", "OUTCOME_SOFT_FAIL", "VALID_OUTCOMES",
    "STATUS_NOT_LEARNED", "STATUS_PAUSED", "STATUS_LEARNING",
    "STATUS_MATURE", "STATUS_DIFFICULT",
    "ChessableCard",
    "interval_for_level", "xp_for_level",
    "chessable_review", "apply_review",
    "is_due", "is_in_learn_queue", "get_learning_status",
    "due_in", "learn_queue",
    "SCHEDULE_CHESSABLE", "SCHEDULE_CHESSABLE_DEFAULT", "SCHEDULE_SM2",
    "VALID_SCHEDULE_TYPES",
]
