import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as review from "../mods/annotator/review.js";
import * as syntax from "../mods/annotator/syntax.js";
import { DraftLifecycle } from "../mods/annotator/draft.js";
import { GithubRefresh } from "../mods/annotator/github-refresh.js";
import { UpdateController } from "../mods/annotator/updates.js";

function harness() {
  const nodes = [], requests = [], jobs = [];
  const state = { scope: { repo: "/checkout", machine: null }, revision: "r1", reply: null,
    tab: "tab1", focus: { terminal: "t7", pane: "p7" }, commands: [], props: {}, shared: {}, layout: null, machines: [],
    agents: [{ address: "t7", pane: "p7", space: "space1", tab: "tab1", status: "idle" }] };
  function node() {
    const data = { children: [], events: {} };
    const proxy = new Proxy(data, { get(_target, key) {
      if (key === "then") return undefined;
      return (...args) => {
        if (key === "id") data.id = args[0];
        else if (key === "selectable") data.selectable = args[0];
        else if (key === "opacity") data.opacity = args[0];
        else if (key === "transition") data.transition = args;
        else if (key === "child") data.children.push(args[0]);
        else if (key === "children") data.children.push(...args[0]);
        else if (key === "when" && args[0]) args[1](proxy);
        else if (key.startsWith("on_")) data.events[key] = args.at(-1);
        return proxy;
      };
    }});
    nodes.push(data); return proxy;
  }
  function input(options) {
    if (state.forbidNewInputs) throw new Error("Native input state cannot be created during render");
    let value = options.value ?? "";
    const events = {};
    const input = { value: () => value, set_value(v) { value = v; }, on(name, fn) { events[name] = fn; },
      focus() {
        state.focusedInput?.emit("blur", {}); state.focusedInput = input; state.reviewFocused = false;
        events.focus?.({}, cx);
      }, emit(name, event) { events[name]?.(event, cx); }, release() {} };
    return input;
  }
  const snapshot = () => ({
    snapshot: { scope: { ...state.scope }, branch: "main", head: "head1", revision: state.revision,
      files: [{ path: "a.rs", status: " M", rows: [{ kind: "add", old: null, new: 2, text: "changed" }], loaded: true, truncated: false }], limited: false },
    comments: [{ id: "note1", path: "a.rs", body: "Inline note", stale: false, resolved: false, delivery: null, position: { side: "new", start: 2, end: 2 } }],
  });
  const cx = { notify() {}, stop_propagation() {}, write_to_clipboard: text => { state.clipboard = text; }, focus_handle: () => ({
    focus() { state.focusedInput?.emit("blur", {}); state.focusedInput = null; state.reviewFocused = true; },
    is_focused: () => Boolean(state.reviewFocused),
  }), timer: { every() {}, after(_ms, fn) {
    const timer = { cancelled: false, fire: () => { if (!timer.cancelled) fn(cx); }, cancel() { timer.cancelled = true; } };
    (state.timers ??= []).push(timer); return timer;
  } }, spawn(fn) { jobs.push(Promise.resolve().then(() => fn(cx))); } };
  const storage = new Map();
  const context = {
    ...review, ...syntax, DraftLifecycle, GithubRefresh, UpdateController,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    View: class {}, div: node, h_flex: node, v_flex: node, v_resizable: node, h_resizable: node,
    resizable_panel: () => { state.panelCalls = (state.panelCalls ?? 0) + 1; return node(); },
    shared: key => state.shared[key] ?? null, setShared: (key, value) => { state.saved = { key, value }; state.shared[key] = value; },
    layout: () => state.layout,
    machines: () => state.machines,
    appHome: () => "/app-home", watchFolder: async () => { throw new Error("Native file events unavailable in unit harness"); },
    v_virtual_list: (id, count, size, key, render) => {
      const result = node().id(id);
      state.virtual = { id, count, size, key, render };
      return result;
    },
    Scrollbar: { vertical: node },
    list: (id, count, key, render) => {
      const result = node().id(id);
      // gpui-shell 0.7.1 splices 0..old_count when the native item count changes.
      // GPUI moves a scroll position within that replaced range to its start.
      const previous = state.diffList;
      const scroll = previous?.id === id && previous.count === count ? previous.scroll : { index: 0, offset: 0 };
      state.diffList = { id, count, key, render, scroll }; return result;
    },
    run: (name, args) => { state.commands.push({ name, args }); },
    TextareaState: { new: input }, Textarea: { new: node },
    InputState: { new: input }, Input: { new: node },
    TextView: { html: (id, html) => { state.textViews ??= []; state.textViews.push({ id, html }); return node().id(id); } },
    props: () => ({ scope: state.scope, space: "space1", tab: state.tab, ...state.props }),
    theme: () => ({ dim: "#666666", ansi1: "#ff0000", ansi2: "#00ff00" }), settings: () => ({}),
    agents: () => state.agents, focused: () => state.focus,
    spaces: () => [{ id: "space1", tabs: [{ id: state.tab }, ...(state.reviewTabs ?? [])] }],
    panes: () => state.reviewPanes ?? [],
    home: () => "/home/me", exec: async (_helper, args) => {
      if (_helper === "python3") return { code: 0, stdout: JSON.stringify({ ok: true, data: { current: "0.2.0", latest: null, checked_at: Date.now() / 1000, job: {} } }) };
      if (_helper === "herdr-app") {
        state.commands.push({ name: args[1], args: JSON.parse(args[2]) });
        return { code: 0, stdout: JSON.stringify({ tab: "review-tab", pane: "review-pane" }) };
      }
      const request = JSON.parse(args[1]); requests.push(request);
      if (state.reply) return state.reply(request);
      return { code: 0, stdout: JSON.stringify({ ok: true, data: snapshot() }) };
    },
  };
  const source = readFileSync(process.env.HERDR_ANNOTATOR_TEST_MAIN ?? new URL("../mods/annotator/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class Annotator", "globalThis.Annotator = class Annotator");
  const full = readFileSync(new URL("../mods/annotator/full.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export function renderFull", "function renderFull");
  vm.runInNewContext(full, context);
  vm.runInNewContext(source, context);
  const mod = new context.Annotator();
  const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  return { mod, nodes, requests, state, cx, drain, snapshot };
}

test("saving sends the reviewed source anchor and keeps text on stale-code refusal", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.selection = { side: "new", start: 2, end: 2 };
  h.mod.editor.set_value("Keep my draft");
  h.state.reply = () => ({ code: 0, stdout: JSON.stringify({ ok: false, error: "The selected code changed" }) });
  h.mod.saveComment(h.cx); await h.drain();
  const request = h.requests.find(request => request.op === "add");
  assert.deepEqual(request.reviewed, { branch: "main", head: "head1", baseline: null,
    anchor: { lines: { selection: { side: "new", start: 2, end: 2 }, selected: ["changed"], before: [], after: [] } } });
  assert.equal(h.mod.editor.value(), "Keep my draft");
});

test("copy confirmation animates on the clicked button, resets, and cancels old timers", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const button = id => h.mod.button(id, "Copy error", cx => h.mod.copyText("error detail", cx));
  button("copy-error"); h.nodes.at(-1).events.on_click({}, h.cx);
  assert.equal(h.state.clipboard, "error detail");
  button("copy-error");
  assert.ok(h.nodes.at(-1).children.includes("✓ Copied"));
  assert.equal(h.nodes.at(-1).opacity, 0.72);
  assert.deepEqual(Array.from(h.nodes.at(-1).transition), ["opacity", 140]);
  const first = h.state.timers.at(-1);
  button("copy-path"); h.nodes.at(-1).events.on_click({}, h.cx);
  assert.equal(first.cancelled, true); first.fire();
  assert.equal(h.mod.copiedId, "copy-path");
  h.state.timers.at(-1).fire();
  assert.equal(h.mod.copiedId, null);
  button("copy-error");
  assert.ok(h.nodes.at(-1).children.includes("Copy error"));
  h.nodes.at(-1).events.on_click({}, h.cx); h.mod.close();
  assert.equal(h.state.timers.at(-1).cancelled, true);
});

for (const full of [false, true]) test(`${full ? "full" : "sidebar"} omits repeated composer and footer instructions`, async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.full = full; h.mod.editor.set_value("Draft"); h.mod.render(h.cx);
  const text = h.nodes.flatMap(node => node.children).filter(child => typeof child === "string").join("\n");
  assert.doesNotMatch(text, /General note · sent after|saves this comment|saves · not sent|Saved comments join|Save your draft|Read markers are local|One click submits/);
});

test("switching worktrees supersedes a pending snapshot without waiting for the old remote", async () => {
  const h = harness(), pending = [];
  h.state.reply = request => {
    if (request.op !== "snapshot") return { code: 0, stdout: JSON.stringify({ ok: true, data: {} }) };
    const data = h.snapshot();
    return new Promise(resolve => pending.push(() => resolve({ code: 0, stdout: JSON.stringify({ ok: true, data }) })));
  };
  h.mod.init({}, h.cx);
  await new Promise(setImmediate);
  assert.equal(pending.length, 1);
  h.state.scope = { repo: "/new-checkout", machine: null };
  h.mod.render(h.cx);
  assert.equal(JSON.parse(h.mod.context).scope.repo, "/new-checkout", "new checkout must load while old snapshot is pending");
  await new Promise(setImmediate);
  assert.equal(pending.length, 2);
  pending[0]();
  await new Promise(setImmediate);
  assert.equal(h.mod.busy, true, "old completion must not unlock the new request");
  assert.equal(h.mod.data, null, "old checkout must not reappear");
  pending[1](); await h.drain();
  assert.equal(h.mod.data.snapshot.scope.repo, "/new-checkout");
  assert.equal(h.mod.busy, false);
});

for (const full of [false, true]) test(`${full ? "full" : "sidebar"} review includes a general note and supports note-only sends`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  h.mod.data.comments = [];
  h.mod.reviewNote.editor.set_value("Please keep this change small.");
  h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.id === "review-general-note"));
  h.nodes.filter(n => n.id === (full ? "full-send" : "send-review")).at(-1).events.on_click(null, h.cx);
  await h.drain();
  assert.equal(h.requests.at(-1).note, "Please keep this change small.");
  assert.equal(h.mod.reviewNote.editor.value(), "");
});

test("general notes stay with their checkout and are included in exports, not individual thread fixes", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.reviewNote.editor.set_value("General direction");
  h.mod.act("export", {}, h.cx); await h.drain();
  assert.equal(h.requests.at(-1).note, "General direction");
  h.mod.sendToSession(h.cx, { id: "thread1", fingerprint: "v1" }); await h.drain();
  assert.equal(h.requests.at(-1).note, "");
  assert.equal(h.mod.reviewNote.editor.value(), "General direction");
  h.state.scope = { repo: "/other", machine: null }; h.mod.refresh(h.cx); await h.drain();
  assert.equal(h.mod.reviewNote.editor.value(), "");
  h.state.scope = { repo: "/checkout", machine: null }; h.mod.refresh(h.cx); await h.drain();
  assert.equal(h.mod.reviewNote.editor.value(), "General direction");
});

test("failed general note sends keep text and require checking chat before retry", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.reviewNote.editor.set_value("Keep this note");
  h.state.reply = request => { if (request.op === "send") throw new Error("Delivery not confirmed"); };
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.mod.reviewNote.editor.value(), "Keep this note");
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "send").length, 1);
  h.mod.render(h.cx);
  h.nodes.filter(n => n.id === "review-note-checked").at(-1).events.on_click(null, h.cx);
  h.state.reply = null; h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "send").length, 2);
  assert.equal(h.mod.reviewNote.editor.value(), "");
});

test("one click sends saved comments; rendering alone never sends", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.id === "diff-0"));
  assert.ok(h.nodes.some(n => n.id === "note-note1"));
  assert.ok(h.nodes.some(n => n.id === "save-note"));
   assert.equal(h.requests.length, 2); // Snapshot and read-only GitHub fetch; rendering never sends.
  assert.equal(h.mod.currentSession().address, "t7");
  h.nodes.filter(n => n.id === "send-review").at(-1).events.on_click(null, h.cx);
  assert.equal(h.mod.busy, true);
  h.mod.sendToSession(h.cx); // A second click during delivery cannot enqueue another send.
  await h.drain();
  assert.equal(h.requests.at(-1).op, "send"); assert.equal(h.requests.at(-1).target, "t7");
  assert.equal(h.requests.filter(r => r.op === "send").length, 1);
  h.mod.render(h.cx);
  assert.ok(!h.nodes.some(n => n.id === "cancel-send"));
});

test("update protection tracks active and hidden drafts and unmounts editors during installation", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  assert.equal(h.mod.updates.blockers(), false);
  h.mod.editor.set_value("keep this draft"); h.mod.editor.emit("change", {});
  assert.equal(h.mod.updates.blockers(), true);
  h.mod.cancelDraft(h.cx); assert.equal(h.mod.updates.blockers(), false);
  h.mod.draft.saved.set("other-checkout", { body: "hidden draft" }); h.mod.publishUpdateState();
  assert.equal(h.mod.updates.blockers(), true);
  h.mod.draft.saved.clear(); h.mod.publishUpdateState();
  h.mod.updates.gate(true);
  const before = h.requests.length, start = h.nodes.length;
  h.mod.render(h.cx); h.mod.sendToSession(h.cx); h.mod.refresh(h.cx);
  assert.ok(h.nodes.slice(start).some(n => n.id === "annotator-updating"));
  assert.ok(!h.nodes.slice(start).some(n => n.id === "save-note" || n.id === "send-review"));
  await assert.rejects(() => h.mod.request({ op: "send" }), /Update in progress/);
  assert.equal(h.requests.length, before);
});

test("read-only comments are selectable literal text and Copy preserves their exact body", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const body = '<img src="https://example.invalid/a.png">\nKeep & copy this';
  h.mod.data.comments[0].body = body; h.mod.render(h.cx);
  const view = h.state.textViews.find(v => v.id === "comment-body-note1");
  assert.ok(view.html.includes("&lt;img")); assert.ok(!view.html.includes("<img"));
  assert.ok(view.html.includes("<br>"));
  assert.equal(h.nodes.find(n => n.id === "comment-body-note1").selectable, true);
  const before = h.requests.length;
  h.nodes.find(n => n.id === "copy-comment-note1").events.on_click(null, h.cx);
  assert.equal(h.state.clipboard, body); assert.equal(h.requests.length, before);
});

test("Copy diff/selection works during refresh without losing source text or draft intent", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const file = h.mod.data.snapshot.files[0];
  file.rows = [{ kind: "delete", old: 2, new: null, text: "\told <value>" }, { kind: "add", old: null, new: 2, text: "\tnew λ & value" }];
  h.mod.selection = { side: "old", start: 2, end: 2 }; h.mod.busy = true;
  const before = h.requests.length; h.mod.copyMenu(file);
  h.nodes.find(n => n.id === "copy-selection").events.on_click(null, h.cx);
  assert.equal(h.state.clipboard, "\told <value>");
  h.nodes.find(n => n.id === "copy-diff").events.on_click(null, h.cx);
  assert.equal(h.state.clipboard, "-\told <value>\n+\tnew λ & value");
  assert.equal(h.mod.selection.side, "old"); assert.equal(h.requests.length, before);
});

test("dragging inline comment text does not activate editing or comment actions", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  h.state.diffList.render(2);
  assert.equal(h.nodes.find(n => n.id === "inline-body-note1").selectable, true);
  const frame = h.nodes.find(n => n.id === "full-diff-frame");
  frame.events.on_mouse_down({ local_position: { x: 10, y: 50 } });
  frame.events.on_mouse_up({ local_position: { x: 180, y: 50 } });
  h.nodes.find(n => n.id === h.state.diffList.id).events.on_item_click("notes-row-0", h.cx);
  assert.equal(h.mod.editDraft, undefined); assert.equal(h.mod.activeComment, null);
});

test("inline edit saves only that note, preserves later edits, and blocks accidental batch send", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.beginEdit(h.mod.data.comments[0], h.cx);
  h.mod.editDraft.editor.set_value("First edit");
  h.mod.sendToSession(h.cx); assert.equal(h.requests.filter(r => r.op === "send").length, 0);
  h.state.reply = async request => {
    if (request.op === "edit") h.mod.editDraft.editor.set_value("Later edit");
    const data = h.snapshot(); data.comments[0].body = request.body;
    return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  h.mod.saveEdit(h.cx); await h.drain();
  assert.equal(h.requests.at(-1).op, "edit");
  assert.equal(h.requests.at(-1).expected_body, "Inline note");
  assert.equal(h.mod.editDraft.editor.value(), "Later edit");
  assert.equal(h.mod.editDraft.expected_body, "First edit");
  h.state.reply = async request => { const data = h.snapshot(); data.comments[0].body = request.body; return { code: 0, stdout: JSON.stringify({ ok: true, data }) }; };
  h.mod.saveEdit(h.cx); await h.drain(); assert.equal(h.mod.editDraft, undefined);
});

test("delete needs explicit confirmation and never exposes editing for delivery history", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.view = "comments"; h.mod.render(h.cx);
  const before = h.requests.length;
  h.nodes.find(n => n.id === "delete-note1").events.on_click(null, h.cx);
  assert.equal(h.requests.length, before); h.mod.render(h.cx);
  h.nodes.find(n => n.id === "confirm-delete-note1").events.on_click(null, h.cx); await h.drain();
  assert.equal(h.requests.at(-1).op, "delete"); assert.equal(h.requests.at(-1).expected_body, "Inline note");
  h.mod.data.comments[0].delivery = "uncertain";
  const start = h.nodes.length; h.mod.render(h.cx);
  assert.ok(!h.nodes.slice(start).some(n => n.id === "edit-note1" || n.id === "delete-note1"));
});

for (const full of [false, true]) test(`${full ? "full" : "sidebar"} quick ask sends a question only after explicit Send`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  h.nodes.find(n => n.id === (full ? "full-ask-file" : "ask-file")).events.on_click(null, h.cx);
  assert.equal(h.requests.filter(r => r.op === "ask").length, 0);
  h.mod.questionDraft.editor.set_value("Why this change?");
  h.state.reply = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { question: { status: "confirmed", error: null } } }) });
  h.mod.sendQuestion(h.cx); h.mod.sendQuestion(h.cx); await h.drain();
  const request = h.requests.at(-1);
  assert.equal(request.op, "ask"); assert.equal(request.target, "t7"); assert.equal(request.context.kind, "file");
  assert.equal(h.requests.filter(r => r.op === "ask").length, 1);
  assert.equal(h.mod.questionDraft, undefined); assert.equal(h.mod.data.comments[0].delivery, null);
});

test("uncertain quick ask keeps draft, refuses automatic resend, and never redirects retries", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.beginQuestion({ kind: "selection", selection: { side: "new", start: 2, end: 2 } }, h.cx);
  h.mod.questionDraft.editor.set_value("Explain");
  h.state.agents[0].status = "working"; h.mod.sendQuestion(h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "ask").length, 0);
  h.state.agents[0].status = "idle";
  h.state.reply = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { question: { status: "uncertain", error: "offline" } } }) });
  h.mod.sendQuestion(h.cx); await h.drain(); h.mod.sendQuestion(h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "ask").length, 1);
  h.state.agents[0].address = "t8"; h.state.focus = { terminal: "t8", pane: "p7" };
  h.mod.sendQuestion(h.cx, true); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "ask").length, 1);
  assert.match(h.mod.questionDraft.error, /original question and recipient/);
});

test("full split-diff right-click preserves the old side and original hunk index", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain(); h.mod.data.comments = [];
  h.mod.data.snapshot.files[0].rows = [
    { kind: "hunk", old: null, new: null, text: "@@ -1 +1 @@" },
    { kind: "delete", old: 1, new: null, text: "old" },
    { kind: "add", old: null, new: 1, text: "new" },
    { kind: "hunk", old: null, new: null, text: "@@ -9 +9 @@" },
    { kind: "context", old: 9, new: 9, text: "same" },
  ];
  h.mod.render(h.cx);
  const list = h.nodes.filter(n => n.id === h.state.diffList.id).at(-1);
  const frame = h.nodes.filter(n => n.id === "full-diff-frame").at(-1);
  frame.events.on_mouse_down({ bounds: { width: 1000 }, local_position: { x: 10 } });
  list.events.on_item_secondary_click("row-1", h.cx);
  assert.equal(h.mod.questionDraft.context.selection.side, "old");
  h.mod.questions.clear(); list.events.on_item_secondary_click("row-2", h.cx);
  assert.equal(h.mod.questionDraft.context.kind, "hunk");
  assert.equal(h.mod.questionDraft.context.row, 3);
  assert.equal(h.requests.filter(r => r.op === "ask").length, 0);
});

test("open-file API refreshes first, preserves drafts, and never consumes a newer request", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const request = id => ({ id, at: Date.now(), path: "/checkout/a.rs", on: null });
  h.state.shared["annotator.open"] = request("first"); h.mod.editor.set_value("Unsaved");
  h.mod.consumeOpenRequest(h.cx); assert.equal(h.state.shared["annotator.open"].id, "first");
  h.mod.cancelDraft(h.cx); h.mod.view = "comments";
  h.state.reply = async () => {
    h.state.shared["annotator.open"] = request("second");
    return { code: 0, stdout: JSON.stringify({ ok: true, data: h.snapshot() }) };
  };
  h.mod.consumeOpenRequest(h.cx); await h.drain();
  assert.equal(h.state.shared["annotator.open"].id, "second");
  h.state.reply = null; h.mod.consumeOpenRequest(h.cx); await h.drain(); h.mod.consumeOpenRequest(h.cx);
  assert.equal(h.state.shared["annotator.open"], null); assert.equal(h.mod.view, "diff");
  h.state.shared["annotator.open"] = { ...request("remote"), on: "remote" };
  h.mod.consumeOpenRequest(h.cx); assert.equal(h.state.shared["annotator.open"].id, "remote");
  h.state.shared["annotator.open"] = { ...request("expired"), at: Date.now() - 31000 };
  h.mod.consumeOpenRequest(h.cx); assert.equal(h.state.shared["annotator.open"], null);
});

test("bindable commands cycle Last commit without sending and preserve unfinished scope drafts", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.handleCommand("scope", h.cx); await h.drain();
  assert.equal(h.mod.mode, "last_commit"); assert.equal(h.requests.at(-1).scope.comparison.mode, "last_commit");
  h.mod.editor.set_value("Draft"); h.mod.handleCommand("scope", h.cx); await h.drain();
  assert.equal(h.mod.mode, "branch");
  assert.ok([...h.mod.navigationDrafts.values()].some(draft => draft.body === "Draft"));
  assert.equal(h.requests.filter(r => r.op === "send").length, 0);
});

test("Last commit remains selectable when the initial Branch comparison fails", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.state.reply = async request => request.op === "snapshot" && request.scope.comparison.mode === "branch"
    ? { code: 1, stdout: JSON.stringify({ ok: false, error: "Base 'develop' is not available locally" }) }
    : { code: 0, stdout: JSON.stringify({ ok: true, data: h.snapshot() }) };
  h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  assert.equal(h.mod.data, null);
  const button = h.nodes.find(n => n.id === "full-scope-last-commit");
  assert.equal(typeof button.events.on_click, "function", "a failed branch load cannot trap the comparison picker");
  button.events.on_click(null, h.cx); await h.drain();
  assert.equal(h.mod.mode, "last_commit"); assert.ok(h.mod.data); assert.equal(h.mod.snapshotError, null);
});

test("typed branch refs, including develop, submit an explicit comparison", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  h.nodes.find(n => n.id === "full-base").events.on_click(null, h.cx); h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.id === "base-ref-input"));
  h.mod.baseEditor.set_value("develop"); h.mod.baseEditor.emit("submit", {}); await h.drain();
  assert.equal(h.requests.at(-1).scope.comparison.mode, "branch");
  assert.equal(h.requests.at(-1).scope.comparison.base, "develop");
  assert.equal(h.mod.baseExplicit, true);
});

test("typing does not block file or comparison navigation; each draft returns with its own anchor", async () => {
  const h = harness();
  h.state.reply = async request => {
    const data = h.snapshot(), file = request.view?.file ?? "a.rs", mode = request.scope.comparison?.mode ?? "uncommitted";
    data.snapshot.files.push({ ...data.snapshot.files[0], path: "b.rs" });
    data.snapshot.revision = `${mode}-${file}`; data.snapshot.view = { file, context: 3 };
    return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  h.mod.init({}, h.cx); await h.drain();
  h.mod.selectLine(h.mod.data.snapshot.files[0].rows[0], {}, h.cx); h.mod.editor.set_value("Draft A");
  h.mod.selectFile("b.rs", h.cx); await h.drain();
  assert.equal(h.mod.open, "b.rs"); assert.equal(h.mod.editor.value(), "");
  h.mod.editor.set_value("Draft B"); h.mod.selectFile("a.rs", h.cx); await h.drain();
  assert.equal(h.mod.editor.value(), "Draft A"); assert.equal(h.mod.selection.start, 2);
  h.mod.changeComparison("last_commit", null, h.cx); await h.drain();
  assert.equal(h.mod.mode, "last_commit"); assert.equal(h.mod.editor.value(), "");
  h.mod.editor.set_value("Last commit draft"); h.mod.changeComparison("uncommitted", null, h.cx); await h.drain();
  assert.equal(h.mod.editor.value(), "Draft A");
  h.mod.changeComparison("last_commit", null, h.cx); await h.drain();
  assert.equal(h.mod.editor.value(), "Last commit draft");
  assert.equal(h.requests.filter(r => r.op === "add" || r.op === "send").length, 0);
});

test("a draft restored after code changes keeps its text and requires reselection before saving", async () => {
  const h = harness();
  h.state.reply = async request => {
    const data = h.snapshot(); data.snapshot.files.push({ ...data.snapshot.files[0], path: "b.rs" });
    data.snapshot.view = { file: request.view?.file ?? "a.rs", context: 3 };
    return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  h.mod.init({}, h.cx); await h.drain();
  h.mod.selectLine(h.mod.data.snapshot.files[0].rows[0], {}, h.cx); h.mod.editor.set_value("Keep my original note");
  h.mod.selectFile("b.rs", h.cx); await h.drain(); h.state.revision = "changed-code";
  h.mod.selectFile("a.rs", h.cx); await h.drain();
  assert.equal(h.mod.editor.value(), "Keep my original note"); assert.equal(h.mod.needsSelection, true);
  h.mod.saveComment(h.cx); await h.drain(); assert.equal(h.requests.filter(r => r.op === "add").length, 0);
});

test("opening full review does not block or discard an unfinished source comment", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.editor.set_value("Finish this later");
  h.mod.openFull(h.cx); await h.drain();
  const made = h.state.commands.find(command => command.name === "tab.new");
  assert.equal(made.args.props.source_draft, true);
  assert.equal(h.mod.editor.value(), "Finish this later");
});

test("a draft remains reachable when its file leaves the comparison", async () => {
  const h = harness();
  h.state.reply = async () => {
    const data = h.snapshot(); data.snapshot.files.push({ ...data.snapshot.files[0], path: "b.rs" });
    return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  h.mod.init({}, h.cx); await h.drain(); h.mod.editor.set_value("Keep this draft");
  h.mod.selectFile("b.rs", h.cx); await h.drain();
  h.state.reply = async () => {
    const data = h.snapshot(); data.snapshot.files[0].path = "b.rs"; data.snapshot.revision = "without-a";
    return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  h.mod.refresh(h.cx); await h.drain();
  assert.equal(h.mod.reviewFiles().find(file => file.path === "a.rs").draftOnly, true);
  h.mod.selectFile("a.rs", h.cx); await h.drain();
  assert.equal(h.mod.editor.value(), "Keep this draft"); assert.equal(h.mod.canSaveComment(), false);
  h.mod.cancelDraft(h.cx); assert.ok(!h.mod.reviewFiles().some(file => file.path === "a.rs"));
});

test("new-checkout rendering never creates retained note/editor state", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.state.scope = { repo: "/another-checkout", machine: null };
  h.state.forbidNewInputs = true;
  assert.doesNotThrow(() => h.mod.render(h.cx));
  h.state.forbidNewInputs = false; await h.drain();
  assert.ok(h.mod.reviewNotes.has(h.mod.context));
});

for (const full of [false, true]) test(`${full ? "full review" : "sidebar"} hides resolved local notes and GitHub threads; toggle keeps history recoverable`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  h.mod.data.comments.push({ ...h.mod.data.comments[0], id: "closed", resolved: true });
  h.mod.data.comments.push({ ...h.mod.data.comments[0], id: "missing", path: "gone.rs", resolved: true, stale: true, position: null });
  h.mod.github = { threads: [{ id: "thread-closed", resolved: true, comments: [], read: false }] };
  const before = h.requests.length;
  const render = () => { const start = h.nodes.length; h.mod.render(h.cx); return h.nodes.slice(start); };
  let nodes = render();
  assert.ok(!nodes.some(n => n.id === "note-closed" || n.id === "note-missing"));
   if (full) assert.equal(h.state.diffList.count, 3, "stable source/note slots omit resolved content");
  const toggle = full ? "full-resolved" : "filter-resolved";
  nodes.find(n => n.id === toggle).events.on_click(null, h.cx);
  assert.equal(h.state.shared["annotator.showResolved"], true);
  h.mod.view = "comments"; nodes = render();
  assert.ok(nodes.some(n => n.id === "note-closed"));
  assert.ok(nodes.some(n => n.id === "note-missing"));
  assert.ok(nodes.some(n => n.id === "resolve-closed"), "hidden history can still be reopened");
  h.mod.view = "github"; nodes = render();
  assert.ok(nodes.some(n => n.id === "thread-thread-closed"));
  nodes.find(n => n.id === toggle).events.on_click(null, h.cx);
  nodes = render();
  assert.ok(!nodes.some(n => n.id === "thread-thread-closed"));
  assert.equal(h.requests.length, before, "visibility never sends or mutates saved notes");
  assert.equal(h.mod.data.comments.length, 3);
  assert.equal(review.pendingComments(h.mod.data.comments).length, 1);
});

for (const full of [false, true]) test(`${full ? "full review" : "sidebar"} hides confirmed local and GitHub sends immediately and retains history`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  const sent = h.snapshot(); sent.comments[0].delivery = "sent";
  sent.github = { threads: [{ id: "sent-thread", resolved: false, delivery: "sent", comments: [] },
    { id: "uncertain-thread", resolved: false, delivery: "uncertain", comments: [] }] };
  h.state.reply = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: sent }) });
  h.mod.sendToSession(h.cx); await h.drain();
  const render = () => { const start = h.nodes.length; h.mod.render(h.cx); return h.nodes.slice(start); };
  let nodes = render();
  assert.ok(!nodes.some(n => n.id === "note-note1"));
  assert.equal(h.mod.resolvedCount(), 2);
  h.mod.view = "github"; nodes = render();
  assert.ok(!nodes.some(n => n.id === "thread-sent-thread"));
  assert.ok(nodes.some(n => n.id === "thread-uncertain-thread"));
  nodes.find(n => n.id === (full ? "full-resolved" : "filter-resolved")).events.on_click(null, h.cx);
  nodes = render(); assert.ok(nodes.some(n => n.id === "thread-sent-thread"));
  h.mod.view = "comments"; nodes = render(); assert.ok(nodes.some(n => n.id === "note-note1"));
  assert.equal(h.mod.data.comments[0].resolved, false);
  assert.equal(h.requests.filter(r => r.op === "send").length, 1);
});

test("resolved visibility is restored from shared settings and composes with Unread only", async () => {
  const h = harness(); h.state.shared["annotator.showResolved"] = true;
  h.mod.init({}, h.cx); await h.drain();
  h.mod.data.comments[0].resolved = true; h.mod.data.comments[0].read = true;
  h.mod.view = "comments"; h.mod.onlyUnread = true;
  h.mod.render(h.cx);
  assert.equal(h.mod.showResolved, true);
  assert.ok(!h.nodes.some(n => n.id === "note-note1"));
  assert.ok(h.nodes.some(n => n.children.includes("No comments match these filters")));
  h.mod.onlyUnread = false; h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.id === "note-note1"));
});

for (const full of [false, true]) test(`${full ? "full review" : "sidebar"} posts GitHub replies only through its explicit button`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  const thread = { id: "reply1", fingerprint: "v1", path: "a.rs", line: 2, side: "RIGHT", comments: [{ author: "reviewer", body: "Handle empty input" }] };
  h.state.agents[0].status = "working"; // Posting to GitHub is independent of agent delivery.
  h.mod.github = { threads: [thread] }; h.mod.view = "github"; h.mod.render(h.cx);
  const before = h.requests.length;
  h.nodes.filter(n => n.id === "reply-thread-reply1").at(-1).events.on_click(null, h.cx);
  const draft = [...h.mod.githubDrafts.values()][0]; draft.editor.set_value("Fixed, thanks.");
  h.mod.render(h.cx); assert.equal(h.requests.length, before);
  h.mod.threadQueue.set(thread.id, { id: thread.id, fingerprint: "v1" });
  h.state.reply = async request => ({ code: 0, stdout: JSON.stringify({ ok: true, data: {
    github: { threads: [{ ...thread, fingerprint: "v2" }] }, reply_id: request.reply_id, reply: { status: "confirmed", error: null },
  } }) });
  h.nodes.filter(n => n.id === "post-reply-reply1").at(-1).events.on_click(null, h.cx);
  h.mod.postGithubReply(thread, h.cx); // Double-click guard.
  await h.drain();
  const posts = h.requests.filter(r => r.op === "github_reply");
  assert.equal(posts.length, 1); assert.equal(posts[0].body, "Fixed, thanks.");
  assert.equal(posts[0].retry, false); assert.equal(h.mod.githubDrafts.size, 0);
  assert.equal(h.mod.threadQueue.size, 0); assert.equal(h.requests.filter(r => r.op === "send").length, 0);
});

test("uncertain GitHub reply keeps text and never retries without the explicit checked action", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const thread = { id: "reply1", fingerprint: "v1", comments: [] };
  h.mod.github = { threads: [thread] }; h.mod.beginGithubReply(thread, h.cx);
  const draft = [...h.mod.githubDrafts.values()][0]; draft.editor.set_value("Keep this reply");
  h.state.reply = async request => ({ code: 0, stdout: JSON.stringify({ ok: true, data: {
    github: { threads: [thread] }, reply_id: request.reply_id, reply: { status: request.retry ? "confirmed" : "uncertain", error: "Lost response" },
  } }) });
  h.mod.postGithubReply(thread, h.cx); await h.drain();
  const before = h.requests.length;
  assert.equal(draft.editor.value(), "Keep this reply"); assert.equal(draft.status, "uncertain");
  h.mod.postGithubReply(thread, h.cx); await h.drain(); assert.equal(h.requests.length, before);
  h.mod.postGithubReply(thread, h.cx, true); await h.drain();
  assert.equal(h.requests.at(-1).retry, true); assert.equal(h.mod.githubDrafts.size, 0);
});

test("late GitHub reply completion preserves later edits and ignores another checkout", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const thread = { id: "reply1", fingerprint: "v1", comments: [] };
  h.mod.beginGithubReply(thread, h.cx); const draft = [...h.mod.githubDrafts.values()][0];
  draft.editor.set_value("First reply");
  h.state.reply = async request => {
    draft.editor.set_value("Later edit"); h.state.scope = { repo: "/other", machine: null };
    return { code: 0, stdout: JSON.stringify({ ok: true, data: { github: { threads: [thread] }, reply_id: request.reply_id, reply: { status: "confirmed" } } }) };
  };
  h.mod.postGithubReply(thread, h.cx); await h.drain();
  assert.equal(draft.editor.value(), "Later edit"); assert.equal(h.mod.githubDrafts.size, 1);
  assert.notEqual(draft.id, h.requests.at(-1).reply_id);
  assert.equal(h.mod.notice, null);
});

for (const full of [false, true]) test(`${full ? "full review" : "sidebar"} labels GitLab merge request discussions`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  const thread = { id: "d1", fingerprint: "v1", path: "", line: null, side: "", comments: [{ author: "reviewer", body: "Explain the rollout" }] };
  h.mod.github = { provider: "gitlab", threads: [thread] }; h.mod.view = "github"; h.mod.render(h.cx);
  const text = h.nodes.flatMap(n => n.children).filter(c => typeof c === "string");
  assert.ok(text.includes("GitLab · 1"), "tab is labelled GitLab");
  assert.ok(!text.includes("GitHub · 1"));
  assert.ok(text.includes("Merge request discussion"), "general discussions have no file location");
  h.nodes.filter(n => n.id === "reply-thread-d1").at(-1).events.on_click(null, h.cx); h.mod.render(h.cx);
  const labels = h.nodes.flatMap(n => n.children).filter(c => typeof c === "string");
  assert.ok(labels.includes("Post to GitLab"));
  assert.ok(labels.includes("Posts as your signed-in GitLab account. Does not send to the agent."));
  h.mod.github = { provider: "gitlab", threads: [] }; h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.children.some(c => typeof c === "string" && c.startsWith("No open MR found"))));
});

test("missing GitHub CLI guidance does not disable local comment saving or sending", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.github = { error: "GitHub CLI (gh) was not found. Install it from https://cli.github.com, then run gh auth login. Local reviews still work.", threads: [] };
  h.mod.view = "github"; h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.children.includes("GitHub unavailable · local reviews still work")));
  assert.ok(h.nodes.filter(n => n.id === "send-review").at(-1).events.on_click);
  assert.equal(h.mod.snapshotError, null);
});

test("resolve emits the documented request without an invalid revision field", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.act("resolve", { id: "note1", resolved: true }, h.cx); await h.drain();
  assert.equal(h.requests.at(-1).op, "resolve");
  assert.equal("revision" in h.requests.at(-1), false);
});

test("refresh preserves drafts; changed previews clear bare line selections", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.editor.set_value("unsaved draft"); h.mod.refresh(h.cx); await h.drain();
  assert.equal(h.requests.length, 2); assert.equal(h.mod.editor.value(), "unsaved draft");
  h.mod.editor.set_value(""); h.mod.selection = { side: "new", start: 2, end: 2, origin: 2 };
  h.state.revision = "r2"; h.mod.refresh(h.cx); await h.drain();
  assert.equal(h.mod.selection, null);
});

test("save finishing during a space switch does not resurrect a duplicate draft", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.editor.set_value("to save");
  h.state.reply = async () => {
    h.state.scope = { repo: "/other", machine: null };
    return { code: 0, stdout: JSON.stringify({ ok: true, data: h.snapshot() }) };
  };
  h.mod.act("add", { path: "a.rs", selection: null, body: "to save" }, h.cx); await h.drain();
  assert.equal(h.mod.editor.value(), ""); assert.equal(h.mod.drafts.size, 0);
});

test("comments on a file that leaves the diff render once, as outdated notes", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.data.snapshot.files = [];
  h.mod.data.comments[0].stale = true; h.mod.data.comments[0].position = null;
  h.mod.render(h.cx);
  assert.equal(h.nodes.filter(n => n.id === "note-note1").length, 1);
});

test("one-click send resolves the current chat rather than a stale recipient", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.state.agents.push({ address: "t8", pane: "p8", space: "space1", tab: "tab1", status: "idle" });
  h.mod.render(h.cx); // Initially displays t7.
  h.state.focus = { terminal: "t8", pane: "p8" };
  h.nodes.filter(n => n.id === "send-review").at(-1).events.on_click(null, h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "send").length, 1);
  assert.equal(h.requests.at(-1).target, "t8");
});

test("one-click send still refuses unsaved drafts and empty batches", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.editor.set_value("unsaved"); h.mod.sendToSession(h.cx); await h.drain();
  h.mod.editor.set_value(""); h.mod.data.comments = []; h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "send").length, 0);
});

test("composer focus retains the exact chat when sending to a working session", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  h.state.focus = { terminal: null, pane: null };
  assert.equal(h.mod.currentSession().address, "t7");
  h.state.agents[0].status = "working";
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "send").length, 1);
  assert.equal(h.requests.at(-1).target, "t7");
});

test("Comments tab exposes every saved note without sending or mutating", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  const stale = { ...h.mod.data.comments[0], id: "outdated", path: "gone.rs", stale: true, position: null };
  h.mod.data.comments.push(stale);
  h.nodes.find(n => n.id === "view-comments").events.on_click(null, h.cx);
  const start = h.nodes.length; h.mod.render(h.cx);
  const current = h.nodes.slice(start);
  assert.ok(current.some(n => n.id === "review-comments"));
  assert.equal(current.filter(n => n.id === "note-note1").length, 1);
  assert.equal(current.filter(n => n.id === "note-outdated").length, 1);
  assert.equal(h.requests.length, 2);
});

test("file-list collapse is local UI state and draft reselection can choose a file comment", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  h.nodes.find(n => n.id === "toggle-files").events.on_click(null, h.cx);
  const start = h.nodes.length; h.mod.render(h.cx);
  assert.ok(!h.nodes.slice(start).some(n => n.id === "review-files"));
  h.mod.editor.set_value("kept draft"); h.mod.draft.observe("changed", "r1");
  h.mod.render(h.cx);
  h.nodes.filter(n => n.id === "file-note").at(-1).events.on_click(null, h.cx);
  assert.equal(h.mod.needsSelection, false); assert.equal(h.mod.editor.value(), "kept draft");
  assert.equal(h.requests.length, 2);
});

test("stale line draft cannot become a file note after a checkout round trip", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.draft.anchor({ side: "new", start: 2, end: 2 }, "r1");
  h.mod.editor.set_value("line intent"); h.mod.snapshotFailed("Connection timed out", h.state.scope);
  h.state.revision = "r2"; h.mod.refresh(h.cx, true); await h.drain();
  assert.equal(h.mod.needsSelection, true);
  h.state.scope = { repo: "/other", machine: null }; h.mod.refresh(h.cx); await h.drain();
  h.state.scope = { repo: "/checkout", machine: null }; h.mod.refresh(h.cx); await h.drain();
  assert.equal(h.mod.needsSelection, true);
  h.mod.saveComment(h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "add").length, 0);
  h.mod.fileNote(h.cx); h.mod.saveComment(h.cx); await h.drain();
  assert.equal(h.requests.at(-1).selection, null);
});

test("new checkout receives GitHub refresh after an old request finishes", async () => {
  const h = harness(); let release;
  h.state.reply = async request => {
    if (request.op === "github" && request.scope.repo === "/checkout") {
      await new Promise(resolve => { release = resolve; });
    }
    return { code: 0, stdout: JSON.stringify({ ok: true, data: request.op === "github"
      ? { github: { threads: [], repo: request.scope.repo } } : h.snapshot() }) };
  };
  h.mod.init({}, h.cx); await new Promise(setImmediate);
  h.state.scope = { repo: "/new", machine: null }; h.mod.refresh(h.cx);
  await new Promise(setImmediate); release(); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "github" && r.scope.repo === "/new").length, 1);
  assert.equal(h.mod.github.repo, "/new"); assert.equal(h.mod.githubBusy, false);
});

test("late files and context changes request fresh lazy previews", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.selectFile("file-249.rs", h.cx); await h.drain();
  assert.equal(h.requests.at(-1).view.file, "file-249.rs");
  h.mod.expandContext(23, h.cx); await h.drain();
  assert.equal(h.requests.at(-1).view.context, 23);
  h.mod.editor.set_value("draft");
  h.mod.expandContext(1000000, h.cx); await h.drain();
  assert.equal(h.mod.contextLines, 1000000);
  assert.equal(h.mod.editor.value(), "draft");
});

test("Branch comparison and base are independent of Code and Comments tabs", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.changeComparison("branch", "origin/main", h.cx); await h.drain();
  assert.equal(h.requests.at(-1).scope.comparison.mode, "branch");
  assert.equal(h.requests.at(-1).scope.comparison.base, "origin/main");
  h.mod.render(h.cx);
  h.nodes.filter(n => n.id === "view-comments").at(-1).events.on_click(null, h.cx);
  assert.equal(h.mod.mode, "branch");
});

test("section drag sizes persist and context controls render", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  h.nodes.find(n => n.events.on_resize).events.on_resize([210, 400, 190], h.cx);
  assert.equal(h.state.saved.key, "annotator.sections");
  assert.deepEqual(h.state.saved.value, [210, 400, 190]);
  assert.ok(h.nodes.some(n => n.id === "context-more"));
  assert.ok(h.nodes.some(n => n.id === "context-all"));
});

test("Fix thread excludes local notes; batches include queued fingerprints", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const thread = { id: "t1", fingerprint: "fp1" };
  h.mod.sendToSession(h.cx, thread); await h.drain();
  assert.equal(h.requests.at(-1).include_local, false);
  assert.deepEqual(h.requests.at(-1).threads, [thread]);
  h.mod.threadQueue.set(thread.id, thread);
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.requests.at(-1).include_local, true);
  assert.deepEqual(h.requests.at(-1).threads, [thread]);
});

test("GitHub refresh drops changed queued thread versions without sending", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.threadQueue.set("t1", { id: "t1", fingerprint: "old" });
  h.state.reply = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { github: { threads: [{ id: "t1", fingerprint: "new" }] } } }) });
  h.mod.refreshGithub(h.cx, true); await h.drain();
  assert.equal(h.requests.at(-1).force, true);
  assert.equal(h.mod.threadQueue.size, 0);
  assert.equal(h.requests.filter(r => r.op === "send").length, 0);
});

test("large file lists build only visible rows and select by stable path", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.data.snapshot.files = Array.from({ length: 5000 }, (_, i) => ({
    path: `src/file-${i}.rs`, status: "M", rows: [], loaded: false,
  }));
  let built = 0;
  const fileRow = h.mod.fileRow.bind(h.mod);
  h.mod.fileRow = (...args) => { built++; return fileRow(...args); };
  h.mod.render(h.cx);
  assert.equal(built, 0, "offscreen file rows must not be built in render()");
  assert.equal(h.state.virtual.count, 5000);
  assert.equal(h.state.virtual.key(4999), "src/file-4999.rs");
  const start = h.nodes.length;
  h.state.virtual.render({ start: 4990, end: 5000 });
  assert.equal(built, 10);
  assert.ok(h.nodes.slice(start).every(n => !n.events.on_click), "deferred native rows cannot register handlers");
  h.nodes.find(n => n.id === "review-files-list").events.on_item_click("src/file-4999.rs", h.cx);
  await h.drain();
  assert.equal(h.requests.at(-1).view.file, "src/file-4999.rs");
});

test("Open full review pins checkout, comparison, file and exact source chat", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.data.snapshot.scope.comparison = { mode: "branch", base: "origin/main" };
  h.mod.openFull(h.cx); await h.drain();
  const command = h.state.commands[0];
  assert.equal(command.name, "tab.new");
  assert.equal(command.args.mod, "annotator");
  assert.equal(command.args.props.presentation, "full");
  assert.equal(command.args.props.source_target, "t7");
  assert.equal(command.args.props.tab, "tab1");
  assert.equal(command.args.props.file, "a.rs");
  assert.equal(command.args.props.scope.comparison.base, "origin/main");
  h.mod.editor.set_value("draft"); h.mod.openFull(h.cx);
  assert.equal(h.state.commands.filter(c => c.name === "tab.new").length, 1);
  assert.equal(h.state.commands.at(-1).name, "pane.focus");
  assert.equal(h.state.shared["annotator.fullTabs"]["review-tab"].sourceTab, "tab1");
});

test("full review keeps its original chat and never redirects when it closes", async () => {
  const h = harness();
  h.state.props = { presentation: "full", source_target: "t7", tab: "tab1" };
  h.mod.init({}, h.cx); await h.drain();
  h.state.agents.push({ address: "t8", pane: "p8", space: "space1", tab: "tab1", status: "idle" });
  h.state.focus = { terminal: "t8", pane: "p8" };
  assert.equal(h.mod.currentSession().address, "t7");
  h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.id === "annotator-full"));
  assert.ok(h.nodes.some(n => n.id === "full-split"));
  h.state.agents = h.state.agents.filter(a => a.address !== "t7");
  assert.equal(h.mod.currentSession(), null);
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "send").length, 0);
});

test("full diff rows are deferred; split selection keeps old and new sides", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain();
  h.mod.data.comments = [];
  h.mod.data.snapshot.files[0].rows = [
    { kind: "delete", old: 5, new: null, text: "before" },
    { kind: "add", old: null, new: 8, text: "after" },
  ];
  h.mod.render(h.cx);
  assert.equal(h.state.diffList.count, 3);
  const start = h.nodes.length;
  h.state.diffList.render(1);
  assert.ok(h.nodes.slice(start).every(n => Object.keys(n.events).length === 0));
  const frame = h.nodes.filter(n => n.id === "full-diff-frame").at(-1);
  frame.events.on_mouse_down({ bounds: { width: 1000 }, local_position: { x: 20 }, modifiers: {} });
  h.nodes.filter(n => n.id === h.state.diffList.id).at(-1).events.on_item_click("row-0", h.cx);
  assert.equal(h.mod.selection.side, "old"); assert.equal(h.mod.selection.start, 5);
  frame.events.on_mouse_down({ bounds: { width: 1000 }, local_position: { x: 750 }, modifiers: {} });
  h.nodes.filter(n => n.id === h.state.diffList.id).at(-1).events.on_item_click("row-0", h.cx);
  assert.equal(h.mod.selection.side, "new"); assert.equal(h.mod.selection.start, 8);
});

test("saving an inline comment keeps the native list item count and reading position", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain(); h.mod.data.comments = [];
  const rows = Array.from({ length: 200 }, (_, i) => ({ kind: "context", old: i + 1, new: i + 1, text: `line ${i + 1}` }));
  h.mod.data.snapshot.files[0].rows = rows; h.mod.render(h.cx);
  h.state.diffList.scroll = { index: 110, offset: 7 };
  const count = h.state.diffList.count;
  h.mod.selectLine(rows[120], {}, h.cx); h.mod.editor.set_value("Check this line");
  h.state.reply = async request => {
    const data = h.snapshot(); data.snapshot.files[0].rows = rows;
    data.comments = [{ ...data.comments[0], body: request.body, position: { side: "new", start: 121, end: 121 } }];
    return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  h.mod.saveComment(h.cx); await h.drain(); h.mod.render(h.cx);
  assert.equal(h.state.diffList.count, count, "saved notes must not splice the native source list");
  assert.deepEqual(h.state.diffList.scroll, { index: 110, offset: 7 });
});

test("multiple notes on one line keep separate edit and delete actions", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain();
  h.mod.data.comments.push({ ...h.mod.data.comments[0], id: "note2", body: "Second note" });
  h.mod.render(h.cx);
  h.nodes.filter(n => n.id === h.state.diffList.id).at(-1).events.on_item_click("notes-row-0", h.cx);
  assert.equal(h.mod.editDraft, undefined, "do not guess which of several notes was clicked");
  const start = h.nodes.length; h.mod.render(h.cx);
  assert.ok(h.nodes.slice(start).some(n => n.id === "edit-note1"));
  assert.ok(h.nodes.slice(start).some(n => n.id === "edit-note2"));
  h.nodes.slice(start).find(n => n.id === "edit-note2").events.on_click(null, h.cx);
  assert.equal(h.mod.editDraft.id, "note2");
});

test("read toggles omit revision and unread filtering never changes send eligibility", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  h.nodes.find(n => n.id === "read-note1").events.on_click(null, h.cx); await h.drain();
  assert.equal(h.requests.at(-1).op, "read"); assert.equal(h.requests.at(-1).read, true);
  assert.equal("revision" in h.requests.at(-1), false);
  const items = [{ id: "a", read: false }, { id: "b", read: true }];
  assert.deepEqual(review.unreadItems(items, true), [items[0]]);
  assert.equal(review.pendingComments([{ read: true, resolved: false, stale: false }]).length, 1);
});

test("split rows pair unequal changes and never cross hunks", () => {
  const rows = [
    { kind: "delete", old: 1, new: null, text: "a" },
    { kind: "delete", old: 2, new: null, text: "b" },
    { kind: "add", old: null, new: 1, text: "c" },
    { kind: "hunk", text: "@@", old: null, new: null },
    { kind: "context", old: 20, new: 19, text: "same" },
  ];
  const split = review.splitRows(rows);
  assert.equal(split.length, 4);
  assert.equal(split[1].new, null);
  assert.equal(review.splitSelectionRow(split[1], "new"), null);
  assert.equal(review.splitSelectionRow(split[3], "old").new, null);
  assert.equal(review.splitSelectionRow(split[3], "new").old, null);
});

test("compact sidebar keeps comparison in the Files row with on-demand options", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.id === "files-scope-row"));
  assert.ok(!h.nodes.some(n => n.id === "scope-options"));
  assert.ok(!h.nodes.some(n => n.children.includes("Working tree")));
  h.nodes.find(n => n.id === "scope-menu").events.on_click(null, h.cx);
  h.mod.render(h.cx);
  h.nodes.filter(n => n.id === "scope-branch").at(-1).events.on_click(null, h.cx);
  await h.drain();
  assert.equal(h.requests.at(-1).scope.comparison.mode, "branch");
  assert.equal(h.mod.scopeMenuOpen, false);
});

test("full reader defaults to two columns with inline notes and an on-demand composer", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  assert.equal(h.state.panelCalls, 2);
  assert.equal(h.mod.commentsOpen, false);
  assert.ok(!h.nodes.some(n => n.id === "full-composer"));
  assert.equal(h.state.diffList.count, 3, "one source row with fixed before/inline note slots");
  const start = h.nodes.length;
  h.state.diffList.render(2);
  assert.ok(h.nodes.slice(start).some(n => n.id === "full-inline-note1"));
  assert.ok(h.nodes.slice(start).every(n => Object.keys(n.events).length === 0));
  assert.ok(!h.nodes.slice(start).some(n => n.children.includes("Click to mark read, resolve or reopen")));
  h.nodes.filter(n => n.id === h.state.diffList.id).at(-1).events.on_item_click("notes-row-0", h.cx);
  h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.id === "full-comment-actions"));
  assert.equal(h.mod.editDraft, undefined, "clicking readonly text must not force editing");
  h.nodes.filter(n => n.id === "edit-note1").at(-1).events.on_click(null, h.cx);
  h.mod.render(h.cx);
  assert.equal(h.mod.editDraft.id, "note1");
  h.nodes.filter(n => n.id === "cancel-edit-note1").at(-1).events.on_click(null, h.cx);
  h.mod.render(h.cx);
  h.nodes.filter(n => n.id === "full-new-file-comment").at(-1).events.on_click(null, h.cx);
  h.mod.render(h.cx);
  assert.ok(h.nodes.some(n => n.id === "full-composer"));
  h.nodes.filter(n => n.id === "full-toggle-comments").at(-1).events.on_click(null, h.cx);
  const before = h.state.panelCalls; h.mod.render(h.cx);
  assert.equal(h.state.panelCalls - before, 3);
  assert.equal(h.state.shared["annotator.fullComments"], true);
});

test("inline note placement respects diff sides, hidden context and file notes", () => {
  const rows = [{ kind: "delete", old: 5, new: null }, { kind: "add", old: null, new: 5 }];
  const comments = [
    { id: "file", position: null, stale: false },
    { id: "old", position: { side: "old", end: 5 } },
    { id: "new", position: { side: "new", end: 5 } },
    { id: "hidden", position: { side: "new", end: 100 } },
    { id: "stale", stale: true },
  ];
  assert.deepEqual(review.diffEntries(rows, comments, false).map(e => e.key),
    ["note-file", "row-0", "note-old", "row-1", "note-new", "note-hidden", "note-stale"]);
  assert.equal(review.diffEntries(review.splitRows(rows), comments, true).filter(e => e.comment).length, 5);
});

test("full review hides Changes on entry and restores it only on the source tab", () => {
  const panel = { id: "panel", stack: "panel-body", active: "changes", hidden: false, changes: true };
  const reviews = { review: { space: "space", sourceTab: "source", sourcePanel: panel } };
  const enter = review.reviewSidebarTransition(null, { tab: "review", space: "space" }, reviews, panel);
  assert.deepEqual(enter.actions, [{ name: "layout.hide", args: { id: "panel" } }]);
  assert.equal(review.reviewSidebarTransition(enter.state, { tab: "review", space: "space" }, reviews, panel), null,
    "manual reopening in the same review must not be immediately hidden again");
  const other = review.reviewSidebarTransition(enter.state, { tab: "other", space: "elsewhere" }, reviews, { ...panel, hidden: true });
  assert.deepEqual(other.actions, []);
  const source = review.reviewSidebarTransition(other.state, { tab: "source", space: "space" }, reviews, { ...panel, hidden: true });
  assert.deepEqual(source.actions.map(a => a.name), ["layout.select", "layout.show"]);
  const files = review.reviewSidebarTransition(enter.state, { tab: "source", space: "space" }, reviews, { ...panel, active: "files", changes: false });
  assert.deepEqual(files.actions, [], "do not replace a Files panel opened manually");
  const originallyHidden = { review: { ...reviews.review, sourcePanel: { ...panel, hidden: true } } };
  const hidden = review.reviewSidebarTransition(null, { tab: "review", space: "space" }, originallyHidden, { ...panel, hidden: true });
  assert.deepEqual(hidden.state.pending, {});
  const beforeRegistration = review.reviewSidebarTransition(null, { tab: "review", space: "space" }, {}, panel);
  assert.deepEqual(beforeRegistration.actions, []);
  const registered = review.reviewSidebarTransition(beforeRegistration.state, { tab: "review", space: "space" }, reviews, panel);
  assert.equal(registered.actions[0].name, "layout.hide", "registration may arrive after Herdr has already selected the new tab");
});

test("full review defaults to Branch and restores global preferences in a fresh tab", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain();
  assert.equal(h.requests[0].scope.comparison.mode, "branch");
  h.mod.changeComparison("branch", "origin/custom-base", h.cx); await h.drain();
  h.mod.render(h.cx);
  for (const id of ["full-unified", "full-toggle-files", "full-toggle-comments", "full-unread"]) {
    h.nodes.filter(n => n.id === id).at(-1).events.on_click(null, h.cx);
  }
  h.mod.expandContext(23, h.cx); await h.drain();
  const next = harness();
  next.state.shared = JSON.parse(JSON.stringify(h.state.shared));
  next.state.props = { presentation: "full" };
  next.state.scope = { repo: "/another-checkout", machine: null };
  next.mod.init({}, next.cx); await next.drain();
  assert.equal(next.requests[0].scope.comparison.mode, "branch");
  assert.equal(next.requests[0].scope.comparison.base, null, "base refs must not leak to another checkout");
  assert.equal(next.requests[0].view.context, 23);
  assert.equal(next.mod.diffStyle, "unified");
  assert.equal(next.mod.filesOpen, false);
  assert.equal(next.mod.commentsOpen, true);
  assert.equal(next.mod.onlyUnread, true);
  const same = harness(); same.state.shared = JSON.parse(JSON.stringify(h.state.shared));
  same.state.props = { presentation: "full" };
  same.mod.init({}, same.cx); await same.drain();
  assert.equal(same.requests[0].scope.comparison.base, "origin/custom-base");
  next.mod.changeComparison("uncommitted", null, next.cx); await next.drain();
  const later = harness(); later.state.shared = JSON.parse(JSON.stringify(next.state.shared));
  later.state.props = { presentation: "full" };
  later.mod.init({}, later.cx); await later.drain();
  assert.equal(later.requests[0].scope.comparison.mode, "uncommitted");
});

test("malformed saved preferences use safe defaults", () => {
  const prefs = review.fullPreferences({ mode: "bad", contextLines: -2, filesOpen: "yes", diffStyle: "bad" });
  assert.equal(prefs.mode, "branch"); assert.equal(prefs.contextLines, 3);
  assert.equal(prefs.filesOpen, true); assert.equal(prefs.diffStyle, "split");
});

test("syntax toggles persist and colored rows keep the deferred renderer handler-free", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain();
  const file = h.mod.data.snapshot.files[0];
  file.rows[0].text = 'const value = "hello";';
  h.mod.syntaxCache = null; h.mod.prepareSyntax(h.mod.data.snapshot);
  h.mod.render(h.cx);
  const start = h.nodes.length;
  h.state.diffList.render(1);
  assert.ok(h.nodes.slice(start).every(n => Object.keys(n.events).length === 0));
  assert.equal(h.mod.syntax, true);
  h.nodes.filter(n => n.id === "full-syntax").at(-1).events.on_click(null, h.cx);
  assert.equal(h.mod.syntax, false); assert.equal(h.mod.syntaxCache, null);
  const next = harness(); next.state.shared = JSON.parse(JSON.stringify(h.state.shared));
  next.state.props = { presentation: "full" };
  next.mod.init({}, next.cx); await next.drain();
  assert.equal(next.mod.syntax, false);
});

for (const full of [false, true]) test(`${full ? "full review" : "sidebar"} shows a neutral empty state outside Git and recovers on Refresh`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.state.reply = async () => ({ code: 1, stdout: JSON.stringify({ ok: false,
    error: "Git command failed (128): fatal: not a git repository (or any of the parent directories): .git" }) });
  h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  assert.equal(h.mod.error, null);
  assert.ok(h.nodes.some(n => n.id === "review-empty-checkout"));
  assert.ok(!h.nodes.some(n => n.id === "review-error" || n.id === "send-review" || n.id === "full-send"));
  assert.equal(h.requests.filter(r => r.op === "github").length, 0);
  h.mod.saveComment(h.cx); h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.requests.length, 1);
  h.state.reply = null;
  h.nodes.find(n => n.id === "empty-refresh").events.on_click(null, h.cx); await h.drain();
  assert.equal(h.mod.snapshotError, null); assert.ok(h.mod.data.snapshot);
});

test("no selected folder shows an empty state without calling Git", async () => {
  const h = harness(); h.state.scope.repo = "";
  h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  assert.equal(h.mod.error, null); assert.equal(h.requests.length, 0);
  assert.ok(h.nodes.some(n => n.id === "review-empty-checkout"));
});

test("a checkout losing Git hides stale actions and preserves drafts through recovery", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const cached = h.mod.data;
  h.mod.editor.set_value("keep original intent");
  h.mod.draft.anchor({ side: "new", start: 2, end: 2 }, "r1");
  h.mod.snapshotFailed("fatal: not a git repository (or any of the parent directories): .git", h.state.scope);
  const start = h.nodes.length; h.mod.render(h.cx);
  assert.ok(h.nodes.slice(start).some(n => n.id === "review-empty-checkout"));
  assert.ok(!h.nodes.slice(start).some(n => n.id === "diff-0" || n.id === "save-note"));
  const count = h.requests.length;
  h.mod.act("resolve", { id: "note1", resolved: true }, h.cx);
  h.mod.sendToSession(h.cx); await h.drain(); assert.equal(h.requests.length, count);
  assert.equal(h.mod.data, cached); assert.equal(h.mod.editor.value(), "keep original intent");
  h.state.revision = "r2"; h.mod.refresh(h.cx, true); await h.drain();
  assert.equal(h.mod.editor.value(), "keep original intent");
  assert.equal(h.mod.needsSelection, true); assert.equal(h.mod.snapshotError, null);
});

test("unreachable machines show a connection state, not an empty checkout", async () => {
  const h = harness(); h.state.scope.machine = "manjaro";
  const error = 'Command failed (5): {"error":{"kind":"unavailable","message":"manjaro is unreachable: cannot reach manjaro: ssh: connect to host 192.0.2.10 port 22: Operation timed out","hint":"hc machine ls shows when it comes back"}}';
  h.state.reply = async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error }) });
  h.mod.init({}, h.cx); await h.drain(); h.mod.render(h.cx);
  assert.equal(h.mod.snapshotError.kind, "offline");
  const text = h.nodes.flatMap(n => n.children).filter(v => typeof v === "string");
  assert.ok(text.includes("manjaro is unavailable"));
  assert.ok(!text.includes("Select a Git checkout"));
  assert.ok(text.some(v => v.includes("Files · —")));
  assert.ok(!text.some(v => v.includes('"kind":"unavailable"')));
});

test("failed refresh preserves cached rows but blocks review actions until recovery", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const cached = h.mod.data;
  h.state.reply = async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: "Connection timed out" }) });
  h.mod.refresh(h.cx); await h.drain();
  assert.equal(h.mod.data, cached);
  const count = h.requests.length;
  h.mod.sendToSession(h.cx);
  h.mod.act("resolve", { id: "note1", resolved: true }, h.cx);
  await h.drain(); assert.equal(h.requests.length, count);
  h.mod.render(h.cx);
  assert.ok(!h.nodes.filter(n => n.id === "send-review").at(-1).events.on_click);
  h.state.reply = null;
  h.mod.refresh(h.cx, true); await h.drain();
  assert.equal(h.mod.snapshotError, null);
  h.mod.render(h.cx);
  assert.ok(h.nodes.filter(n => n.id === "send-review").at(-1).events.on_click);
});

test("known offline machines skip automatic Git calls but Retry still probes", async () => {
  const h = harness(); h.state.scope.machine = "manjaro";
  h.state.machines = [{ name: "manjaro", layout: "unavailable" }];
  h.mod.init({}, h.cx); await h.drain();
  assert.equal(h.requests.length, 0);
  assert.equal(h.mod.snapshotError.kind, "offline");
  h.mod.refresh(h.cx, true); await h.drain();
  assert.equal(h.requests[0].op, "snapshot");
});

test("retry after disconnection preserves drafts and requires reselection on changed code", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.editor.set_value("keep this draft");
  h.mod.snapshotFailed("Connection timed out", h.state.scope);
  h.state.revision = "changed-while-offline";
  h.mod.refresh(h.cx, true); await h.drain();
  assert.equal(h.mod.editor.value(), "keep this draft");
  assert.equal(h.mod.needsSelection, true);
  assert.equal(h.mod.snapshotError, null);
});

test("confirmed Send focuses only the exact recipient; failed Send never changes focus", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.state.commands.at(-1)?.name, "pane.focus");
  assert.equal(h.state.commands.at(-1)?.args.terminal, "t7");
  h.state.commands = [];
  h.state.reply = async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: "Delivery not confirmed" }) });
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.state.commands.length, 0);
});

test("Cmd/Ctrl Enter saves one draft without sending; plain Enter stays multiline", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.editor.set_value("save by shortcut"); h.mod.editor.focus();
  h.mod.handleKey({ key: "enter", keystroke: "enter", modifiers: {} }, h.cx);
  await h.drain(); assert.equal(h.requests.filter(r => r.op === "add").length, 0);
  h.mod.handleKey({ key: "enter", keystroke: "cmd-enter", modifiers: { platform: true } }, h.cx);
  h.mod.editor.emit("submit", { secondary: true });
  await h.drain();
  assert.equal(h.requests.filter(r => r.op === "add").length, 1);
  assert.equal(h.requests.filter(r => r.op === "send").length, 0);
  assert.equal(h.mod.editor.value(), "");
  h.mod.editor.set_value("offline draft"); h.mod.snapshotFailed("Connection timed out", h.state.scope);
  h.mod.editor.emit("submit", { secondary: true }); await h.drain();
  assert.equal(h.requests.filter(r => r.op === "add").length, 1);
  assert.equal(h.mod.editor.value(), "offline draft");
});

test("legacy origin/develop becomes Auto; explicit remote choices remain pinned", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  const key = JSON.stringify([null, "/checkout"]);
  h.state.shared["annotator.baseRefs"] = { [key]: "origin/develop" };
  h.state.reply = async request => {
    const data = h.snapshot();
    if (request.op === "snapshot") data.snapshot.scope.comparison = { mode: "branch", base: request.scope.comparison.base ?? "develop" };
    return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  h.mod.init({}, h.cx); await h.drain();
  assert.equal(h.requests[0].scope.comparison.base, null);
  assert.equal(h.mod.base, "develop"); assert.equal(h.mod.baseExplicit, false);
  assert.equal(h.state.shared["annotator.baseRefs"][key].explicit, false);
  h.mod.changeComparison("branch", "origin/develop", h.cx, true); await h.drain();
  assert.equal(h.requests.at(-1).scope.comparison.base, "origin/develop");
  const next = harness(); next.state.props = { presentation: "full" };
  next.state.shared = JSON.parse(JSON.stringify(h.state.shared));
  next.mod.init({}, next.cx); await next.drain();
  assert.equal(next.requests[0].scope.comparison.base, "origin/develop");
  next.mod.changeComparison("branch", null, next.cx, false); await next.drain();
  assert.equal(next.requests.at(-1).scope.comparison.base, null);
  assert.equal(next.state.shared["annotator.baseRefs"][key].explicit, false);
});

test("save shortcut requires composer focus; confirmed Send never redirects to a replacement chat", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.editor.set_value("draft");
  h.mod.handleKey({ key: "enter", keystroke: "ctrl-enter", modifiers: { control: true } }, h.cx);
  await h.drain(); assert.equal(h.requests.filter(r => r.op === "add").length, 0);
  h.mod.editor.focus();
  h.mod.handleKey({ key: "enter", keystroke: "ctrl-enter", modifiers: { control: true } }, h.cx);
  h.mod.editor.emit("submit", { secondary: true });
  await h.drain(); assert.equal(h.requests.filter(r => r.op === "add").length, 1);
  h.state.reply = async () => {
    h.state.agents = [{ address: "t8", pane: "p8", space: "space1", tab: "tab1", status: "idle" }];
    return { code: 0, stdout: JSON.stringify({ ok: true, data: h.snapshot() }) };
  };
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.state.commands.length, 0);
});

for (const full of [false, true]) test(`${full ? "full" : "sidebar"} logical order uses one request and preserves draft, open file and source chat`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  const snapshot = h.mod.data.snapshot;
  snapshot.view = { file: "a.rs", context: 3 };
  snapshot.files.push({ path: "b.rs", status: "M", rows: [], loaded: false });
  h.mod.open = "a.rs"; h.mod.editor.set_value("Keep my draft");
  h.mod.selection = { side: "new", start: 2, end: 2, origin: 2 };
  const selection = h.mod.selection;
  h.state.reply = async request => ({ code: 0, stdout: JSON.stringify({ ok: true,
    data: { files: ["b.rs", "a.rs"], revision: request.revision } }) });
  h.mod.render(h.cx);
  assert.equal(h.requests.filter(r => r.op === "order").length, 0);
  h.mod.orderLogically(h.cx); h.mod.orderLogically(h.cx);
  await h.drain();
  assert.equal(h.requests.filter(r => r.op === "order").length, 1);
  assert.equal(h.requests.find(r => r.op === "order").target, "t7");
  assert.equal(h.requests.find(r => r.op === "order").model, null);
  assert.equal(h.requests.some(r => r.op === "send" || r.op === "ask"), false);
  assert.equal(h.mod.orderedFiles().map(f => f.path).join(","), "b.rs,a.rs");
  assert.equal(snapshot.files.map(f => f.path).join(","), "a.rs,b.rs");
  assert.equal(h.mod.editor.value(), "Keep my draft");
  assert.equal(h.mod.open, "a.rs"); assert.equal(h.mod.selection, selection);
  assert.equal(h.state.commands.length, 0);
  h.nodes.length = 0; h.mod.render(h.cx);
  assert.equal(h.state.virtual.key(0), "b.rs");
  if (full) {
    h.nodes.find(node => node.id === "full-prev-file").events.on_click({}, h.cx);
    assert.equal(h.mod.open, "b.rs");
  }
  h.mod.resetOrder(h.cx);
  assert.equal(h.mod.orderedFiles().map(f => f.path).join(","), "a.rs,b.rs");
});

for (const full of [false, true]) test(`${full ? "full" : "sidebar"} ordering model picker overrides only the one-shot request and can return to source auto`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  h.mod.data.snapshot.files.push({ path: "b.rs", status: "M", rows: [] });
  const model = { providerID: "fixture", id: "review-model" };
  h.state.reply = async request => ({ code: 0, stdout: JSON.stringify({ ok: true, data: request.op === "order_models"
    ? { source: { providerID: "fixture", id: "chat-model", variant: "medium" }, models: [{ name: "Review model", model }] }
    : { files: ["b.rs", "a.rs"], revision: request.revision } }) });
  h.mod.render(h.cx);
  h.nodes.find(node => node.id === (full ? "full-order-logically-model" : "order-logically-model")).events.on_click({}, h.cx);
  await h.drain(); h.nodes.length = 0; h.mod.render(h.cx);
  assert.equal(h.requests.at(-1).op, "order_models");
  assert.equal(h.requests.at(-1).target, "t7");
  assert.equal(h.requests.some(request => request.op === "order"), false);
  h.nodes.find(node => node.id === "order-model-choice-0").events.on_click({}, h.cx);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.shared["annotator.orderModel"])), model);
  assert.equal(h.mod.orderModelOpen, false);
  h.mod.orderLogically(h.cx); await h.drain();
  assert.deepEqual(h.requests.at(-1).model, model);
  h.mod.openOrderModels(h.cx); await h.drain(); h.nodes.length = 0; h.mod.render(h.cx);
  h.nodes.find(node => node.id === "order-model-auto").events.on_click({}, h.cx);
  assert.equal(h.state.shared["annotator.orderModel"], null);
  assert.equal(h.requests.some(request => ["send", "ask"].includes(request.op)), false);
  assert.equal(h.state.commands.length, 0);
});

test("late and malformed logical orders never change the displayed files", async () => {
  for (const kind of ["revision", "checkout", "malformed", "closed"]) {
    const h = harness(); h.mod.init({}, h.cx); await h.drain();
    h.mod.data.snapshot.files.push({ path: "b.rs", status: "M", rows: [] });
    let finish;
    h.state.reply = () => new Promise(resolve => { finish = resolve; });
    h.mod.orderLogically(h.cx); await Promise.resolve(); await Promise.resolve();
    assert.ok(finish);
    if (kind === "revision") h.mod.data.snapshot.revision = "changed";
    if (kind === "checkout") h.state.scope = { repo: "/other", machine: null };
    if (kind === "closed") h.mod.close();
    finish({ code: 0, stdout: JSON.stringify({ ok: true, data: {
      revision: "r1", files: kind === "malformed" ? ["a.rs", "a.rs"] : ["b.rs", "a.rs"] } }) });
    await h.drain();
    assert.equal(h.mod.orderedFiles().map(f => f.path).join(","), "a.rs,b.rs", kind);
    assert.equal(h.mod.ordering, null);
    assert.equal(h.state.shared["annotator.fileOrders"], undefined);
  }
});

test("logical order survives preview navigation but invalidates an observed changed preview", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  const snapshot = h.mod.data.snapshot;
  snapshot.view = { file: "a.rs", context: 3 };
  snapshot.files.push({ path: "b.rs", status: "M", rows: [] });
  h.state.reply = async request => ({ code: 0, stdout: JSON.stringify({ ok: true,
    data: { files: ["b.rs", "a.rs"], revision: request.revision } }) });
  h.mod.orderLogically(h.cx); await h.drain();
  snapshot.view = { file: "b.rs", context: 3 }; snapshot.revision = "b-preview";
  h.mod.observeOrder(snapshot);
  assert.equal(h.mod.orderedFiles()[0].path, "b.rs");
  snapshot.revision = "b-changed"; h.mod.observeOrder(snapshot);
  assert.equal(h.mod.orderedFiles()[0].path, "a.rs");
});

for (const full of [false, true]) test(`${full ? "full" : "sidebar"} runner switch selects Pi without launching it`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  h.mod.data.snapshot.files.push({ path: "b.rs", status: "M", rows: [] });
  h.mod.render(h.cx);
  const id = full ? "full-order-logically-runner" : "order-logically-runner";
  assert.equal(h.mod.orderRunner(), "opencode");
  h.nodes.find(node => node.id === id).events.on_click({}, h.cx);
  assert.equal(h.mod.orderRunner(), "pi");
  assert.equal(h.requests.some(request => request.op === "order"), false);
  h.state.reply = async request => ({ code: 0, stdout: JSON.stringify({ ok: true,
    data: { files: ["b.rs", "a.rs"], revision: request.revision } }) });
  h.mod.orderLogically(h.cx); await h.drain();
  assert.equal(h.requests.filter(request => request.op === "order").length, 1);
  assert.equal(h.requests.at(-1).runner, "pi");
  assert.equal(h.mod.orderedFiles()[0].path, "b.rs");
  assert.equal(h.state.commands.length, 0);
  const next = harness(); next.state.shared = h.state.shared;
  assert.equal(next.mod.orderRunner(), "pi");
});

test("switching checkout does not wait for an obsolete snapshot or let it clear the new read", async () => {
  const h = harness(), reads = [];
  const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  h.state.reply = request => request.op === "snapshot" ? new Promise(resolve => reads.push({ request, resolve }))
    : { code: 0, stdout: JSON.stringify({ ok: true, data: h.snapshot() }) };
  h.mod.init({}, h.cx); await settle();
  assert.equal(reads.length, 1);
  h.state.scope = { repo: "/new-checkout", machine: null };
  h.mod.render(h.cx); await settle();
  assert.equal(reads.length, 2, "new checkout read should start without waiting for the old one");
  reads[0].resolve({ code: 0, stdout: JSON.stringify({ ok: true, data: h.snapshot() }) });
  await settle();
  assert.equal(h.mod.busy, true, "obsolete completion must not release the new read's busy guard");
  const data = h.snapshot(); data.snapshot.scope = { repo: "/new-checkout", machine: null };
  reads[1].resolve({ code: 0, stdout: JSON.stringify({ ok: true, data }) });
  await h.drain();
  assert.equal(h.mod.data.snapshot.scope.repo, "/new-checkout");
  assert.equal(h.mod.busy, false);
});

test("copy branch preserves its exact name and branch headers are selectable", async () => {
  for (const full of [false, true]) {
    const h = harness(); h.state.props = full ? { presentation: "full" } : {};
    h.mod.init({}, h.cx); await h.drain();
    h.mod.data.snapshot.branch = "16611-g-deposits-refund-payment-description";
    h.mod.render(h.cx); h.mod.copyMenu(h.mod.data.snapshot.files[0]);
    h.nodes.find(node => node.id === "copy-branch").events.on_click({}, h.cx);
    assert.equal(h.state.clipboard, "16611-g-deposits-refund-payment-description");
    assert.equal(h.nodes.find(node => node.id === (full ? "full-branch-name" : "review-branch-name")).selectable, true);
  }
});

test("full review checkout and file paths support native selection and exact copying", async () => {
  const h = harness(); h.state.props = { presentation: "full" };
  h.mod.init({}, h.cx); await h.drain();
  h.mod.data.snapshot.scope.repo = "/home/jakub/worktrees/16611-refund";
  h.mod.render(h.cx); h.mod.copyMenu(h.mod.data.snapshot.files[0]);
  for (const id of ["full-checkout-path", "full-file-path"]) {
    assert.equal(h.nodes.find(node => node.id === id).selectable, true, id);
  }
  assert.equal(h.state.textViews.find(view => view.id === "full-checkout-path").html, "/home/jakub/worktrees/16611-refund");
  h.nodes.find(node => node.id === "copy-checkout").events.on_click({}, h.cx);
  assert.equal(h.state.clipboard, "/home/jakub/worktrees/16611-refund");
});

test("sidebar full-review button focuses its existing live review without replacing drafts", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.openFull(h.cx); await h.drain();
  h.state.reviewTabs = [{ id: "review-tab" }];
  h.state.reviewPanes = [{ tab: "review-tab", pane: "review-pane", mod: "annotator" }];
  h.mod.editor.set_value("Keep my source draft");
  h.mod.openFull(h.cx); await h.drain();
  assert.equal(h.state.commands.filter(command => command.name === "tab.new").length, 1);
  assert.equal(h.state.commands.at(-1).name, "pane.focus");
  assert.equal(h.state.commands.at(-1).args.pane, "review-pane");
  assert.equal(h.mod.editor.value(), "Keep my source draft");
});

for (const full of [false, true]) test(`${full ? "full" : "sidebar"} Cmd/Ctrl Enter sends the review only when no comment is unfinished`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  h.mod.editor.set_value("Save this comment first"); h.mod.editor.focus();
  const chord = { key: "enter", keystroke: "cmd-enter", modifiers: { platform: true } };
  h.mod.handleKey(chord, h.cx); h.mod.editor.emit("submit", { secondary: true });
  await h.drain();
  assert.equal(h.requests.filter(request => request.op === "add").length, 1);
  assert.equal(h.requests.filter(request => request.op === "send").length, 0);
  h.mod.handleKey(chord, h.cx); h.mod.editor.emit("submit", { secondary: true });
  await h.drain();
  assert.equal(h.requests.filter(request => request.op === "send").length, 1);
});

test("Cmd/Ctrl Enter sends outside an empty composer and includes general notes", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.reviewNote.editor.set_value("Overall direction");
  h.mod.handleKey({ key: "enter", keystroke: "ctrl-enter", modifiers: { control: true } }, h.cx);
  await h.drain();
  assert.equal(h.requests.at(-1).op, "send");
  assert.equal(h.requests.at(-1).note, "Overall direction");
  const noteOnly = harness(); noteOnly.mod.init({}, noteOnly.cx); await noteOnly.drain();
  noteOnly.mod.data.comments = []; noteOnly.mod.reviewNote.editor.set_value("Note-only review");
  noteOnly.mod.reviewNote.editor.emit("submit", { secondary: true }); await noteOnly.drain();
  assert.equal(noteOnly.requests.at(-1).op, "send");
  assert.equal(noteOnly.requests.at(-1).note, "Note-only review");
});

test("review shortcut respects unfinished editors, hidden drafts and delivery guards", async () => {
  for (const blocked of ["unfocused-comment", "hidden-comment", "edit", "question", "reply", "base", "blocked-agent", "missing-agent", "offline", "uncertain", "held", "shift", "alt", "plain"]) {
    const h = harness(); h.mod.init({}, h.cx); await h.drain();
    const chord = { key: "enter", keystroke: "cmd-enter", modifiers: { platform: true } };
    if (blocked === "unfocused-comment") h.mod.editor.set_value("Unfinished comment");
    if (blocked === "hidden-comment") h.mod.navigationDrafts.set(JSON.stringify([h.mod.comparisonKey(), "b.rs"]), { body: "Unfinished hidden comment" });
    if (blocked === "edit") h.mod.beginEdit(h.mod.data.comments[0], h.cx);
    if (blocked === "question") h.mod.beginQuestion({ kind: "file" }, h.cx);
    if (blocked === "reply") h.mod.githubDrafts.set(JSON.stringify([h.mod.context, "thread"]), { editor: { value: () => "Pending reply" } });
    if (blocked === "base") h.mod.baseOpen = true;
    if (blocked === "blocked-agent") h.state.agents[0].status = "blocked";
    if (blocked === "missing-agent") h.state.agents = [];
    if (blocked === "offline") h.mod.snapshotFailed("Connection timed out", h.state.scope);
    if (blocked === "uncertain") h.mod.reviewNote.uncertain = true;
    if (blocked === "held") chord.is_held = true;
    if (blocked === "shift") chord.modifiers.shift = true;
    if (blocked === "alt") chord.modifiers.alt = true;
    if (blocked === "plain") { chord.keystroke = "enter"; chord.modifiers = {}; }
    h.mod.handleKey(chord, h.cx); await h.drain();
    assert.equal(h.requests.some(request => request.op === "send"), false, blocked);
  }
});

test("saving a full-view comment keeps the empty native composer mounted for the second shortcut", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.full = true;
  h.mod.composerOpen = true;
  h.mod.editor.set_value("Save, do not send"); h.mod.editor.focus();
  h.mod.editor.emit("submit", { secondary: true }); await h.drain();
  assert.equal(h.requests.filter(request => request.op === "add").length, 1);
  assert.equal(h.requests.filter(request => request.op === "send").length, 0);
  assert.equal(h.mod.composerOpen, true);
  assert.equal(h.state.focusedInput, h.mod.editor, "the second shortcut must reach the same native textarea");
  assert.equal(h.mod.editorFocused, true);
  // Parent events must not duplicate the first textarea submit.
  h.mod.handleKey({ key: "enter", keystroke: "cmd-enter", modifiers: { platform: true } }, h.cx);
  await h.drain();
  assert.equal(h.requests.filter(request => request.op === "send").length, 0);
  h.mod.editor.emit("submit", { secondary: true });
  await h.drain();
  assert.equal(h.requests.filter(request => request.op === "send").length, 1);
});

test("native mod focus requests give the review pane a keyboard target", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain();
  h.mod.handleCommand("focus", h.cx);
  assert.equal(h.state.reviewFocused, true);
});

test("saving does not steal keyboard focus after switching to a different pane", async () => {
  const h = harness(); h.mod.init({}, h.cx); await h.drain(); h.mod.full = true;
  let finish;
  h.state.reply = () => new Promise(resolve => { finish = resolve; });
  h.mod.editor.set_value("Save this note"); h.mod.editor.focus();
  h.mod.editor.emit("submit", { secondary: true }); await Promise.resolve(); await Promise.resolve();
  h.state.focus = { ...h.state.focus, pane: "another-pane" };
  finish({ code: 0, stdout: JSON.stringify({ ok: true, data: h.snapshot() }) }); await h.drain();
  assert.notEqual(h.state.reviewFocused, true);
});

for (const full of [false, true]) test(`${full ? "full" : "sidebar"} allows review delivery to a working source`, async () => {
  const h = harness(); h.state.props = full ? { presentation: "full" } : {};
  h.mod.init({}, h.cx); await h.drain();
  h.state.agents[0].status = "working";
  h.mod.render(h.cx);
  const text = h.nodes.flatMap(node => node.children).filter(child => typeof child === "string");
  assert.equal(text.some(value => value.includes("Source session is still working")), false);
  assert.equal(typeof h.nodes.find(node => node.id === (full ? "full-send" : "send-review")).events.on_click, "function");
  h.mod.sendToSession(h.cx); await h.drain();
  assert.equal(h.requests.some(request => request.op === "send"), true);
  assert.equal(h.mod.data.comments[0].body, "Inline note");
});

test("keyboard review delivery accepts working but not blocked or unreported sources", async () => {
  for (const status of ["working", "blocked", null]) {
    const h = harness(); h.mod.init({}, h.cx); await h.drain();
    h.state.agents[0].status = status;
    h.mod.handleKey({ key: "enter", keystroke: "cmd-enter", modifiers: { platform: true } }, h.cx);
    await h.drain();
    assert.equal(h.requests.some(request => request.op === "send"), status === "working", String(status));
  }
});
