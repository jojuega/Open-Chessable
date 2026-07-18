"""
Open-Chessable: PGN parser using python-chess
Extracts variations as learnable moves (FEN + UCI move) from PGN files.
"""

import chess.pgn
import io
from typing import List, Dict, Tuple


def parse_pgn(pgn_text: str) -> List[Dict]:
    """
    Parse PGN text and extract all leaf-node variations as learnable moves.
    
    Each result represents a position-to-move pair:
    - fen: FEN of the board BEFORE the move
    - move_uci: The move to learn in UCI format
    - move_san: Human-readable SAN notation
    - side: 'white' or 'black' (the side TO MOVE)
    - comment: Any annotation on the move
    
    Handles recursive variations (RAV — parenthesized sub-variations in PGN).
    """
    moves = []
    pgn_io = io.StringIO(pgn_text)
    
    while True:
        game = chess.pgn.read_game(pgn_io)
        if game is None:
            break
        
        board = game.board()
        _extract_moves_from_node(board, game, moves, move_number=0)
    
    return moves


def _extract_moves_from_node(board, node, moves: List[Dict], move_number: int = 0):
    """Recursively extract moves from a game node, including variations."""
    if node.variations:
        for variation in node.variations:
            # Save current board state to return to after this variation
            saved_board = board.copy()
            saved_number = move_number
            
            _extract_variation(board, variation, moves, move_number)
            
            # Restore board for next variation
            board = saved_board
            move_number = saved_number


def _extract_variation(board, node, moves: List[Dict], move_number: int):
    """Extract a single variation line."""
    current_node = node
    
    while current_node:
        move = current_node.move
        if move is None:
            break
        
        # Record the position BEFORE this move
        fen = board.fen()
        move_uci = move.uci()
        try:
            move_san = board.san(move)
        except Exception:
            move_san = board.san_and_push(move) or move_uci
            board.pop()
        
        side = "white" if board.turn == chess.WHITE else "black"
        comment = current_node.comment or ""
        move_number += 1
        
        # Make the move on the board
        board.push(move)
        
        # Record this as a learnable position
        moves.append({
            "fen": fen,
            "move_uci": move_uci,
            "move_san": move_san,
            "side": side,
            "move_number": move_number,
            "comment": comment,
        })
        
        # Handle sub-variations at this node
        if current_node.variations:
            saved_board = board.copy()
            saved_number = move_number
            
            # Main line is the first variation; side-lines are the rest
            for i, var in enumerate(current_node.variations):
                if i > 0:
                    board = saved_board.copy()
                    move_number = saved_number
                    _extract_variation(board, var, moves, move_number)
            
            # Continue with the first variation (main line)
            current_node = current_node.variations[0]
        else:
            current_node = current_node.next()


def parse_pgn_file(filepath: str) -> List[Dict]:
    """Parse a PGN file from disk."""
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        return parse_pgn(f.read())


def count_moves_in_pgn(pgn_text: str) -> int:
    """Quick count of how many learnable moves a PGN would produce."""
    return len(parse_pgn(pgn_text))
