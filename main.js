// explainr: select text in a Herdr terminal, press a key, get it explained in context.
//
// Opened with `mod.open:explainr` (see README). On open it copies the focused
// terminal's selection, reads that terminal's recent screen and folder, and asks
// Claude to explain the selection. When the terminal is running Claude Code, it
// asks a throwaway fork of that agent's own session, so the answer knows the whole
// conversation; the agent itself is never touched. Otherwise it asks a fresh
// read-only `claude -p` in the terminal's folder.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { run, props, closeOverlay, theme, focused, terminals, exec, hc, home, appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";

// --- Settings --------------------------------------------------------------
const CLAUDE = "claude";           // the Claude Code CLI (a name on PATH, or a full path)
const MODEL = null;                // null: Claude's default; or "sonnet", "haiku", "opus", ...
const TOOLS = "Read,Grep,Glob";    // read-only tools it may use to look around the repo
const SCREEN_LINES = 200;          // lines of terminal history sent as context
const TIMEOUT_MS = 180000;
// ---------------------------------------------------------------------------

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const sleep = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
const sh = (script, args = [], opts = {}) => exec("/bin/sh", ["-c", script, "sh", ...args], opts);
const paste = async () => (await sh("pbpaste")).stdout;
const copy = (text) => sh('printf %s "$1" | pbcopy', [text]);

// The Claude Code session running in a terminal, if any: Claude writes
// ~/.claude/sessions/<pid>.json for each running interactive session.
async function claudeSession(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return null;
  let info;
  try { info = JSON.parse(r.stdout); } catch { return null; }
  if (address.includes("/")) return null; // another machine: its sessions aren't here
  const pid = info?.foreground?.pid;
  if (!pid) return null;
  const file = await readTextFile(`${home()}/.claude/sessions/${pid}.json`).catch(() => null);
  if (!file) return null;
  try { return JSON.parse(file).sessionId ?? null; } catch { return null; }
}

function firstPrompt({ selection, screen, cwd, forked }) {
  return [
    forked
      ? "The user is looking at the terminal where this conversation is running. They selected some text in it and asked for an explanation. This is a side question: do not continue or change the task, and do not edit anything."
      : "The user selected some text in a terminal and asked for an explanation.",
    "",
    "Explain what the selected text means, in the context of what is happening in the terminal" +
      (forked ? " and in this conversation" : "") +
      ". Be concise and concrete: say what it is, why it is there, and anything the user should do about it. " +
      "Use Markdown. You may read files in the repository to answer, but do not change anything.",
    "",
    cwd ? `Terminal folder: ${cwd}` : "",
    "",
    "<selected_text>",
    selection,
    "</selected_text>",
    "",
    "<terminal_screen>",
    screen,
    "</terminal_screen>",
  ].join("\n");
}

function followUpPrompt(first, turns, question) {
  const history = turns.map((t) => `<question>\n${t.q}\n</question>\n<answer>\n${t.a}\n</answer>`).join("\n");
  return `${first}\n\nThe conversation so far about this selection:\n${history}\n\nThe user's follow-up question (answer it the same way):\n${question}`;
}

export default class Explainr extends View {
  init(_props, cx) {
    this.phase = "starting"; // starting | thinking | done | error
    this.turns = [];         // [{ q, a }]; the first q is null (the explain request)
    this.input = InputState.new({ placeholder: "Ask a follow-up…" });
    this.input.on("submit", (_e, cx) => this.followUp(cx));
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try { await this.start(cx); } catch (e) { this.fail(cx, String(e?.message ?? e)); }
    });
  }

  fail(cx, message) { this.phase = "error"; this.error = message; cx.notify(); }

  async start(cx) {
    const f = focused();
    const address = f?.terminal;
    if (!address) return this.fail(cx, "Focus a terminal and select some text first.");
    this.cwd = f.cwd ?? terminals().find((t) => t.address === address)?.cwd ?? null;

    this.address = address;
    this.log(`open: focused=${JSON.stringify(f)}`);

    // Copy the selection. A sentinel tells "nothing selected" apart from a
    // selection that matches the clipboard; the clipboard's text is put back.
    const before = await paste();
    this.clipboard = before;
    const sentinel = `explainr-${Date.now()}`;
    if (before) await copy(sentinel);
    const copied = async (label) => {
      for (let i = 0; i < 6; i++) {
        await sleep(cx, 80);
        const now = await paste();
        if (now && now !== sentinel) { this.log(`${label}: got ${now.length} chars`); return now; }
      }
      this.log(`${label}: nothing (focused=${JSON.stringify(focused())})`);
      return null;
    };
    run("terminal.copy");
    let after = await copied("copy");
    if (!after) {
      // This dialog has the keyboard, and copy follows the focused block:
      // give the terminal focus back for the copy, then take it again.
      run("pane.focus", { terminal: address });
      await sleep(cx, 60);
      run("terminal.copy");
      after = await copied("copy after pane.focus");
      this.handle.focus();
    }
    if (before) await copy(before);
    if (!after) {
      this.canUseClipboard = Boolean(before);
      return this.fail(cx, "Couldn't read a selection from the terminal. Select some text and press the key again" +
        (before ? ", or explain what's on your clipboard instead." : "."));
    }
    await this.explain(cx, after);
  }

  // Debug trail: ~/.config/herdr-app/data/explainr-debug.log (the last run only).
  log(line) {
    this.trail = `${this.trail ?? ""}${new Date().toISOString()} ${line}\n`;
    fs.writeFile(`${appHome()}/data/explainr-debug.log`, this.trail).catch(() => {});
  }

  useClipboard(cx) {
    this.canUseClipboard = false;
    this.phase = "starting";
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await this.explain(cx, this.clipboard); } catch (e) { this.fail(cx, String(e?.message ?? e)); }
    });
  }

  async explain(cx, selection) {
    const address = this.address;
    this.selection = selection;
    const [screen, session] = await Promise.all([
      hc(["read", address, "--lines", String(SCREEN_LINES)]).then((r) => (r.code === 0 ? r.stdout : "")),
      claudeSession(address),
    ]);
    this.session = session;
    this.first = firstPrompt({ selection: this.selection, screen, cwd: this.cwd, forked: Boolean(session) });
    await this.ask(cx, null, this.first);
  }

  async ask(cx, q, prompt) {
    this.phase = "thinking";
    this.turns.push({ q, a: null });
    cx.notify();
    const args = ["-p", "--no-session-persistence", "--tools", TOOLS, "--allowedTools", TOOLS];
    if (this.session) args.push("--resume", this.session, "--fork-session");
    if (MODEL) args.push("--model", MODEL);
    // The prompt goes in on stdin: `--tools` takes several values and would swallow it.
    const result = await exec("/bin/sh", ["-c", 'p="$1"; shift; printf %s "$p" | "$@"', "sh", prompt, CLAUDE, ...args],
      { cwd: this.cwd ?? home(), timeout: TIMEOUT_MS }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
    const turn = this.turns[this.turns.length - 1];
    if (result.code !== 0 || !result.stdout.trim()) {
      this.turns.pop();
      const why = (result.stderr || result.stdout).split("\n").filter((l) => l && !/^Warning:/.test(l)).join("\n");
      return this.fail(cx, why || `claude exited with code ${result.code}`);
    }
    turn.a = result.stdout.trim();
    this.phase = "done";
    cx.notify();
    this.input.focus();
  }

  followUp(cx) {
    const q = this.input.value().trim();
    if (!q || this.phase === "thinking" || !this.first) return;
    this.input.set_value("");
    const prompt = followUpPrompt(this.first, this.turns.filter((t) => t.a), q);
    cx.spawn(async (cx) => {
      try { await this.ask(cx, q, prompt); } catch (e) { this.fail(cx, String(e?.message ?? e)); }
    });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const button = (id, text, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const spinner = (label) => h_flex().gap(8).items_center().text_color(t.muted).text_size(12.5)
      .child(div().text_color(t.accent).frames(SPINNER, 90).child(SPINNER[0]))
      .child(label);
    const source = this.session ? "Fork of this Claude session" : this.selection ? "From the terminal screen" : "";

    const body = v_flex().gap(14);
    this.turns.forEach((turn, i) => {
      if (turn.q) body.child(div().pt(4).text_size(12.5).font_semibold().text_color(t.foreground).child(turn.q));
      body.child(turn.a
        ? TextView.markdown(`ex-answer-${i}`, turn.a).selectable(true).text_size(13).text_color(t.foreground)
        : spinner(this.session ? "Asking a fork of this Claude session…" : "Asking Claude…"));
    });
    if (this.phase === "starting") body.child(spinner("Reading the selection…"));
    if (this.phase === "error") body.child(div().text_size(12.5).text_color(t.blocked).child(this.error ?? "Something went wrong."));
    if (this.phase === "error" && this.canUseClipboard) body.child(h_flex().child(
      button("ex-clipboard", "Explain clipboard", true, (_e, cx) => this.useClipboard(cx))));

    const last = [...this.turns].reverse().find((x) => x.a);
    return v_flex().id("explainr").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(10)
        .child(div().text_size(15).font_semibold().child("Explain"))
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child(source))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(this.selection), (el) => el.child(
        div().id("ex-selection").max_h(96).overflow_y_scrollbar().px(10).py(8).rounded(8)
          .bg(t.background).border_1().border_color(t.border)
          .text_size(12).text_color(t.muted).child(this.selection)))
      .child(div().id("ex-body").flex_1().min_h(0).overflow_y_scrollbar().child(body))
      .child(h_flex().gap(8).items_center().justify_end()
        .when(Boolean(last), (el) => el.child(Input.new(this.input).flex_1().h(32).px(10).rounded(8).border_1().border_color(t.input)
          .bg(t.background).text_size(12.5).text_color(t.foreground))
          .child(button("ex-ask", "Ask", true, (_e, cx) => this.followUp(cx)))
          .child(button("ex-copy", "Copy", false, () => copy(last.a))))
        .child(button("ex-close", "Close", false, () => closeOverlay(p.overlay))));
  }
}
