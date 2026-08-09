import { test } from "node:test";
import assert from "node:assert/strict";

import { normaliseMood, planMusicTimeline, dominantMood } from "./music.js";

test("normaliseMood maps unknown to dramatic", () => {
  assert.equal(normaliseMood("TENSE"), "tense");
  assert.equal(normaliseMood("weird"), "dramatic");
  assert.equal(normaliseMood(""), "dramatic");
});

test("planMusicTimeline merges consecutive same moods", () => {
  const beats = [{ mood: "calm" }, { mood: "calm" }, { mood: "tense" }, { mood: "tense" }];
  const durs = [5, 5, 6, 6];
  const spans = planMusicTimeline(beats, durs, { minSpanSec: 1 });
  assert.equal(spans.length, 2);
  assert.equal(spans[0].mood, "calm");
  assert.equal(spans[0].durationSec, 10);
  assert.equal(spans[0].startSec, 0);
  assert.equal(spans[1].mood, "tense");
  assert.equal(spans[1].durationSec, 12);
  assert.equal(spans[1].startSec, 10);
});

test("planMusicTimeline absorbs too-short spans into previous", () => {
  const beats = [{ mood: "calm" }, { mood: "epic" }, { mood: "calm" }];
  const durs = [10, 1, 10]; // epic span of 1s < minSpanSec
  const spans = planMusicTimeline(beats, durs, { minSpanSec: 4 });
  // epic absorbed into preceding calm; then trailing calm stays calm and merges?
  // raw: calm10, epic1, calm10 -> epic<4 absorbed into calm -> calm11, then calm10
  // these two calm spans are NOT adjacent in raw (epic between) so they remain 2 spans.
  assert.ok(spans.every((s) => s.durationSec >= 4));
  const totalDur = spans.reduce((a, s) => a + s.durationSec, 0);
  assert.ok(Math.abs(totalDur - 21) < 0.01, `total=${totalDur}`);
  // contiguous offsets
  let t = 0;
  for (const s of spans) { assert.ok(Math.abs(s.startSec - t) < 0.01); t += s.durationSec; }
});

test("planMusicTimeline contiguous offsets sum to total", () => {
  const beats = [{ mood: "dark" }, { mood: "upbeat" }, { mood: "emotional" }, { mood: "epic" }];
  const durs = [8, 9, 7, 6];
  const spans = planMusicTimeline(beats, durs, { minSpanSec: 4 });
  const total = spans.reduce((a, s) => a + s.durationSec, 0);
  assert.ok(Math.abs(total - 30) < 0.01);
});

test("dominantMood returns the most on-screen mood", () => {
  const beats = [{ mood: "calm" }, { mood: "tense" }, { mood: "tense" }];
  const durs = [3, 10, 10];
  assert.equal(dominantMood(beats, durs), "tense");
});

