import test from "node:test";
import assert from "node:assert/strict";
import { selectionFor, selectionPayload, selected, inlineAt, pendingComments, sessionTarget, fileStats, pathParts, commentStatus, commentLocation, reviewSummary, sendHint, visibleComments, unreadItems, snapshotFailure, diffReaderEntries, splitRows } from "../mods/annotator/review.js";

test("ordinary folders are a distinct empty-checkout state, including remote diagnostics", () => {
  const diagnostic = "fatal: not a git repository (or any of the parent directories): .git";
  for (const error of [
    `Git command failed (128): ${diagnostic}`,
    `Command failed (128): ${diagnostic}`,
    `Git command failed (1): ${JSON.stringify({ error: { kind: "command_failed", message: diagnostic } })}`,
  ]) assert.equal(snapshotFailure(error, "manjaro").kind, "not-repository");
});

test("permission, corrupt-repository, and connectivity failures never masquerade as empty folders", () => {
  for (const error of [
    "fatal: detected dubious ownership in repository at '/checkout'",
    "fatal: unable to read tree: deadbeef",
    "fatal: cannot change to '/checkout': Permission denied",
    "fatal: bad object HEAD",
  ]) assert.equal(snapshotFailure(error).kind, "error");
  assert.equal(snapshotFailure("Connection timed out", "manjaro").kind, "offline");
});

test("resolved visibility composes with unread filtering without changing saved notes or eligibility", () => {
  const items = [
    { id: "open", resolved: false, read: false },
    { id: "closed", resolved: true, read: false },
    { id: "read", resolved: false, read: true },
    { id: "legacy" },
  ];
  assert.deepEqual(visibleComments(items).map(c => c.id), ["open", "read", "legacy"]);
  assert.deepEqual(unreadItems(visibleComments(items), true).map(c => c.id), ["open", "legacy"]);
  assert.equal(visibleComments(items, true), items);
  assert.equal(items.length, 4);
  assert.equal(pendingComments(items).some(c => c.id === "closed"), false);
});

test("line selection supports either side and Shift-click ranges", () => {
  const first = selectionFor(null, { old: 2, new: 3 });
  assert.deepEqual(selectionPayload(first), { side: "new", start: 3, end: 3 });
  const extended = selectionFor(first, { new: 7 }, true);
  assert.deepEqual(selectionPayload(extended), { side: "new", start: 3, end: 7 });
  assert.equal(selected({ new: 4 }, extended), true);
  assert.equal(selected({ old: 4 }, extended), false);
  assert.deepEqual(selectionPayload(selectionFor(extended, { old: 5 }, true)), { side: "old", start: 5, end: 5 });
  assert.equal(selectionFor(first, { kind: "hunk" }), first);
});

test("session routing follows the focused chat and survives composer focus", () => {
  const list = [
    { address: "t7", pane: "p7", space: "s", tab: "a", status: "idle" },
    { address: "t8", pane: "p8", space: "s", tab: "a", status: "working" },
    { address: "t9", pane: "p9", space: "s", tab: "b", status: "idle" },
  ];
  const ctx = { scope: { machine: null }, space: "s", tab: "a" };
  assert.equal(sessionTarget(list, ctx, { terminal: "t7" }).address, "t7");
  assert.equal(sessionTarget(list, ctx, {}, "t8").address, "t8");
  assert.equal(sessionTarget(list, ctx, {}), null); // No guessing between two chats.
  assert.equal(sessionTarget(list, ctx, { terminal: "t9" }), null); // No cross-tab send.
  assert.equal(sessionTarget(list, { ...ctx, tab: "b" }, {}).address, "t9");
});

test("same-numbered local and remote terminals are never interchangeable", () => {
  const list = [
    { address: "t7", space: "s", tab: "a" },
    { address: "server/t7", space: "s", tab: "a" },
  ];
  const ctx = { scope: { machine: "server" }, space: "s", tab: "a" };
  assert.equal(sessionTarget(list, ctx, { terminal: "t7" }).address, "server/t7");
  assert.equal(sessionTarget(list, { ...ctx, tab: "missing" }, {}), null);
});

test("comments attach to the correct diff side and only current notes export", () => {
  const note = { position: { side: "old", end: 3 }, stale: false, resolved: false, delivery: null };
  assert.equal(inlineAt(note, { old: 3, new: null }), true);
  assert.equal(inlineAt(note, { new: 3 }), false);
  assert.equal(inlineAt({ ...note, stale: true }, { old: 3 }), false);
  assert.equal(pendingComments([note, { ...note, resolved: true }, { ...note, delivery: "uncertain" }, { ...note, stale: true }]).length, 1);
});

test("confirmed sends hide with resolved history; uncertain and failed delivery stay visible", () => {
  const items = [
    { id: "ready", resolved: false, delivery: null },
    { id: "sent", resolved: false, delivery: "sent" },
    { id: "uncertain", resolved: false, delivery: "uncertain" },
    { id: "resolved", resolved: true, delivery: null },
  ];
  assert.deepEqual(visibleComments(items).map(c => c.id), ["ready", "uncertain"]);
  assert.equal(visibleComments(items, true), items);
  assert.deepEqual(pendingComments(items).map(c => c.id), ["ready"]);
  assert.equal(items[1].resolved, false, "hiding does not claim the feedback was fixed");
});

for (const split of [false, true]) test(`${split ? "split" : "unified"} reader keeps stable native slots across comment changes`, () => {
  const source = [{ kind: "delete", old: 2, new: null, text: "old" }, { kind: "add", old: null, new: 2, text: "new" }];
  const rows = split ? splitRows(source) : source;
  const comments = [
    { id: "file", position: null },
    { id: "old", position: { side: "old", start: 2, end: 2 } },
    { id: "new", position: { side: "new", start: 2, end: 2 } },
    { id: "same-line", position: { side: "new", start: 2, end: 2 } },
    { id: "stale", stale: true, position: null },
  ];
  const keys = items => diffReaderEntries(rows, items, split).map(entry => entry.key);
  assert.deepEqual(keys([]), keys(comments));
  assert.deepEqual(keys(comments), keys(comments.slice(1)), "deleting a note cannot splice the source list");
  const entries = diffReaderEntries(rows, comments, split);
  assert.deepEqual(entries.flatMap(entry => entry.comments ?? []).map(c => c.id), comments.map(c => c.id));
  assert.equal(entries.length, 2 * rows.length + 1);
});

test("presentation separates ready, outdated, sent and resolved comments", () => {
  const ready = { resolved: false, stale: false, delivery: null };
  const outdated = { ...ready, stale: true };
  const sent = { ...ready, delivery: "sent" };
  const resolved = { ...outdated, resolved: true };
  assert.deepEqual(reviewSummary([ready, outdated, sent, resolved]), { total: 4, ready: 1, outdated: 1, sent: 1 });
  assert.equal(commentStatus(ready).label, "Ready to send");
  assert.equal(commentStatus(outdated).label, "Outdated");
  assert.equal(commentStatus(sent).label, "Sent");
  assert.equal(commentStatus(resolved).label, "Resolved");
  assert.equal(commentStatus({ ...ready, delivery: "uncertain" }).label, "Check delivery");
  assert.match(sendHint([outdated], { status: "idle" }, false), /outdated.*excluded/);
  assert.match(sendHint([ready], { status: "working" }, false), /Send review while the source is working/);
  assert.match(sendHint([ready], { status: "blocked" }, false), /Answer its prompt/);
  assert.match(sendHint([ready], { status: "idle" }, true), /Save your draft/);
});

test("file statistics and comment locations make anchors legible", () => {
  assert.deepEqual(pathParts("src/jobs/test.rs"), { name: "test.rs", folder: "src/jobs" });
  assert.deepEqual(fileStats({ rows: [{ kind: "add" }, { kind: "delete" }, { kind: "context" }] }), { added: 1, removed: 1 });
  assert.equal(commentLocation({ position: { side: "new", start: 2, end: 4 } }), "L2–4");
  assert.equal(commentLocation({ stale: true, anchor: { lines: { selection: { side: "old", start: 3, end: 3 } } } }), "Was old L3");
  assert.equal(commentLocation({ position: null }), "File comment");
});

import { overviewSummary, jobMark } from "../mods/annotator/review.js";

test("MR overview summarizes approvals, missing approvers, and pipeline stages", () => {
  const view = overviewSummary({
    approvals: { approved: false, required: 2, left: 1, approved_by: ["alice"], missing: ["bob", "carol"] },
    pipeline: { id: 7, status: "failed", url: "u", stages: [
      { name: "build", status: "success", jobs: [{ name: "assemble", status: "success", url: "", allow_failure: false }] },
      { name: "test", status: "failed", jobs: [{ name: "lint", status: "failed", url: "", allow_failure: true },
        { name: "unit", status: "waiting_for_resource", url: "", allow_failure: false }] }] },
    errors: [],
  });
  assert.deepEqual(view.approvals, { headline: "Needs approval · 1/2", tone: "ansi3", approvedBy: ["alice"], missing: ["bob", "carol"] });
  assert.equal(view.pipeline.headline, "Pipeline #7 · failed");
  assert.deepEqual(view.pipeline.stages.map(s => [s.name, s.mark, s.tone]), [["build", "✓", "ansi2"], ["test", "✗", "ansi1"]]);
  assert.deepEqual(view.pipeline.stages[1].jobs.map(j => [j.status, j.allowFailure]), [["failed", true], ["pending", false]]);
});

test("an approved MR hides missing approvers and absent sections stay null", () => {
  const view = overviewSummary({ approvals: { approved: true, required: 0, left: 0, approved_by: [], missing: ["x"] }, pipeline: null, errors: ["Pipeline unavailable: 403"] });
  assert.equal(view.approvals.headline, "Approved · no approvals required");
  assert.deepEqual(view.approvals.missing, []);
  assert.equal(view.pipeline, null);
  assert.deepEqual(view.errors, ["Pipeline unavailable: 403"]);
  assert.equal(overviewSummary(null), null);
  assert.equal(jobMark("success_with_warnings").mark, "✓");
});
