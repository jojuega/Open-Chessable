"""
Open-Chessable: SQLite database module
======================================

Schema overview
---------------

* ``courses``       — top-level book (e.g. "Keep It Simple 1.e4").
                      Has a ``schedule_type`` that picks between the
                      Chessable 8-level scheduler (default) and the
                      legacy SM-2.
* ``chapters``      — a chapter inside a course.
* ``moves``         — one row per *position-to-move pair* (a "card" in
                      Chessable parlance).  The FEN is the position
                      *before* the move; ``move_uci`` is the move the
                      user must play.

The ``moves`` table carries BOTH:

* **Chessable fields** — ``level`` (0=not learned, 1..8), ``next_due``,
  ``fail_count``, ``xp_total``, ``paused``, ``key_move``,
  ``alternates_json``, ``is_tactics``.  These are the
  RESEARCH.md §3 schema.  ``next_due`` is stored as an ISO 8601 string
  to keep the existing schema string-based and portable.
* **SM-2 mirror** — ``ease_factor``, ``interval``, ``repetitions``,
  ``next_review`` (legacy column, used when the course is configured
  for SM-2).  Kept for backward compatibility with the original
  schema and any pre-existing training data.

This module is deliberately idempotent: the first call to
``init_db()`` creates everything; subsequent calls only run
``ALTER TABLE ... ADD COLUMN`` migrations to bring old databases up to
date.
"""

import os
import sqlite3
from datetime import datetime

DB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DB_PATH = os.path.join(DB_DIR, "openchessable.db")


# ─── Default schedule type for new courses ───────────────────────────────
DEFAULT_SCHEDULE_TYPE = "chessable_8level"


def get_connection():
    """Get a database connection with foreign keys enabled and thread-safe access."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    """Return True if ``column`` exists in ``table``."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    """Idempotent ``ALTER TABLE ADD COLUMN``."""
    if not _column_exists(conn, table, column):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db():
    """Initialize / migrate the database schema.

    Safe to call repeatedly: tables are created with
    ``CREATE TABLE IF NOT EXISTS``, and new columns are added via
    ``ALTER TABLE`` only when missing.
    """
    conn = get_connection()
    cursor = conn.cursor()

    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS courses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            video_url TEXT DEFAULT '',
            color_side TEXT DEFAULT 'both',  -- 'white', 'black', 'both'
            schedule_type TEXT DEFAULT 'chessable_8level',  -- 'chessable_8level' | 'sm2'
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chapters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            video_url TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS moves (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chapter_id INTEGER NOT NULL,
            fen TEXT NOT NULL,
            move_uci TEXT NOT NULL,
            move_san TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('white', 'black')),
            move_number INTEGER DEFAULT 0,
            comment TEXT DEFAULT '',

            -- ── Chessable 8-level SRS state (RESEARCH.md §3) ──
            level          INTEGER DEFAULT 0,  -- 0 = not learned, 1..8 = trained
            next_due       TEXT,               -- ISO datetime, due for Review
            fail_count     INTEGER DEFAULT 0,
            xp_total       INTEGER DEFAULT 0,
            paused         INTEGER DEFAULT 0,  -- 0/1
            key_move       INTEGER DEFAULT 0,  -- 0/1
            is_tactics     INTEGER DEFAULT 0,  -- 0/1
            alternates_json TEXT,              -- JSON list of [uci, san, eval_margin?]

            -- ── SM-2 mirror (legacy / fallback) ──
            ease_factor    REAL DEFAULT 2.5,
            interval       INTEGER DEFAULT 0,
            repetitions    INTEGER DEFAULT 0,
            next_review    TEXT,               -- legacy column; equals next_due on writes
            last_reviewed  TEXT,
            created_at     TEXT DEFAULT (datetime('now')),

            FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
        );
    """)

    # ── Migrations for pre-existing databases that predate the
    # ── Chessable refactor.  Each is a no-op once applied.
    _add_column_if_missing(conn, "courses", "schedule_type",
                           f"TEXT DEFAULT '{DEFAULT_SCHEDULE_TYPE}'")

    for col, defn in [
        ("level", "INTEGER DEFAULT 0"),
        ("next_due", "TEXT"),
        ("fail_count", "INTEGER DEFAULT 0"),
        ("xp_total", "INTEGER DEFAULT 0"),
        ("paused", "INTEGER DEFAULT 0"),
        ("key_move", "INTEGER DEFAULT 0"),
        ("is_tactics", "INTEGER DEFAULT 0"),
        ("alternates_json", "TEXT"),
    ]:
        _add_column_if_missing(conn, "moves", col, defn)

    # Indexes for the Chessable queue filters (RESEARCH.md §5: due
    # moves are filtered by ``next_due <= now``, learn queue by
    # ``level = 0``).
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_moves_next_due ON moves(next_due)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_moves_level ON moves(level)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_moves_next_review ON moves(next_review)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_moves_chapter ON moves(chapter_id)")
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_moves_unique ON moves(chapter_id, fen, move_uci)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chapters_course ON chapters(course_id)")

    conn.commit()
    conn.close()


def dict_from_row(row):
    """Convert sqlite3.Row to dict."""
    if row is None:
        return None
    return dict(row)


def dicts_from_rows(rows):
    """Convert list of sqlite3.Row to list of dicts."""
    return [dict(row) for row in rows]


def _coerce_bool(v) -> int:
    """Normalise a Python bool/int/None to the 0/1 stored in SQLite."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    return 1 if int(v) else 0


# Run on import
init_db()
