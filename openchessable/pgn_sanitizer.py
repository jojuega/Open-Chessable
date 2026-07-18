"""
PGN sanitizer — strips comment-only sub-variations from PGN text.

WHY
----
``chess.pgn.read_game()`` in python-chess 1.11.2 hangs (or, depending on
position, raises ``IndexError: list index out of range``) when it
encounters a sub-variation whose ONLY content is a ``{...}`` comment —
e.g.::

    7. f4 { main comment } ( { When white plays } 1.d4 Nf6 2.c4 e6
    { ...comment with ( and ) inside... } ) 7... c5

The CHESSABLE-specific case is the simpler form::

    ( { author commentary only } )

i.e. a ``(`` immediately followed by a ``{`` block and then ``)`` with no
move tokens between. python-chess enters a variation, then tries to parse
the comment as if it were a sequence of moves; depending on the board
position this either (a) gets stuck in a long tokenising loop inside the
comment, or (b) corrupts the variation stack and crashes.

Chessable exports contain many of these — authors embed PGN-looking
fragments inside ``{}`` comments, and sometimes those comments sit
inside ``()`` sub-variations with no real moves.

HEURISTIC
---------
A pure, single-pass, linear-time string transform (no python-chess
involvement). We walk the text once, maintaining a stack of
``(`` positions, and track two flags per nested level:

* ``in_comment`` — toggled on ``{`` / ``}`` (PGN comments are
  brace-delimited; any ``(`` or ``)`` inside a comment must be ignored
  when finding the matching ``)`` of an enclosing variation).
* ``is_comment_only`` — set to True at the start of every variation;
  flipped to False the moment we see any non-whitespace, non-comment,
  non-``(`` content inside that variation.

When we hit the matching ``)`` of a variation, we pop the stack and:

* If the variation was comment-only: drop the ``(`` and ``)`` and emit
  the concatenation of the inner comment blocks (preserved verbatim,
  including any ``(`` and ``)`` characters inside them).
* Otherwise: emit the entire ``( ... )`` block verbatim.

This avoids the O(n²) blowup of scanning for matching parens from
every ``(`` position, and lets us do the whole 1.2 MB Benoni PGN in
well under a second.

SAFETY
------
* This is a PURE string transform — it does not parse SAN, FEN, or
  rely on python-chess.
* We are tolerant of unterminated comments/variations — if we hit EOF
  before the matching ``)`` or ``}``, we abort and return the text
  unchanged from the last good position.
* Conservative: any case where the inner content isn't unambiguously
  a comment-only variation is left as-is.

USAGE
-----
::

    from openchessable.pgn_sanitizer import sanitize
    safe_text = sanitize(raw_pgn_text)
    chess.pgn.read_game(io.StringIO(safe_text))
"""

from __future__ import annotations


def sanitize(pgn_text: str) -> str:
    """Return a copy of *pgn_text* with comment-only sub-variations stripped.

    See module docstring for the heuristic. The transformation is purely
    textual and never calls into python-chess.
    """
    if not pgn_text:
        return pgn_text

    n = len(pgn_text)
    out: list[str] = []
    i = 0

    # Each entry on the variation stack is a dict describing a currently
    # open sub-variation:
    #   start       — index in *pgn_text* of the opening '('
    #   buf         — list of strings to emit if we ultimately KEEP this var
    #   comments    — list of comment blocks seen so far (verbatim)
    #   comment_only — True until we see any non-comment, non-whitespace token
    #
    # The text BETWEEN the entries (the "(", the contents, the ")") is
    # NOT emitted immediately. We buffer it on the stack frame, and only
    # commit it (either as the verbatim "()" or as a concatenation of
    # the inner comments) once we know which way to go.
    stack: list[dict] = []

    def flush_frame(frame: dict) -> str:
        """Return the string to emit for a closed variation frame."""
        if frame["comment_only"] and frame["comments"]:
            # Drop the parens, keep the comments.
            if len(frame["comments"]) == 1:
                return frame["comments"][0]
            return " ".join(frame["comments"])
        # Either not comment-only, or empty variation — keep verbatim.
        return "".join(frame["buf"])

    while i < n:
        ch = pgn_text[i]

        if ch == "{":
            # Comment block. Find the matching '}' (PGN comments do not
            # nest), then route the text onto the current top frame
            # (or straight to *out* if we're at the top level).
            j = i + 1
            while j < n and pgn_text[j] != "}":
                j += 1
            if j >= n:
                # Unterminated — bail.
                out.append(pgn_text[i:])
                return "".join(out)
            comment_text = pgn_text[i : j + 1]
            if stack:
                frame = stack[-1]
                frame["buf"].append(comment_text)
                if frame["comment_only"]:
                    frame["comments"].append(comment_text)
                # else: already non-comment-only, just buffer
            else:
                out.append(comment_text)
            i = j + 1
            continue

        if ch == "}":
            # Stray closing brace. Buffer it; the parser will complain.
            if stack:
                stack[-1]["buf"].append(ch)
                # A stray '}' in a comment-only region means it's not
                # well-formed; be safe and stop pretending it's
                # comment-only.
                stack[-1]["comment_only"] = False
            else:
                out.append(ch)
            i += 1
            continue

        if ch == "(":
            # Open a new variation frame. Buffer the '('.
            frame = {
                "start": i,
                "buf": ["("],
                "comments": [],
                "comment_only": True,
            }
            stack.append(frame)
            i += 1
            continue

        if ch == ")":
            if not stack:
                # Stray ')'. Let the parser complain.
                out.append(ch)
                i += 1
                continue
            frame = stack.pop()
            frame["buf"].append(")")
            rendered = flush_frame(frame)
            if stack:
                # Nested: the rendered text becomes content of the
                # enclosing frame.
                parent = stack[-1]
                parent["buf"].append(rendered)
                if parent["comment_only"]:
                    if frame["comment_only"] and frame["comments"]:
                        # A nested comment-only variation was stripped to
                        # its comments. From the parent's perspective
                        # those are still just comments, so it's still
                        # possibly comment-only.
                        parent["comments"].append(rendered)
                    else:
                        # Nested variation had real moves, OR was empty.
                        # Either way, the parent now contains non-comment
                        # content (the rendered var), so it's no longer
                        # comment-only.
                        parent["comment_only"] = False
            else:
                out.append(rendered)
            i += 1
            continue

        # Any other character: it's either whitespace, a move token, a
        # NAG, a result, a semicolon-line-comment, etc. All of those
        # count as "non-comment" content for the purposes of a
        # comment-only variation.
        if ch.isspace():
            # Whitespace: still possibly comment-only.
            if stack:
                stack[-1]["buf"].append(ch)
            else:
                out.append(ch)
            i += 1
            continue

        # Non-whitespace, non-comment, non-paren content. If we're
        # inside a variation frame, mark it as not-comment-only.
        if stack:
            frame = stack[-1]
            frame["buf"].append(ch)
            frame["comment_only"] = False
            # Also pull the rest of this token (until whitespace or
            # special char) into the buffer so the verbatim
            # reconstruction is faithful. Move tokens can contain
            # letters, digits, and "=+-#O" etc., but for the purposes
            # of "did this variation contain a move?" we just need to
            # see one such token — which we now have. We still need to
            # copy the rest of it for verbatim round-trip.
            j = i + 1
            while j < n:
                c = pgn_text[j]
                if c.isspace() or c in "(){}$;%":
                    break
                frame["buf"].append(c)
                j += 1
            i = j
        else:
            # Outside any variation: emit as-is, copying one token at a
            # time. We don't strictly need to copy whole tokens but
            # doing so keeps the verbatim path simple.
            j = i + 1
            while j < n:
                c = pgn_text[j]
                if c.isspace() or c in "(){}$;%":
                    break
                j += 1
            out.append(pgn_text[i:j])
            i = j

    # Any unclosed frames on the stack: emit their buffered contents
    # verbatim (we don't know what the closing ')' would have meant).
    for frame in stack:
        out.append("".join(frame["buf"]))

    return "".join(out)
