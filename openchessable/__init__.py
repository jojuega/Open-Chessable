"""Open-Chessable core package."""

from .database import init_db, DEFAULT_SCHEDULE_TYPE
from .srs import (
    # SM-2 (legacy)
    INITIAL_EASE_FACTOR,
    MIN_EASE_FACTOR,
    review_move,
    get_quality_label,
    get_mastery_level,
    # Chessable 8-level
    CHESSABLE_LEVELS,
    CHESSABLE_INTERVALS,
    CHESSABLE_XP,
    CHESSABLE_SOFT_FAIL_XP,
    OUTCOME_CORRECT,
    OUTCOME_WRONG,
    OUTCOME_SOFT_FAIL,
    VALID_OUTCOMES,
    SCHEDULE_CHESSABLE,
    SCHEDULE_SM2,
    ChessableCard,
    interval_for_level as chessable_interval,
    xp_for_level as chessable_xp,
    chessable_review,
    is_due,
    is_in_learn_queue,
    due_in,
    learn_queue,
    get_learning_status,
    apply_review,
)
from .course_manager import (
    create_course,
    get_courses,
    get_course,
    update_course,
    delete_course,
    create_chapter,
    get_chapters,
    delete_chapter,
    import_pgn_to_chapter,
    get_due_moves,
    get_learn_queue,
    get_move,
    update_move_review,
    apply_review_to_move,
    get_stats,
)

# PGN parser is optional (requires python-chess)
try:
    from .pgn_parser import parse_pgn, parse_pgn_file
except ImportError:
    parse_pgn = None
    parse_pgn_file = None

__all__ = [
    "init_db",
    "DEFAULT_SCHEDULE_TYPE",
    # SM-2
    "INITIAL_EASE_FACTOR", "MIN_EASE_FACTOR",
    "review_move", "get_quality_label", "get_mastery_level",
    # Chessable
    "CHESSABLE_LEVELS", "CHESSABLE_INTERVALS", "CHESSABLE_XP",
    "CHESSABLE_SOFT_FAIL_XP",
    "OUTCOME_CORRECT", "OUTCOME_WRONG", "OUTCOME_SOFT_FAIL", "VALID_OUTCOMES",
    "SCHEDULE_CHESSABLE", "SCHEDULE_SM2",
    "ChessableCard",
    "chessable_interval", "chessable_xp",
    "chessable_review",
    "is_due", "is_in_learn_queue", "due_in", "learn_queue",
    "get_learning_status",
    "apply_review",
    # Course management
    "create_course", "get_courses", "get_course", "update_course", "delete_course",
    "create_chapter", "get_chapters", "delete_chapter",
    "import_pgn_to_chapter",
    "get_due_moves", "get_learn_queue",
    "get_move", "update_move_review", "apply_review_to_move",
    "get_stats",
    # PGN
    "parse_pgn", "parse_pgn_file",
]
