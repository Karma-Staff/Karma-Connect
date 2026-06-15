# Run Karma Connect on another device (the easy way)

No commands to type. Follow these steps on the new device.

## 1. Install Node.js (one time)
Download and install the **LTS** version from **https://nodejs.org** (click the big button, open the installer, keep clicking Next/Install). This is the only thing you install by hand.

## 2. Download the project from GitHub
1. Go to **https://github.com/Takdang-Tenzin-Woesel/Karma-Connect**
2. Click the green **`< > Code`** button → **Download ZIP**
3. **Unzip** the downloaded file (double-click it). You'll get a folder named `Karma-Connect-main`.

> No Git needed — the ZIP contains the whole project.

## 3. Double-click the setup file inside that folder
- **On Windows:** double-click **`setup.bat`**
- **On Mac:** double-click **`setup.command`**
  *(If Mac says it can't open it: right-click → Open → Open. Or open Terminal, type `bash `, drag the `setup.command` file onto the window, press Enter.)*

The setup will:
1. Check Node.js is installed
2. Install everything automatically
3. Ask you to **paste your Anthropic API key** (starts with `sk-ant-...`) — paste it and press Enter
4. Start the app

## 4. Open the app
When it says something like `Local: http://localhost:5173`, open that link in your browser. That's the app.

To stop it later, click the black setup window and press **Control + C**. To start it again another day, just double-click the setup file again (it remembers your key).

---

### Where do I get the Anthropic API key?
From the person who set this up, or from **https://console.anthropic.com** → API Keys. Paste the same key you use on your current device. Keep it private — never post it publicly.

### Want zero setup on every device instead?
Deploy the app once (see `DEPLOY.md`) and every device just opens a web link — nothing to install. Ask and I'll walk you through it.
