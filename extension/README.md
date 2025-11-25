# DNOutreach Extension

This is the Chrome Extension part of DNOutreach.

## Installation

1.  Open Chrome and navigate to `chrome://extensions`.
2.  Enable "Developer mode" in the top right corner.
3.  Click "Load unpacked".
4.  Select this `extension` directory.

## Configuration

The extension is configured to communicate with the backend at `https://dnoutreach.vercel.app`.
If you are running the backend locally, you may need to update `extension/background.js` to point to `http://localhost:3000`.
