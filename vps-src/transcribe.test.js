import { test } from "node:test";
import assert from "node:assert/strict";
import { offsetSegments, mergeTranscript, buildTranscriptBlock } from "./transcribe.js";

test("offsetSegments shifts start/end by chunk start and trims text", () => {
  const resp = {
    segments: [
      { start: 0, end: 2.5, text: " Hello there " },
      { start: 2.5, end: 5, text: "General Kenobi" },
      { start: 5, end: 6, text: "" }, // empty kept here; filtered later in merge
    ],
  };
  const out = offsetSegments(resp, 600);
  assert.equal(out.length, 3);
  assert.equal(out[0].start, 600);
  assert.equal(out[0].end, 602.5);
  assert.equal(out[0].text, "Hello there");
  assert.equal(out[1].start, 602.5);
});

test("offsetSegments tolerates missing/invalid segments", () => {
  assert.deepEqual(offsetSegments({}, 0), []);
  assert.deepEqual(offsetSegments({ segments: [{ start: "x", end: 1, text: "a" }] }, 0), []);
});

test("mergeTranscript sorts by start, drops empties, joins text", () => {
  const a = [
    { start: 5, end: 6, text: "world" },
    { start: 0, end: 1, text: "hello" },
  ];
  const b = [
    { start: 3, end: 4, text: "" },
    { start: 10, end: 11, text: "again" },
  ];
  const merged = mergeTranscript([a, b]);
  assert.equal(merged.segments.length, 3);
  assert.deepEqual(merged.segments.map((s) => s.text), ["hello", "world", "again"]);
  assert.equal(merged.fullText, "hello world again");
});

test("buildTranscriptBlock formats [mm:ss] lines", () => {
  const t = {
    segments: [
      { start: 0, end: 2, text: "intro" },
      { start: 65, end: 67, text: "later" },
    ],
  };
  const block = buildTranscriptBlock(t);
  assert.match(block, /\[00:00\] intro/);
  assert.match(block, /\[01:05\] later/);
});

test("buildTranscriptBlock returns empty string for no segments", () => {
  assert.equal(buildTranscriptBlock(null), "");
  assert.equal(buildTranscriptBlock({ segments: [] }), "");
});

test("buildTranscriptBlock condenses very long transcripts", () => {
  const segments = [];
  for (let i = 0; i < 5000; i++) segments.push({ start: i, end: i + 1, text: "word" });
  const block = buildTranscriptBlock({ segments }, { maxChars: 1000 });
  assert.ok(block.length <= 1100);
  assert.match(block, /transcript condensed/);
});

