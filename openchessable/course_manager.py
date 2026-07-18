"""
Open-Chessable: Course and chapter management
Business logic layer between API and database.
"""

from datetime import date
from .database import get_connection, dict_from_row, dicts_from_rows
from .pgn_parser import parse_pgn


# ─── Courses ────────────────────────────────────────────────────────────

def create_course(name: str, description: str = "", video_url: str = "", color_side: str = "both") -> dict:
    """Create a new course."""
    conn = get_connection()
    cursor = conn.execute(
        "INSERT INTO courses (name, description, video_url, color_side) VALUES (?, ?, ?, ?)",
        (name, description, video_url, color_side)
    )
    conn.commit()
    course = dict_from_row(
        conn.execute("SELECT * FROM courses WHERE id = ?", (cursor.lastrowid,)).fetchone()
    )
    conn.close()
    return course


def get_courses() -> list:
    """Get all courses with review stats."""
    conn = get_connection()
    today = date.today().isoformat()
    
    courses = dicts_from_rows(conn.execute("SELECT * FROM courses ORDER BY created_at DESC").fetchall())
    
    for course in courses:
        # Count total moves
        total = conn.execute("""
            SELECT COUNT(*) FROM moves m
            JOIN chapters ch ON m.chapter_id = ch.id
            WHERE ch.course_id = ?
        """, (course["id"],)).fetchone()[0]
        
        # Count due moves
        due = conn.execute("""
            SELECT COUNT(*) FROM moves m
            JOIN chapters ch ON m.chapter_id = ch.id
            WHERE ch.course_id = ? AND m.next_review <= ?
        """, (course["id"], today)).fetchone()[0]
        
        # Count mastered moves
        mastered = conn.execute("""
            SELECT COUNT(*) FROM moves m
            JOIN chapters ch ON m.chapter_id = ch.id
            WHERE ch.course_id = ? AND m.interval >= 112
        """, (course["id"],)).fetchone()[0]
        
        course["total_moves"] = total
        course["due_moves"] = due
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


def delete_course(course_id: int) -> bool:
    """Delete a course and all its chapters + moves."""
    conn = get_connection()
    conn.execute("DELETE FROM courses WHERE id = ?", (course_id,))
    conn.commit()
    conn.close()
    return True


# ─── Chapters ───────────────────────────────────────────────────────────

def create_chapter(course_id: int, name: str, description: str = "", video_url: str = "") -> dict:
    """Add a chapter to a course."""
    conn = get_connection()
    cursor = conn.execute(
        "INSERT INTO chapters (course_id, name, description, video_url) VALUES (?, ?, ?, ?)",
        (course_id, name, description, video_url)
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
    today = date.today().isoformat()
    
    chapters = dicts_from_rows(
        conn.execute(
            "SELECT * FROM chapters WHERE course_id = ? ORDER BY sort_order",
            (course_id,)
        ).fetchall()
    )
    
    for chapter in chapters:
        total = conn.execute(
            "SELECT COUNT(*) FROM moves WHERE chapter_id = ?", (chapter["id"],)
        ).fetchone()[0]
        due = conn.execute(
            "SELECT COUNT(*) FROM moves WHERE chapter_id = ? AND next_review <= ?",
            (chapter["id"], today)
        ).fetchone()[0]
        chapter["total_moves"] = total
        chapter["due_moves"] = due
    
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

def import_pgn_to_chapter(chapter_id: int, pgn_text: str) -> dict:
    """
    Parse PGN text and create move records in a chapter.
    Returns summary: {imported: N, skipped_duplicates: N}
    """
    moves = parse_pgn(pgn_text)
    conn = get_connection()
    imported = 0
    skipped = 0
    
    for move_data in moves:
        # Check for duplicate (same chapter, same FEN, same move)
        existing = conn.execute(
            "SELECT id FROM moves WHERE chapter_id = ? AND fen = ? AND move_uci = ?",
            (chapter_id, move_data["fen"], move_data["move_uci"])
        ).fetchone()
        
        if existing:
            skipped += 1
            continue
        
        conn.execute(
            """INSERT INTO moves 
               (chapter_id, fen, move_uci, move_san, side, move_number, comment)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                chapter_id,
                move_data["fen"],
                move_data["move_uci"],
                move_data["move_san"],
                move_data["side"],
                move_data["move_number"],
                move_data["comment"],
            )
        )
        imported += 1
    
    conn.commit()
    conn.close()
    
    return {"imported": imported, "skipped_duplicates": skipped, "total_in_pgn": len(moves)}


# ─── Training / Reviews ─────────────────────────────────────────────────

def get_due_moves(course_id: int = None, side: str = None, limit: int = 20) -> list:
    """Get moves that are due for review today (or overdue)."""
    conn = get_connection()
    today = date.today().isoformat()
    
    query = """
        SELECT m.*, ch.name as chapter_name, ch.id as chapter_id, 
               c.name as course_name, c.id as course_id
        FROM moves m
        JOIN chapters ch ON m.chapter_id = ch.id
        JOIN courses c ON ch.course_id = c.id
        WHERE m.next_review <= ? OR m.next_review IS NULL
    """
    params = [today]
    
    if course_id:
        query += " AND c.id = ?"
        params.append(course_id)
    
    if side and side in ("white", "black"):
        query += " AND m.side = ?"
        params.append(side)
    
    query += " ORDER BY m.next_review ASC NULLS FIRST LIMIT ?"
    params.append(limit)
    
    moves = dicts_from_rows(conn.execute(query, params).fetchall())
    conn.close()
    return moves


def get_move(move_id: int) -> dict:
    """Get a single move by ID."""
    conn = get_connection()
    move = dict_from_row(
        conn.execute(
            """SELECT m.*, ch.name as chapter_name, c.name as course_name
               FROM moves m
               JOIN chapters ch ON m.chapter_id = ch.id
               JOIN courses c ON ch.course_id = c.id
               WHERE m.id = ?""",
            (move_id,)
        ).fetchone()
    )
    conn.close()
    return move


def update_move_review(move_id: int, srs_data: dict) -> dict:
    """Update a move's SRS fields after review."""
    conn = get_connection()
    conn.execute(
        """UPDATE moves SET 
           ease_factor = ?, interval = ?, repetitions = ?, 
           next_review = ?, last_reviewed = ?
           WHERE id = ?""",
        (
            srs_data["ease_factor"],
            srs_data["interval"],
            srs_data["repetitions"],
            srs_data["next_review"],
            srs_data["last_reviewed"],
            move_id,
        )
    )
    conn.commit()
    conn.close()
    return get_move(move_id)


# ─── Stats ───────────────────────────────────────────────────────────────

def get_stats() -> dict:
    """Get overall dashboard statistics."""
    conn = get_connection()
    today = date.today().isoformat()
    
    total_moves = conn.execute("SELECT COUNT(*) FROM moves").fetchone()[0]
    total_courses = conn.execute("SELECT COUNT(*) FROM courses").fetchone()[0]
    total_chapters = conn.execute("SELECT COUNT(*) FROM chapters").fetchone()[0]
    
    due_moves = conn.execute(
        "SELECT COUNT(*) FROM moves WHERE next_review <= ? OR next_review IS NULL",
        (today,)
    ).fetchone()[0]
    
    mastered_moves = conn.execute(
        "SELECT COUNT(*) FROM moves WHERE interval >= 112"
    ).fetchone()[0]
    
    reviewed_today = conn.execute(
        "SELECT COUNT(*) FROM moves WHERE date(last_reviewed) = ?",
        (today,)
    ).fetchone()[0]
    
    conn.close()
    
    return {
        "total_courses": total_courses,
        "total_chapters": total_chapters,
        "total_moves": total_moves,
        "due_moves": due_moves,
        "mastered_moves": mastered_moves,
        "reviewed_today": reviewed_today,
        "today": today,
    }
