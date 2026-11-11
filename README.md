# herdr-explainr

A [Herdr](https://herdr.dev) app mod. Select text in any terminal, press
**⌘⇧E**, and Claude explains it in context.

- **In a Claude Code pane**, it asks a throwaway fork of that agent's own
  session (`claude -p --resume <session> --fork-session`), so the answer knows
  the whole conversation. The agent itself is never interrupted or changed, and
  the fork isn't saved.
- **In any other terminal** (a shell, logs, a test run), it asks a fresh
  `claude -p` in the terminal's folder.

Either way Claude gets the selection, the terminal's last 200 lines and the
folder, and may read files in the repo (`Read`, `Grep`, `Glob` only: it can't
edit or run anything). Ask follow-ups in the box under the answer.

## Requirements

- The Herdr desktop app (macOS; it uses `pbcopy`/`pbpaste`)
- [Claude Code](https://claude.com/claude-code) (`claude`) on your `PATH`, signed in

## Install

```sh
git clone https://github.com/cainus/herdr-explainr ~/.config/herdr-app/mods/explainr
```

Then bind a key in `~/.config/herdr-app/keys.json`, in the `terminal` section:

```json
"terminal": {
  "cmd-shift-e": "mod.open:explainr"
}
```

Herdr picks up both changes immediately. Pressing the key again closes the
dialog; so does Esc.

The folder must be named `explainr`, because that's the name the key opens.

## Settings

At the top of `main.js`:

| Constant | Default | What it does |
|---|---|---|
| `CLAUDE` | `"claude"` | The Claude Code CLI to run |
| `MODEL` | `null` | `null` for Claude's default, or `"sonnet"`, `"haiku"`, ... |
| `TOOLS` | `"Read,Grep,Glob"` | Read-only tools Claude may use |
| `SCREEN_LINES` | `200` | Lines of terminal history sent as context |
| `TIMEOUT_MS` | `180000` | How long to wait for an answer |

## How it works

1. Copies the focused terminal's selection (`terminal.copy`), then puts your
   clipboard's text back. Programs that track the mouse, like Claude Code, take
   the drag themselves, so Herdr has no selection; Claude Code copies its own
   selection to the clipboard, so explainr uses the clipboard then. (Hold Shift
   while dragging to make a Herdr selection instead.) Each run's steps are
   logged to `~/.config/herdr-app/data/explainr-debug.log`.
2. Reads the terminal's screen with `hc read`.
3. If the terminal's foreground process is Claude Code, finds its session ID
   in `~/.claude/sessions/<pid>.json` and forks that session.
4. Shows the answer as Markdown, with Copy and follow-up questions.

## License

MIT
