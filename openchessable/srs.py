"""
Open-Chessable: SM-2 Spaced Repetition System
Based on the SuperMemo SM-2 algorithm adapted for chess move training.
"""

from datetime import datetime, date, timedelta


# SM-2 constants
INITIAL_EASE_FACTOR = 2.5
MIN_EASE_FACTOR = 1.3
INTERVALS = [1, 3, 7, 14, 28, 56, 112, 224]  # Days for first 8 reps (if EF=2.5)


def review_move(move: dict, quality: int = None, attempts: int = 1, got_right: bool = True) -> dict:
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
