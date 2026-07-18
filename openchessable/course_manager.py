"""
Open-Chessable: Course and chapter management
=============================================

Business logic layer between the API and the database.  The
high-level operations supported here are:

* CRUD for courses and chapters.
* PGN import into a chapter (one card per position-to-move pair).
* Trainer queue queries — both Review (``get_due_moves``) and Learn
  (``get_learn_queue``).
* Review application (``apply_review_to_move``) which dispatches to
  the right SRS scheduler based on the course's ``schedule_type``.

The card model follows RESEARCH.md §3: each move is uniquely
identified by ``(chapter, fen, move_uci)`` and carries its own
``level`` / ``next_due`` / ``xp_total`` / ``fail_count`` state.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any, Optional

from .database import (
    DEFAULT_SCHEDULE_TYPE,
    dict_from_row,
    dicts_from_rows,
    get_connection,
)
from .pgn_parser import parse_pgn
from .srs import (
    OUTCOME_CORRECT,
    OUTCOME_SOFT_FAIL,
    OUTCOME_WRONG,
    SCHEDULE_CHESSABLE,
    SCHEDULE_SM2,
    VALID_OUTCOMES,
    VALID_SCHEDULE_TYPES,
    apply_review,
    get_learning_status,
    is_due as _srs_is_due,
    is_in_learn_queue as _srs_is_in_learn_queue,
)


# ─── Courses ────────────────────────────────────────────────────────────

def create_course(
    name: str,
    description: str = "",
    video_url: str = "",
    color_side: str = "both",
    schedule_type: str = DEFAULT_SCHEDULE_TYPE,
) -> dict:
    """Create a new course.

    ``schedule_type`` is one of ``"chessable_8level"`` (default) or
    ``"sm2"``.  An invalid value falls back to the default.
    """
    if schedule_type not in VALID_SCHEDULE_TYPES:
        schedule_type = DEFAULT_SCHEDULE_TYPE
    conn = get_connection()
    cursor = conn.execute(
        "INSERT INTO courses (name, description, video_url, color_side, schedule_type) "
        "VALUES (?, ?, ?, ?, ?)",
        (name, description, video_url, color_side, schedule_type),
    )
    conn.commit()
    course = dict_from_row(
        conn.execute("SELECT * FROM courses WHERE id = ?", (cursor.lastrowid,)).fetchone()
    )
    conn.close()
    return course


def get_courses() -> list:
    """Get all courses with review stats.

    Stats are computed against the Chessable model (level / next_due)
    so that the dashboard reflects "due for review" the way Chessable
    defines it: level 1+ cards whose ``next_due <= now``.  Legacy
    ``interval >= 112`` is kept as the "mastered" definition.
    """
    conn = get_connection()
    today = date.today().isoformat()
    now_iso = datetime.now().isoformat()

    courses = dicts_from_rows(
        conn.execute("SELECT * FROM courses ORDER BY created_at DESC").fetchall()
    )

    for course in courses:
        # Total moves across all chapters in this course.
        total = conn.execute(
            """
            SELECT COUNT(*) FROM moves m
            JOIN chapters ch ON m.chapter_id = ch.id
            WHERE ch.course_id = ?
            """,
            (course["id"],),
        ).fetchone()[0]

        # Chessable-style: due = level > 0 AND paused = 0 AND next_due <= now.
        # We also count never-reviewed moves (next_due IS NULL) for
        # backward-compat with the old SM-2 import flow; the trainer UI
        # splits them into Review vs Learn queues.
        due = conn.execute(
            """
            SELECT COUNT(*) FROM moves m
            JOIN chapters ch ON m.chapter_id = ch.id
            WHERE ch.course_id = ?
              AND COALESCE(m.paused, 0) = 0
              AND COALESCE(m.level, 0) > 0
              AND m.next_due IS NOT NULL
              AND m.next_due <= ?
            """,
            (course["id"], now_iso),
        ).fetchone()[0]

        # New (Learn queue): level = 0.
        learn = conn.execute(
            """
            SELECT COUNT(*) FROM moves m
            JOIN chapters ch ON m.chapter_id = ch.id
            WHERE ch.course_id = ?
              AND COALESCE(m.paused, 0) = 0
              AND COALESCE(m.level, 0) = 0
            """,
            (course["id"],),
        ).fetchone()[0]

        # Mature = Chessable level 8 (or the legacy interval >= 112 days).
        mastered = conn.execute(
            """
            SELECT COUNT(*) FROM moves m
            JOIN chapters ch ON m.chapter_id = ch.id
            WHERE ch.course_id = ?
              AND (COALESCE(m.level, 0) >= 8 OR COALESCE(m.interval, 0) >= 112)
            """,
            (course["id"],),
        ).fetchone()[0]

        course["total_moves"] = total
        course["due_moves"] = due
        course["learn_moves"] = learn
        course["mastered_moves"] = mastered

    conn.close()
    return courses


def get_course(course_id: int) -> dict:
    """Get a single course by ID."""
    conn = get_connection()
    course = dict_from_row(
        conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
    )
    conn.close()
    return course


def update_course(course_id: int, **fields) -> dict:
    """Update mutable course fields.  Only whitelisted fields are
    written; everything else is silently ignored to avoid SQL errors
    on caller typos."""
    allowed = {"name", "description", "video_url", "color_side", "schedule_type"}
    sets = []
    values: list[Any] = []
    for k, v in fields.items():
        if k in allowed:
            if k == "schedule_type" and v not in VALID_SCHEDULE_TYPES:
                continue
            sets.append(f"{k} = ?")
            values.append(v)
    if not sets:
        return get_course(course_id)
    values.append(course_id)
    conn = get_connection()
    conn.execute(
        f"UPDATE courses SET {', '.join(sets)}, updated_at = datetime('now') WHERE id = ?",
        values,
    )
    conn.commit()
    conn.close()
    return get_course(course_id)


def delete_course(course_id: int) -> bool:
    """Delete a course and all its chapters + moves."""
    conn = get_connection()
    conn.execute("DELETE FROM courses WHERE id = ?", (course_id,))
    conn.commit()
    conn.close()
    return True


# ─── Chapters ───────────────────────────────────────────────────────────

def create_chapter(
    course_id: int,
    name: str,
    description: str = "",
    video_url: str = "",
) -> dict:
    """Add a chapter to a course."""
    conn = get_connection()
    cursor = conn.execute(
        "INSERT INTO chapters (course_id, name, description, video_url) "
        "VALUES (?, ?, ?, ?)",
        (course_id, name, description, video_url),
    )
    conn.commit()
    chapter = dict_from_row(
        conn.execute("SELECT * FROM chapters WHERE id = ?", (cursor.lastrowid,)).fetchone()
    )
    conn.close()
    return chapter


def get_chapters(course_id: int) -> list:
    """Get all chapters for a course with move counts."""
    conn = get_connection()
    now_iso = datetime.now().isoformat()

    chapters = dicts_from_rows(
        conn.execute(
            "SELECT * FROM chapters WHERE course_id = ? ORDER BY sort_order",
            (course_id,),
        ).fetchall()
    )

    for chapter in chapters:
        total = conn.execute(
            "SELECT COUNT(*) FROM moves WHERE chapter_id = ?", (chapter["id"],)
        ).fetchone()[0]
        # Chessable-style due: level > 0 AND paused = 0 AND next_due <= now.
        due = conn.execute(
            """
            SELECT COUNT(*) FROM moves
            WHERE chapter_id = ?
              AND COALESCE(paused, 0) = 0
              AND COALESCE(level, 0) > 0
              AND next_due IS NOT NULL
              AND next_due <= ?
            """,
            (chapter["id"], now_iso),
        ).fetchone()[0]
        learn = conn.execute(
            "SELECT COUNT(*) FROM moves WHERE chapter_id = ? AND COALESCE(level, 0) = 0",
            (chapter["id"],),
        ).fetchone()[0]
        chapter["total_moves"] = total
        chapter["due_moves"] = due
        chapter["learn_moves"] = learn

    conn.close()
    return chapters


def delete_chapter(chapter_id: int) -> bool:
    """Delete a chapter and all its moves."""
    conn = get_connection()
    conn.execute("DELETE FROM chapters WHERE id = ?", (chapter_id,))
    conn.commit()
    conn.close()
    return True


# ─── PGN Import ─────────────────────────────────────────────────────────

def import_pgn_to_chapter(
    chapter_id: int,
    pgn_text: str,
    include_subvariations: bool = True,
) -> dict:
    """Parse PGN text and create move records in a chapter.

    Per RESEARCH.md §3, every position-to-move pair is a card.  The
    parser already walks every half-move including sub-variations;
    we just need to insert them all, deduplicating on
    ``(chapter_id, fen, move_uci)``.

    Parameters
    ----------
    chapter_id:
        Target chapter.
    pgn_text:
        The PGN text (one or more games).
    include_subvariations:
        If ``True`` (default), cards are created for every half-move
        in every variation, matching Chessable's "Import all
        sub-variations as their own item" behaviour.  If ``False``,
        only mainline moves are imported.

    Returns
    -------
    dict
        ``{"imported": N, "skipped_duplicates": N, "total_in_pgn": N}``
    """
    raw_moves = parse_pgn(pgn_text)
    if not include_subvariations:
        # The current ``parse_pgn`` already records every half-move
        # on its own line, so when ``include_subvariations`` is False
        # we filter to moves that did not come from a sub-variation.
        # Sub-variations are tagged by the parser via a synthetic
        # ``in_subvariation`` key when present.  Falls back to keeping
        # everything if the parser didn't tag.
        raw_moves = [m for m in raw_moves if not m.get("in_subvariation")]

    conn = get_connection()
    imported = 0
    skipped = 0

    for move_data in raw_moves:
        # Skip duplicates within the same chapter (same FEN + same move).
        existing = conn.execute(
            "SELECT id FROM moves WHERE chapter_id = ? AND fen = ? AND move_uci = ?",
            (chapter_id, move_data["fen"], move_data["move_uci"]),
        ).fetchone()

        if existing:
            skipped += 1
            continue

        # Pull optional fields out of the move dict if the parser
        # supplied them.  All are best-effort: missing keys fall back
        # to defaults.
        alternates_json = None
        if "alternates" in move_data and move_data["alternates"]:
            alternates_json = json.dumps(move_data["alternates"])
        elif "alternates_json" in move_data and move_data["alternates_json"]:
            alternates_json = move_data["alternates_json"]

        key_move = 1 if move_data.get("key_move") else 0
        is_tactics = 1 if move_data.get("is_tactics") else 0

        conn.execute(
            """
            INSERT INTO moves
              (chapter_id, fen, move_uci, move_san, side, move_number, comment,
               alternates_json, key_move, is_tactics)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chapter_id,
                move_data["fen"],
                move_data["move_uci"],
                move_data["move_san"],
                move_data["side"],
                move_data.get("move_number", 0),
                move_data.get("comment", ""),
                alternates_json,
                key_move,
                is_tactics,
            ),
        )
        imported += 1

    conn.commit()
    conn.close()

    return {
        "imported": imported,
        "skipped_duplicates": skipped,
        "total_in_pgn": len(raw_moves),
    }


# ─── Training / Reviews ─────────────────────────────────────────────────

def _parse_next_due(value) -> Optional[datetime]:
    """Best-effort ISO-8601 parse for the ``next_due`` column."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None


def get_due_moves(
    course_id: int = None,
    side: str = None,
    limit: int = 20,
    include_never_reviewed: bool = False,
) -> list:
    """Get moves that are due for *Review* mode.

    Chessable-style filter (RESEARCH.md §5.3):

    * ``paused = 0``
    * ``level > 0`` (the card has been introduced at least once)
    * ``next_due IS NOT NULL AND next_due <= now``

    By default we *exclude* moves that have never been reviewed
    (``level = 0``).  Set ``include_never_reviewed=True`` to also
    return those — this is the behaviour the legacy code used
    (``next_review IS NULL``), and some clients may still rely on it.
    """
    conn = get_connection()
    now_iso = datetime.now().isoformat()

    query = """
        SELECT m.*, ch.name AS chapter_name, ch.id AS chapter_id,
               c.name AS course_name, c.id AS course_id
        FROM moves m
        JOIN chapters ch ON m.chapter_id = ch.id
        JOIN courses c ON ch.course_id = c.id
        WHERE COALESCE(m.paused, 0) = 0
    """
    params: list[Any] = []

    if include_never_reviewed:
        # Legacy / SM-2 mode: include any card that has not been
        # reviewed yet OR is due.
        query += " AND (m.next_due IS NULL OR m.next_due <= ?)"
        params.append(now_iso)
    else:
        # Chessable Review mode: only level >= 1 cards past their due.
        query += " AND COALESCE(m.level, 0) > 0 AND m.next_due IS NOT NULL AND m.next_due <= ?"
        params.append(now_iso)

    if course_id:
        query += " AND c.id = ?"
        params.append(course_id)

    if side and side in ("white", "black"):
        query += " AND m.side = ?"
        params.append(side)

    query += " ORDER BY m.next_due ASC LIMIT ?"
    params.append(limit)

    moves = dicts_from_rows(conn.execute(query, params).fetchall())
    conn.close()
    return moves


def get_learn_queue(
    course_id: int = None,
    side: str = None,
    chapter_id: int = None,
    key_only: bool = False,
    limit: int = 50,
) -> list:
    """Get moves that haven't been learned yet (level 0).

    Per RESEARCH.md §5.2, the Learn queue contains cards the user
    has never been introduced to.  In the schema that's
    ``level = 0``.  ``paused = 0`` is implicit (we don't queue paused
    cards).

    Parameters
    ----------
    course_id, side, chapter_id, key_only, limit:
        All optional filters.  ``key_only=True`` restricts the queue
        to author-marked ``key_move`` cards (RESEARCH.md §5.6).
    """
    conn = get_connection()
    query = """
        SELECT m.*, ch.name AS chapter_name, ch.id AS chapter_id,
               c.name AS course_name, c.id AS course_id
        FROM moves m
        JOIN chapters ch ON m.chapter_id = ch.id
        JOIN courses c ON ch.course_id = c.id
        WHERE COALESCE(m.level, 0) = 0
          AND COALESCE(m.paused, 0) = 0
    """
    params: list[Any] = []

    if course_id:
        query += " AND c.id = ?"
        params.append(course_id)
    if chapter_id:
        query += " AND ch.id = ?"
        params.append(chapter_id)
    if side and side in ("white", "black"):
        query += " AND m.side = ?"
        params.append(side)
    if key_only:
        query += " AND COALESCE(m.key_move, 0) = 1"

    query += " ORDER BY ch.sort_order, m.id LIMIT ?"
    params.append(limit)

    moves = dicts_from_rows(conn.execute(query, params).fetchall())
    conn.close()
    return moves


def get_move(move_id: int) -> dict:
    """Get a single move by ID."""
    conn = get_connection()
    move = dict_from_row(
        conn.execute(
            """
            SELECT m.*, ch.name AS chapter_name, c.name AS course_name,
                   c.schedule_type AS course_schedule_type
            FROM moves m
            JOIN chapters ch ON m.chapter_id = ch.id
            JOIN courses c ON ch.course_id = c.id
            WHERE m.id = ?
            """,
            (move_id,),
        ).fetchone()
    )
    conn.close()
    return move


def update_move_review(move_id: int, srs_data: dict) -> dict:
    """Persist SRS fields back to the ``moves`` table.

    Accepts the dict shape returned by ``srs.chessable_review`` and
    ``srs.review_move``.  The columns written are the union of the
    two schedulers' output so the same code path works regardless
    of which scheduler ran.
    """
    # Map of column name → srs_data key.  Use ``.get`` so missing
    # keys (e.g. when the SM-2 path didn't touch a Chessable field)
    # leave the column untouched.
    updates: dict[str, Any] = {
        "ease_factor": srs_data.get("ease_factor"),
        "interval": srs_data.get("interval"),
        "repetitions": srs_data.get("repetitions"),
        "level": srs_data.get("level"),
        "xp_total": srs_data.get("xp_total"),
        "fail_count": srs_data.get("fail_count"),
    }
    # ``next_due`` is the Chessable column; ``next_review`` is the
    # legacy column.  Write to whichever one is present, and mirror
    # to the other so both stay consistent.
    next_due = srs_data.get("next_due")
    next_review = srs_data.get("next_review")
    if next_due is not None and next_review is None:
        next_review = next_due
    if next_review is not None and next_due is None:
        next_due = next_review
    if next_due is not None:
        updates["next_due"] = next_due
    if next_review is not None:
        updates["next_review"] = next_review
    if srs_data.get("last_reviewed") is not None:
        updates["last_reviewed"] = srs_data["last_reviewed"]

    # Strip None entries so we don't overwrite existing values with NULL.
    set_clauses = []
    values: list[Any] = []
    for col, val in updates.items():
        if val is None:
            continue
        set_clauses.append(f"{col} = ?")
        values.append(val)
    if not set_clauses:
        return get_move(move_id)

    values.append(move_id)
    conn = get_connection()
    conn.execute(
        f"UPDATE moves SET {', '.join(set_clauses)} WHERE id = ?",
        values,
    )
    conn.commit()
    conn.close()
    return get_move(move_id)


def apply_review_to_move(
    move_id: int,
    outcome: str = None,
    schedule: str = None,
    quality: int = None,
    attempts: int = 1,
    got_right: bool = True,
    now: Optional[datetime] = None,
) -> dict:
    """Apply a review outcome to a move, dispatching to the right
    scheduler based on the course's ``schedule_type``.

    Parameters
    ----------
    move_id:
        The move (card) to update.
    outcome:
        ``"correct"`` / ``"wrong"`` / ``"soft_fail"`` for the Chessable
        scheduler.  Ignored when the course uses SM-2 (in that case
        the legacy ``quality`` / ``attempts`` / ``got_right`` args
        are used).
    schedule:
        Optional override for the course's schedule.  ``"chessable_8level"``
        or ``"sm2"``.  Defaults to the course's own ``schedule_type``.
    quality, attempts, got_right:
        SM-2 inputs.  Used only when the schedule resolves to SM-2.

    Returns
    -------
    dict
        The updated move row (with chapter_name / course_name / etc).
    """
    if outcome is not None and outcome not in VALID_OUTCOMES:
        raise ValueError(
            f"outcome must be one of {VALID_OUTCOMES!r}, got {outcome!r}"
        )
    move = get_move(move_id)
    if not move:
        return None

    effective_schedule = schedule or move.get("course_schedule_type") or SCHEDULE_CHESSABLE
    if effective_schedule not in VALID_SCHEDULE_TYPES:
        effective_schedule = SCHEDULE_CHESSABLE

    # If we're on the Chessable scheduler but the caller didn't pass
    # an outcome, fall back to a correct review (the most common
    # default for an "I just played it right" client).
    if effective_schedule == SCHEDULE_CHESSABLE and outcome is None:
        outcome = OUTCOME_CORRECT

    updated = apply_review(
        move,
        outcome=outcome,
        schedule_type=effective_schedule,
        quality=quality,
        attempts=attempts,
        got_right=got_right,
        now=now,
    )
    return update_move_review(move_id, updated)


# ─── Stats ───────────────────────────────────────────────────────────────

def get_stats() -> dict:
    """Get overall dashboard statistics.

    Counts are based on the Chessable model:
    * ``due_moves``   — level > 0, paused = 0, next_due <= now
    * ``learn_moves`` — level = 0, paused = 0
    * ``mastered_moves`` — level >= 8 (or legacy interval >= 112 days)
    """
    conn = get_connection()
    now_iso = datetime.now().isoformat()
    today = date.today().isoformat()

    total_moves = conn.execute("SELECT COUNT(*) FROM moves").fetchone()[0]
    total_courses = conn.execute("SELECT COUNT(*) FROM courses").fetchone()[0]
    total_chapters = conn.execute("SELECT COUNT(*) FROM chapters").fetchone()[0]

    due_moves = conn.execute(
        """
        SELECT COUNT(*) FROM moves
        WHERE COALESCE(paused, 0) = 0
          AND COALESCE(level, 0) > 0
          AND next_due IS NOT NULL
          AND next_due <= ?
        """,
        (now_iso,),
    ).fetchone()[0]

    learn_moves = conn.execute(
        "SELECT COUNT(*) FROM moves WHERE COALESCE(level, 0) = 0 AND COALESCE(paused, 0) = 0"
    ).fetchone()[0]

    mastered_moves = conn.execute(
        """
        SELECT COUNT(*) FROM moves
        WHERE COALESCE(level, 0) >= 8 OR COALESCE(interval, 0) >= 112
        """
    ).fetchone()[0]

    reviewed_today = conn.execute(
        "SELECT COUNT(*) FROM moves WHERE date(last_reviewed) = ?",
        (today,),
    ).fetchone()[0]

    # XP total across the system (cosmetic but useful for the UI).
    total_xp = conn.execute(
        "SELECT COALESCE(SUM(xp_total), 0) FROM moves"
    ).fetchone()[0]

    conn.close()

    return {
        "total_courses": total_courses,
        "total_chapters": total_chapters,
        "total_moves": total_moves,
        "due_moves": due_moves,
        "learn_moves": learn_moves,
        "mastered_moves": mastered_moves,
        "reviewed_today": reviewed_today,
        "total_xp": total_xp,
        "today": today,
        "now": now_iso,
    }


# ─── Course-style PGN import (multi-game, chapter-grouped) ──────────────

def split_pgn_games(pgn_text: str) -> list:
    """Split a multi-game PGN text into (headers, movetext) tuples.

    Returns a list of dicts: {white, black, movetext}.
    Each game block starts at a ``[Event`` tag and ends before the next.
    """
    games = []
    current_headers = {}
    current_lines = []

    def flush():
        if current_headers or current_lines:
            games.append({
                "white": current_headers.get("White", ""),
                "black": current_headers.get("Black", ""),
                "movetext": "\n".join(current_lines).strip(),
            })

    in_headers = True
    for raw in pgn_text.splitlines():
        line = raw.strip()
        if line.startswith("[Event"):
            # New game starting — flush previous
            flush()
            current_headers = {}
            current_lines = []
            in_headers = True
        if in_headers and line.startswith("["):
            m = line[1:-1].split(" ", 1)
            if len(m) == 2:
                current_headers[m[0]] = m[1].strip('"')
        elif line:
            in_headers = False
            current_lines.append(line)

    flush()
    return [g for g in games if g["movetext"]]


def import_course_pgn(
    course_id: int,
    pgn_text: str,
    chapter_tag: str = "White",
) -> dict:
    """Import a full Chessable-style course PGN.

    Each game in the PGN becomes part of a chapter named after the tag
    chosen by the user (``chapter_tag`` — typically ``"White"`` or
    ``"Black"``; Chessable course exports usually put the chapter name
    in one of these fields and the variation name in the other).

    Deduplication is per-chapter on ``(fen, move_uci)`` — so the shared
    opening moves between two lines in the SAME chapter are stored once,
    and the branching positions become separate cards. This is exactly
    the "don't re-drill the first 12 moves for every branch" behaviour:
    each unique position-to-move pair is one card with one SRS state.
    """
    games = split_pgn_games(pgn_text)
    if not games:
        return {"error": "No games found in PGN", "chapters": 0, "imported": 0}

    chapter_tag = chapter_tag if chapter_tag in ("White", "Black") else "White"
    tag_key = chapter_tag.lower()

    conn = get_connection()
    chapter_map = {}

    total_imported = 0
    total_skipped = 0
    chapters_created = 0

    for game in games:
        chapter_name = (game.get(tag_key) or "").strip() or "Main"
        if chapter_name not in chapter_map:
            # Find or create chapter
            row = conn.execute(
                "SELECT id FROM chapters WHERE course_id = ? AND name = ?",
                (course_id, chapter_name),
            ).fetchone()
            if row:
                chapter_map[chapter_name] = row["id"]
            else:
                cur = conn.execute(
                    "INSERT INTO chapters (course_id, name) VALUES (?, ?)",
                    (course_id, chapter_name),
                )
                chapter_map[chapter_name] = cur.lastrowid
                chapters_created += 1

        chapter_id = chapter_map[chapter_name]

        # Parse this game's movetext
        try:
            moves = parse_pgn(game["movetext"])
        except Exception as e:
            # Skip unparseable games but continue
            continue

        for md in moves:
            existing = conn.execute(
                "SELECT id FROM moves WHERE chapter_id = ? AND fen = ? AND move_uci = ?",
                (chapter_id, md["fen"], md["move_uci"]),
            ).fetchone()
            if existing:
                total_skipped += 1
                continue
            conn.execute(
                """INSERT INTO moves
                   (chapter_id, fen, move_uci, move_san, side, move_number, comment)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    chapter_id,
                    md["fen"],
                    md["move_uci"],
                    md["move_san"],
                    md["side"],
                    md.get("move_number", 0),
                    md.get("comment", ""),
                ),
            )
            total_imported += 1

    conn.commit()
    conn.close()

    return {
        "chapters_created": chapters_created,
        "chapters_total": len(chapter_map),
        "games_parsed": len(games),
        "imported": total_imported,
        "skipped_duplicates": total_skipped,
    }
