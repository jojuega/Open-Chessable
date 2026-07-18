"""
Open-Chessable: PGN parser using python-chess
Extracts variations as learnable moves (FEN + UCI move) from PGN files.

Correct tree walk: at each node, use node.board() which returns the
position BEFORE the node's move — no manual push/pop bookkeeping needed.
Every half-move (ply) in every variation becomes one card.
"""

import io
from typing import List, Dict

try:
    import chess
    import chess.pgn
    _HAS_CHESS = True
except ImportError:
    _HAS_CHESS = False


def parse_pgn(pgn_text: str) -> List[Dict]:
    """
    Parse PGN text and extract every half-move of every variation as a card.

    Each result: fen (before the move), move_uci, move_san, side, move_number,
    comment, and the variation path (list of SAN moves from the game start).
    """
    if not _HAS_CHESS:
        raise ImportError(
            "python-chess is required for PGN parsing. "
            "Install with: pip install python-chess"
        )

    moves: List[Dict] = []
    pgn_io = io.StringIO(pgn_text)

    while True:
        game = chess.pgn.read_game(pgn_io)
        if game is None:
            break

        # Root board (respects a [FEN "..."] header if present)
        root_fen = game.board().fen()
        _walk(game, moves, path=[], move_number=0, root_fen=root_fen)

    return moves


def _walk(node, moves: List[Dict], path: List[str], move_number: int, root_fen: str):
    """Depth-first walk over the variation tree.

    For each child we need the position BEFORE its move. python-chess'
    node.board() returns the position AFTER the move, so we track the
    parent board ourselves: copy it, record FEN, then push.
    """
    board = node.board()  # position AT this node (after this node's move,
                          # or the root position for the game root)

    for i, child in enumerate(node.variations):
        move = child.move

        fen = board.fen()
        move_uci = move.uci()
        try:
            move_san = board.san(move)
        except Exception:
            move_san = move_uci

        side = "white" if board.turn == chess.WHITE else "black"
        new_path = path + [move_san]

        moves.append({
            "fen": fen,
            "move_uci": move_uci,
            "move_san": move_san,
            "side": side,
            "move_number": move_number + 1,
            "comment": child.comment or "",
            "variation_path": " ".join(
                (f"{j // 2 + 1}." if j % 2 == 0 else "") + san
                for j, san in enumerate(new_path)
            ),
            "is_mainline": (i == 0),
        })

        # Push on a copy so siblings see the same parent position
        child_board = board.copy()
        child_board.push(move)
        _walk_board(child, child_board, moves, new_path, move_number + 1)


def _walk_board(node, board, moves: List[Dict], path: List[str], move_number: int):
    """Same as _walk but the board is passed explicitly (already pushed)."""
    for i, child in enumerate(node.variations):
        move = child.move

        fen = board.fen()
        move_uci = move.uci()
        try:
            move_san = board.san(move)
        except Exception:
            move_san = move_uci

        side = "white" if board.turn == chess.WHITE else "black"
        new_path = path + [move_san]

        moves.append({
            "fen": fen,
            "move_uci": move_uci,
            "move_san": move_san,
            "side": side,
            "move_number": move_number + 1,
            "comment": child.comment or "",
            "variation_path": " ".join(
                (f"{j // 2 + 1}." if j % 2 == 0 else "") + san
                for j, san in enumerate(new_path)
            ),
            "is_mainline": (i == 0),
        })

        child_board = board.copy()
        child_board.push(move)
        _walk_board(child, child_board, moves, new_path, move_number + 1)


def parse_pgn_file(filepath: str) -> List[Dict]:
    """Parse a PGN file from disk."""
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        return parse_pgn(f.read())


def count_moves_in_pgn(pgn_text: str) -> int:
    """Quick count of how many learnable moves a PGN would produce."""
    return len(parse_pgn(pgn_text))
