import { test } from "node:test";
import assert from "node:assert/strict";
import { planScenes } from "./scenes.js";

test("planScenes excludes the trailing credits tail", () => {
  const duration = 6000; // 100 min
  // cuts evenly spread to the very end, including the credits region
  const cuts = [];
  for (let t = 60; t < duration; t += 60) cuts.push(t);
  const scenes = planScenes({ cuts, duration, targetCount: 60, maxClipSeconds: 6 });
  const maxEnd = Math.max(...scenes.map((s) => s.endSec));
  // creditsTail = min(8%, max(90s, 3.5%)) = max(90, 210) = 210s -> usableEnd = 5790
  assert.ok(maxEnd <= 5790 + 6, `last clip ${maxEnd} should be before usableEnd ~5790`);
  assert.ok(maxEnd >= 5000, "should still use most of the movie");
});

test("planScenes keeps chronological order and forward windows", () => {
  const duration = 3600;
  const cuts = [120, 600, 1200, 1800, 2400, 3000];
  const scenes = planScenes({ cuts, duration, targetCount: 60, maxClipSeconds: 6 });
  for (let i = 1; i < scenes.length; i++) {
    assert.ok(scenes[i].startSec >= scenes[i - 1].startSec, "scenes must be chronological");
  }
  for (const s of scenes) {
    assert.ok(s.endSec > s.startSec, "each window must be forward (end>start)");
    assert.ok(s.endSec - s.startSec <= 6.001, "clip capped at maxClipSeconds");
  }
});

test("planScenes never exceeds targetCount", () => {
  const duration = 6000;
  const cuts = [];
  for (let t = 5; t < duration; t += 5) cuts.push(t); // 1199 cuts
  const scenes = planScenes({ cuts, duration, targetCount: 60, maxClipSeconds: 6 });
  assert.ok(scenes.length <= 60, `got ${scenes.length} scenes, expected <= 60`);
});

test("planScenes fallback (too few cuts) still avoids credits tail", () => {
  const duration = 6000;
  const scenes = planScenes({ cuts: [10, 20], duration, targetCount: 60, maxClipSeconds: 6 });
  const maxEnd = Math.max(...scenes.map((s) => s.endSec));
  assert.ok(maxEnd <= 5790 + 6, "fallback should also skip the credits tail");
  assert.ok(scenes.length >= 30, "fallback should produce enough scenes");
});

test("planScenes throws on invalid duration", () => {
  assert.throws(() => planScenes({ cuts: [], duration: 0 }));
});

