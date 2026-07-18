"""Open-Chessable core package."""

from .database import init_db
from .srs import review_move, get_quality_label, get_mastery_level
from .course_manager import (
    create_course,
    get_courses,
    get_course,
    delete_course,
    create_chapter,
    get_chapters,
    delete_chapter,
    import_pgn_to_chapter,
    get_due_moves,
    get_move,
    update_move_review,
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
    "review_move",
    "get_quality_label",
    "get_mastery_level",
    "parse_pgn",
    "parse_pgn_file",
    "create_course",
    "get_courses",
    "get_course",
    "delete_course",
    "create_chapter",
    "get_chapters",
    "delete_chapter",
    "import_pgn_to_chapter",
    "get_due_moves",
    "get_move",
    "update_move_review",
    "get_stats",
]
