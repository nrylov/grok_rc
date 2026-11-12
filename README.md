# Grok RC

Remote control for the [Grok CLI](https://x.ai). The agent keeps running on your computer, with your files and tools. A phone or another browser is only the window.

Nothing is installed on the phone. Open the link this process prints.

## Run

```bash
npm install
npm start
```

Or from a project folder:

```bash
npm start -- --cwd ~/src/my-app
```

Leave the process running. Ctrl+C stops the remote and the agent it started. It does not stop other `grok` sessions.

| Flag | |
|---|---|
| `--port 8787` | Page the browser opens |
| `--cwd PATH` | Default folder for a new task |
| `--host ADDRESS` | Bind address. Default is this Mac's LAN address (`en0`, currently `192.168.50.100`). `127.0.0.1` keeps it on this computer |
| `--approve` | Answer tool prompts here, instead of waiting for the browser |
| `--no-open` | Do not open the desktop browser |

The phone and the computer need to reach each other, usually the same Wi-Fi. macOS may ask to allow incoming connections the first time.

## What you can do

- See sessions that already live on this computer, and open one
- Send a message, attach a photo, and watch the reply stream
- Queue another message while a turn is running, or stop the turn
- Approve or deny a tool when the agent asks. **Always allow** needs a short hold
- Start a new task in a folder on this computer

The wide layout is a session rail plus the conversation. The narrow layout is a session list, then a full-screen chat. Add the page to your home screen if you want it to open like an app.

## Where state lives

Pairing token and the agent log are under `~/.grok/grok-rc/`. The token is in the phone link. Anyone on the network who has that link can drive the agent, so don't publish it.

The agent itself listens only on `127.0.0.1`.
