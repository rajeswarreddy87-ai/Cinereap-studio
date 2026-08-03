import { test } from "node:test";
import assert from "node:assert/strict";

import {
  wordCount,
  splitScriptIntoBeats,
  computeBeatDurations,
  buildSyncedTimeline,
  planSyncedRender,
} from "./beats.js";

test("wordCount handles empty + normal", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("   "), 0);
  assert.equal(wordCount("one two three"), 3);
  assert.equal(wordCount("  spaced   out  words "), 3);
});

test("splitScriptIntoBeats preserves order and length", () => {
  const script = "A one. B two. C three. D four. E five. F six.";
  const beats = splitScriptIntoBeats(script, 3);
  assert.equal(beats.length, 3);
  // Order preserved: first bucket contains the first sentences.
  assert.ok(beats[0].startsWith("A one"));
  assert.ok(beats[2].includes("six"));
});

test("splitScriptIntoBeats pads when fewer sentences than beats", () => {
  const beats = splitScriptIntoBeats("Only one sentence here.", 4);
  assert.equal(beats.length, 4);
  assert.ok(beats[0].length > 0);
  assert.equal(beats[3], "");
});

test("computeBeatDurations sums to voiceover total (word-weighted)", () => {
  const texts = ["a a a a", "b b", "c"]; // 4,2,1 words => 7 total
  const total = 70;
  const durs = computeBeatDurations(texts, total, { minBeatSec: 1 });
  const sum = durs.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - total) < 0.01, `sum=${sum}`);
  // Most-spoken beat gets the most time.
  assert.ok(durs[0] > durs[1] && durs[1] > durs[2]);
});

test("computeBeatDurations respects min floor and still sums to total", () => {
  const texts = ["x".repeat(1), "many many many many many words here now today", "y"];
  const durs = computeBeatDurations(texts.map((t) => t), 30, { minBeatSec: 5 });
  const sum = durs.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 30) < 0.01, `sum=${sum}`);
  assert.ok(durs.every((d) => d >= 5 - 1e-9), `durs=${durs}`);
});

test("computeBeatDurations even split when no words", () => {
  const durs = computeBeatDurations(["", "", ""], 30);
  assert.deepEqual(durs.map((d) => Math.round(d)), [10, 10, 10]);
});

test("buildSyncedTimeline: own scene long enough -> single trimmed seg, no repeat", () => {
  const scenes = [
    { startSec: 0, endSec: 10 },
    { startSec: 100, endSec: 110 },
  ];
  const durs = [4, 4];
  const tl = buildSyncedTimeline(scenes, durs, { sourceDurationSec: 200 });
  // Beat 0 takes 0..4 from its own scene; beat 1 takes 100..104.
  assert.equal(tl.length, 2);
  assert.equal(tl[0].beatIndex, 0);
  assert.ok(Math.abs(tl[0].startSec - 0) < 1e-6);
  assert.ok(Math.abs(tl[0].endSec - 4) < 1e-6);
  assert.equal(tl[1].beatIndex, 1);
  assert.ok(Math.abs(tl[1].startSec - 100) < 1e-6);
});

test("buildSyncedTimeline: short own scene pulls NEXT scene footage forward", () => {
  const scenes = [
    { startSec: 0, endSec: 2 },     // beat 0 needs 5s but only has 2s
    { startSec: 50, endSec: 60 },   // surplus to pull from
  ];
  const durs = [5, 3];
  const tl = buildSyncedTimeline(scenes, durs, { sourceDurationSec: 100 });
  // Beat 0: 0..2 (own) then 50..53 (pulled forward) = 5s total across 2 segs.
  const beat0 = tl.filter((s) => s.beatIndex === 0);
  const beat0Dur = beat0.reduce((a, s) => a + (s.endSec - s.startSec), 0);
  assert.ok(Math.abs(beat0Dur - 5) < 0.05, `beat0Dur=${beat0Dur}`);
  // Every produced range is a real slice of a real scene window.
  for (const s of tl) {
    assert.ok(s.endSec > s.startSec, "empty range");
  }
});

test("buildSyncedTimeline: COVERAGE — visuals always reach the full voiceover length", () => {
  // 20 short windows (3s each = 60s of unique footage) but the narration is
  // 240s. The old engine left the video ~60s long (ended before narration).
  // The new engine must re-pass the safe footage to cover the FULL 240s.
  const scenes = [];
  for (let i = 0; i < 20; i++) scenes.push({ startSec: i * 30, endSec: i * 30 + 3 });
  const durs = scenes.map(() => 12); // 20 * 12 = 240s needed
  const tl = buildSyncedTimeline(scenes, durs, { sourceDurationSec: 30 * 20 + 10 });
  const visTotal = tl.reduce((a, s) => a + (s.endSec - s.startSec), 0);
  assert.ok(Math.abs(visTotal - 240) < 2.0, `visTotal=${visTotal} should ~= 240`);
});

test("buildSyncedTimeline: CREDITS-SAFE — no produced range exceeds the ceiling", () => {
  // Windows span the whole movie; ceiling excludes the last region (credits).
  const scenes = [];
  for (let i = 0; i < 10; i++) scenes.push({ startSec: i * 10, endSec: i * 10 + 4 });
  const durs = scenes.map(() => 30); // far more than available -> forces re-passes
  const ceiling = 80; // credits-safe ceiling well below the last window starts
  const tl = buildSyncedTimeline(scenes, durs, { sourceDurationSec: ceiling });
  for (const s of tl) {
    assert.ok(s.endSec <= ceiling - 0.05 + 1e-6, `range ${JSON.stringify(s)} exceeds ceiling ${ceiling}`);
  }
  // And it still covered the full narration length.
  const visTotal = tl.reduce((a, s) => a + (s.endSec - s.startSec), 0);
  const need = durs.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(visTotal - need) < 2.0, `visTotal=${visTotal} should ~= ${need}`);
});

test("planSyncedRender end-to-end shape", () => {
  const scenes = [
    { startSec: 0, endSec: 8, reason: "intro" },
    { startSec: 60, endSec: 68, reason: "turn" },
    { startSec: 120, endSec: 128, reason: "climax" },
  ];
  const script = "We open on a quiet room. Then everything changes fast. Finally the truth lands hard.";
  const { timeline, beatDurations } = planSyncedRender({
    script, scenes, voiceTotalSec: 30, sourceDurationSec: 200,
  });
  assert.equal(beatDurations.length, 3);
  assert.ok(Math.abs(beatDurations.reduce((a, b) => a + b, 0) - 30) < 0.5);
  assert.ok(timeline.length >= 3);
  // total visual time ~ voiceover total
  const visTotal = timeline.reduce((a, s) => a + (s.endSec - s.startSec), 0);
  assert.ok(Math.abs(visTotal - 30) < 1.0, `visTotal=${visTotal}`);
});

