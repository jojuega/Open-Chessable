"""
Open-Chessable: PGN parser using python-chess
Extracts variations as learnable moves (FEN + UCI move) from PGN files.

We do NOT use chess.pgn.read_game() for the movetext — it hangs on
Chessable exports with comment-only sub-variations and nested parens.

Instead we:
  1. Split the input into game blocks by [Event headers
  2. For each block, extract headers with read_headers()
  3. Tokenize the movetext manually: moves, comments {}, variations ()
  4. Walk the token stream with ONE chess.Board, pushing/popping

Every half-move (ply) in every variation becomes one card.
"""

import io
import re
from typing import List, Dict, Optional, Tuple

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

    for block in _split_games(pgn_text):
        try:
            _parse_one_game(block, moves)
        except Exception:
            # Skip malformed games entirely
            continue

    return moves


def _split_games(pgn_text: str) -> List[str]:
    """Split a multi-game PGN into individual game blocks."""
    blocks = []
    current = []
    for line in pgn_text.splitlines(keepends=True):
        if line.startswith('[Event ') and current:
            blocks.append(''.join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        blocks.append(''.join(current))
    return blocks


def _parse_one_game(block: str, moves: List[Dict]) -> None:
    """Parse a single game block and append cards to `moves`."""
    # Extract headers if present (everything up to first blank line)
    header_end = block.find('\n\n')
    if header_end != -1 and block.lstrip().startswith('['):
        header_text = block[:header_end]
        movetext = block[header_end + 2:]
        headers = chess.pgn.read_headers(io.StringIO(header_text + '\n\n'))
    else:
        # No headers — entire block is movetext
        movetext = block
        headers = None

    # Set up board
    fen = headers.get('FEN') if headers else None
    if fen:
        try:
            board = chess.Board(fen)
        except Exception:
            board = chess.Board()
    else:
        board = chess.Board()

    # Tokenize movetext
    tokens = _tokenize_movetext(movetext)

    # Walk tokens
    _walk_tokens(board, tokens, moves)


def _tokenize_movetext(text: str) -> List[Tuple[str, str]]:
    """Tokenize PGN movetext into (type, value) pairs.

    Types: 'move', 'comment', 'open_var', 'close_var', 'result', 'nag'
    """
    tokens = []
    i = 0
    n = len(text)

    while i < n:
        # Skip whitespace
        if text[i].isspace():
            i += 1
            continue

        # Comment { ... }
        if text[i] == '{':
            j = text.find('}', i + 1)
            if j == -1:
                # Unterminated comment — treat rest as comment
                tokens.append(('comment', text[i + 1:]))
                break
            tokens.append(('comment', text[i + 1:j]))
            i = j + 1
            continue

        # Open variation
        if text[i] == '(':
            tokens.append(('open_var', '('))
            i += 1
            continue

        # Close variation
        if text[i] == ')':
            tokens.append(('close_var', ')'))
            i += 1
            continue

        # NAG $123
        if text[i] == '$':
            j = i + 1
            while j < n and text[j].isdigit():
                j += 1
            tokens.append(('nag', text[i:j]))
            i = j
            continue

        # Result marker: 1-0, 0-1, 1/2-1/2, *
        if text[i] in '10*½':
            for result in ('1-0', '0-1', '1/2-1/2', '*'):
                if text.startswith(result, i):
                    tokens.append(('result', result))
                    i += len(result)
                    break
            else:
                # Not a result — treat as move number or move
                pass

        # Move number: 1. or 1... or 23.
        m = re.match(r'(\d+)\.{1,3}\s*', text[i:])
        if m:
            i += m.end()
            continue

        # Move: SAN token (letters, digits, x, +, #, =, -, O)
        m = re.match(r'([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?[+#]?)', text[i:])
        if m:
            tokens.append(('move', m.group(1)))
            i += m.end()
            continue

        # Skip anything else (dots, stray chars)
        i += 1

    return tokens


def _walk_tokens(board: chess.Board, tokens: List[Tuple[str, str]], moves: List[Dict]) -> None:
    """Walk the token stream and emit cards.

    We maintain a stack of (board, path) for each open variation.
    """
    stack = [(board.copy(), [], [])]  # (board, path, history)
    pending_comment = ""  # comment that appears AFTER a move, belongs to that move

    for typ, val in tokens:
        if typ == 'comment':
            # In PGN, a comment after a move belongs to that move.
            # If the last move already has a comment, this one belongs to
            # the NEXT move (rare, but possible in some exports).
            if moves and not moves[-1].get('comment'):
                moves[-1]['comment'] = val
            else:
                pending_comment = val
            continue

        if typ == 'open_var':
            # A variation is an ALTERNATIVE to the last move played.
            # So we restore the board state from BEFORE that last move.
            board, path, history = stack[-1]
            if history:
                prev_fen, prev_path = history[-1]
                prev_board = chess.Board(prev_fen)
                stack.append((prev_board, prev_path, []))
            else:
                stack.append((board.copy(), path.copy(), []))
            continue

        if typ == 'close_var':
            # Pop back to the state BEFORE the variation started
            if len(stack) > 1:
                stack.pop()
            continue

        if typ in ('result', 'nag'):
            continue

        if typ == 'move':
            board, path, history = stack[-1]
            fen = board.fen()

            try:
                move = board.parse_san(val)
            except Exception:
                # Illegal move in context — skip it
                pending_comment = ""
                continue

            move_uci = move.uci()
            try:
                move_san = board.san(move)
            except Exception:
                move_san = val

            side = "white" if board.turn == chess.WHITE else "black"
            new_path = path + [move_san]

            moves.append({
                "fen": fen,
                "move_uci": move_uci,
                "move_san": move_san,
                "side": side,
                "move_number": len(new_path),
                "comment": pending_comment,
                "variation_path": " ".join(
                    (f"{j // 2 + 1}." if j % 2 == 0 else "") + san
                    for j, san in enumerate(new_path)
                ),
                "is_mainline": len(stack) == 1,
            })

            # Save state BEFORE this move for the NEXT variation.
            # We only keep ONE entry — deep nesting doesn't need older
            # history because we always restore from the most recent.
            # Also, we DON'T copy the board here — we store the move
            # and reconstruct on demand (much cheaper).
            new_history = [(board.fen(), path.copy())]

            # Push the move directly on the current board.
            board.push(move)
            stack[-1] = (board, new_path, new_history)
            pending_comment = ""


def parse_pgn_file(filepath: str) -> List[Dict]:
    """Parse a PGN file from disk."""
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        return parse_pgn(f.read())


def count_moves_in_pgn(pgn_text: str) -> int:
    """Quick count of how many learnable moves a PGN would produce."""
    return len(parse_pgn(pgn_text))
