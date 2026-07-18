"""
Open-Chessable: pywebview desktop application entry point
Starts the Flask server and opens a native desktop window.
"""

import sys
import os
import threading
import webview

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import app as flask_app


def start_flask():
    """Run Flask in a background thread."""
    flask_app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False)


def main():
    # Start Flask server in background
    flask_thread = threading.Thread(target=start_flask, daemon=True)
    flask_thread.start()
    
    # Create and show the desktop window
    window = webview.create_window(
        title="Open-Chessable — SRS Chess Trainer",
        url="http://127.0.0.1:5000",
        width=1200,
        height=800,
        min_size=(900, 600),
        resizable=True,
        fullscreen=False,
    )
    
    webview.start()


if __name__ == "__main__":
    main()
