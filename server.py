"""
Open-Chessable: Flask API server
Serves REST API and static frontend files.
"""

import os
import sys
from flask import Flask, request, jsonify, send_from_directory

# Ensure openchessable package is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from openchessable import (
    create_course,
    get_courses,
    get_course,
    delete_course,
    create_chapter,
    get_chapters,
    delete_chapter,
    import_pgn_to_chapter,
    get_due_moves,
    get_learn_queue,
    get_move,
    apply_review_to_move,
    get_stats,
)

app = Flask(__name__, static_folder="web", static_url_path="")


# ─── Static files ──────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("web", "index.html")


# ─── Courses API ────────────────────────────────────────────────────────

@app.route("/api/courses", methods=["GET"])
def api_get_courses():
    courses = get_courses()
    return jsonify(courses)


@app.route("/api/courses", methods=["POST"])
def api_create_course():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Course name is required"}), 400
    
    course = create_course(
        name=name,
        description=data.get("description", ""),
        video_url=data.get("video_url", ""),
        color_side=data.get("color_side", "both"),
    )
    return jsonify(course), 201


@app.route("/api/courses/<int:course_id>", methods=["GET"])
def api_get_course(course_id):
    course = get_course(course_id)
    if not course:
        return jsonify({"error": "Course not found"}), 404
    return jsonify(course)


@app.route("/api/courses/<int:course_id>", methods=["DELETE"])
def api_delete_course(course_id):
    delete_course(course_id)
    return jsonify({"ok": True})


# ─── Chapters API ───────────────────────────────────────────────────────

@app.route("/api/courses/<int:course_id>/chapters", methods=["GET"])
def api_get_chapters(course_id):
    chapters = get_chapters(course_id)
    return jsonify(chapters)


@app.route("/api/courses/<int:course_id>/chapters", methods=["POST"])
def api_create_chapter(course_id):
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Chapter name is required"}), 400
    
    chapter = create_chapter(
        course_id=course_id,
        name=name,
        description=data.get("description", ""),
        video_url=data.get("video_url", ""),
    )
    return jsonify(chapter), 201


@app.route("/api/chapters/<int:chapter_id>", methods=["DELETE"])
def api_delete_chapter(chapter_id):
    delete_chapter(chapter_id)
    return jsonify({"ok": True})


# ─── PGN Import API ─────────────────────────────────────────────────────

@app.route("/api/chapters/<int:chapter_id>/import-pgn", methods=["POST"])
def api_import_pgn(chapter_id):
    """Import PGN text into a chapter. Accepts JSON body with 'pgn' field
    or file upload as multipart form-data with 'file' field."""
    
    pgn_text = ""
    
    if request.is_json:
        data = request.get_json() or {}
        pgn_text = data.get("pgn", "")
    elif request.files and "file" in request.files:
        file = request.files["file"]
        pgn_text = file.read().decode("utf-8", errors="replace")
    else:
        return jsonify({"error": "Provide 'pgn' in JSON body or 'file' in form-data"}), 400
    
    if not pgn_text.strip():
        return jsonify({"error": "PGN text is empty"}), 400
    
    try:
        result = import_pgn_to_chapter(chapter_id, pgn_text)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": f"PGN parsing failed: {str(e)}"}), 400


# ─── Trainer API ────────────────────────────────────────────────────────

@app.route("/api/trainer/due", methods=["GET"])
def api_get_due_moves():
    course_id = request.args.get("course_id", type=int)
    side = request.args.get("side")
    limit = request.args.get("limit", 20, type=int)
    
    moves = get_due_moves(course_id=course_id, side=side, limit=limit)
    return jsonify(moves)


@app.route("/api/trainer/learn", methods=["GET"])
def api_get_learn_queue():
    """Get moves that haven't been learned yet (Learn queue)."""
    course_id = request.args.get("course_id", type=int)
    side = request.args.get("side")
    chapter_id = request.args.get("chapter_id", type=int)
    limit = request.args.get("limit", 50, type=int)
    
    moves = get_learn_queue(course_id=course_id, side=side, chapter_id=chapter_id, limit=limit)
    return jsonify(moves)


@app.route("/api/trainer/review", methods=["POST"])
def api_review_move():
    """Submit a review outcome for a move.
    
    Supports both Chessable (outcome-based) and SM-2 (quality-based) review.
    - Chessable: send outcome="correct"|"wrong"|"soft_fail"
    - SM-2: send quality=0..5, attempts, got_right
    """
    data = request.get_json() or {}
    move_id = data.get("move_id")
    outcome = data.get("outcome")  # Chessable: "correct", "wrong", "soft_fail"
    quality = data.get("quality")  # SM-2: 0-5 (auto-calculated if using Chessable mode)
    attempts = data.get("attempts", 1)
    got_right = data.get("got_right", True)
    
    if move_id is None:
        return jsonify({"error": "move_id is required"}), 400
    
    if quality is not None and (not isinstance(quality, int) or quality < 0 or quality > 5):
        return jsonify({"error": "quality must be an integer 0-5"}), 400
    
    try:
        updated_move = apply_review_to_move(
            move_id,
            outcome=outcome,
            quality=quality,
            attempts=attempts,
            got_right=got_right,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    
    if updated_move is None:
        return jsonify({"error": "Move not found"}), 404
    
    return jsonify({
        "move": updated_move,
        "outcome": outcome,
        "attempts": attempts,
        "got_right": got_right,
    })


@app.route("/api/trainer/move/<int:move_id>", methods=["GET"])
def api_get_move_detail(move_id):
    move = get_move(move_id)
    if not move:
        return jsonify({"error": "Move not found"}), 404
    return jsonify(move)


# ─── Stats API ───────────────────────────────────────────────────────────

@app.route("/api/stats", methods=["GET"])
def api_get_stats():
    return jsonify(get_stats())


# ─── Main ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("♟  Open-Chessable server starting on http://localhost:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
