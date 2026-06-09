# Karma Connect AI

AI-powered LinkedIn prospecting workspace for Karma Staff.

## Setup

### 1. Install Node.js
Download from https://nodejs.org — get the LTS version (18 or higher).

### 2. Open in VS Code
```
File → Open Folder → select the karma-connect folder
```

### 3. Add your API key
In the project root, create a file called `.env` (copy from `.env.example`):
```
VITE_ANTHROPIC_API_KEY=sk-ant-...your key here...
```
Get your key at: https://console.anthropic.com/

### 4. Install dependencies
Open the VS Code terminal (Ctrl+` or Terminal → New Terminal) and run:
```bash
npm install
```

### 5. Start the app
```bash
npm run dev
```

The app opens automatically at http://localhost:3000

---

## Notes

- The API key is stored locally in `.env` and never committed to git
- The app calls the Anthropic API directly from your browser
- To stop the server: Ctrl+C in the terminal
- To build for production: `npm run build`
