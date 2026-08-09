import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalyzeMessages,
  buildCanonicalizeCharactersMessages,
  buildContinuityMessages,
  buildNarrationRepairMessages,
  buildNarrationQcMessages,
  buildSceneNotesMessages,
  parseAnalysisResponse,
  reconcileExactIndexedRows,
  semanticQuarantineLimit,
} from "./analyze.js";

describe("buildAnalyzeMessages", () => {
  const baseMovie = {
    title: "Inception",
    year: 2010,
    genre: "sci-fi",
    director: "Christopher Nolan",
    cast: "Leonardo DiCaprio, Joseph Gordon-Levitt",
    durationSec: 8580,
  };
  const frames = [
    { index: 1, timeSec: 30, base64: "AAAA" },
    { index: 2, timeSec: 60, base64: "BBBB" },
  ];

  it("places frame images before the text instruction", () => {
    const msgs = buildAnalyzeMessages({ movie: baseMovie, frames, channelName: "Plotline Panic" });
    assert.equal(msgs.length, 1);
    const c = msgs[0].content;
    assert.equal(c[0].type, "image");
    assert.equal(c[1].type, "image");
    assert.equal(c[2].type, "text");
  });

  it("requests body-only output and JSON shape", () => {
    const msgs = buildAnalyzeMessages({ movie: baseMovie, frames, channelName: "Plotline Panic" });
    const text = msgs[0].content[2].text;
    assert.match(text, /Do NOT include any/);
    assert.match(text, /\"script\"/);
    assert.match(text, /\"timestamps\"/);
    assert.match(text, /Plotline Panic/);
    assert.match(text, /Inception/);
    assert.match(text, /Christopher Nolan/);
  });

  it("omits director / cast cleanly when not provided", () => {
    const msgs = buildAnalyzeMessages({
      movie: { title: "Unknown", durationSec: 6000 },
      frames,
      channelName: "Plotline Panic",
    });
    const text = msgs[0].content[2].text;
    assert.doesNotMatch(text, /directed by/);
    assert.doesNotMatch(text, /starring/);
  });
});

describe("parseAnalysisResponse", () => {
  it("parses plain JSON", () => {
    const out = parseAnalysisResponse(`{"script":"Hello","timestamps":[{"startSec":1,"endSec":5,"reason":"opening"}]}`);
    assert.equal(out.script, "Hello");
    assert.equal(out.timestamps.length, 1);
    assert.equal(out.timestamps[0].startSec, 1);
  });

  it("strips ```json fences", () => {
    const out = parseAnalysisResponse("```json\n{\"script\":\"X\",\"timestamps\":[]}\n```");
    assert.equal(out.script, "X");
    assert.deepEqual(out.timestamps, []);
  });

  it("drops invalid timestamp entries (end <= start, non-numeric)", () => {
    const out = parseAnalysisResponse(JSON.stringify({
      script: "S",
      timestamps: [
        { startSec: 1, endSec: 5, reason: "ok" },
        { startSec: 10, endSec: 5, reason: "inverted" },
        { startSec: "x", endSec: 5, reason: "bad" },
      ],
    }));
    assert.equal(out.timestamps.length, 1);
    assert.equal(out.timestamps[0].reason, "ok");
  });

  it("rejects responses missing required fields", () => {
    assert.throws(() => parseAnalysisResponse(`{"script":"only"}`));
    assert.throws(() => parseAnalysisResponse(`{"timestamps":[]}`));
    assert.throws(() => parseAnalysisResponse("not json at all"));
  });
});

describe("v5 deterministic scene prompts", () => {
  const scene = {
    index: 7,
    startSec: 100,
    endSec: 110,
    sceneStart: 90,
    sceneEnd: 150,
    frameBase64s: ["A", "B", "C"],
  };

  it("requires exact Stage-A scene indexes", () => {
    const messages = buildSceneNotesMessages({
      movie: { title: "Test", durationSec: 1000 },
      scenes: [scene],
      segments: [{ start: 120, end: 121, text: "outside clip" }],
    });
    const text = messages[0].content.at(-1).text;
    assert.match(text, /EXACT scene indexes/);
    // Dialogue outside the approved 100-110s clip must not enter the prompt.
    assert.doesNotMatch(messages[0].content.find((b) => b.text?.startsWith("SCENE"))?.text || "", /outside clip/);
  });

  it("builds score-only Gemini QC without timestamp relocation instructions", () => {
    const messages = buildNarrationQcMessages({
      scenes: [scene],
      narrationByIndex: new Map([[7, "A man opens the door."]]),
    });
    const finalText = messages[0].content.at(-1).text;
    assert.match(finalText, /strict movie-recap visual QC/);
    assert.match(finalText, /score/);
    assert.doesNotMatch(finalText, /choose.*timestamp/i);
  });

  it("builds a bounded frame-grounded repair prompt", () => {
    const messages = buildNarrationRepairMessages({
      scene,
      note: "A man opens a door.",
      narration: "A car explodes elsewhere.",
      maxWords: 20,
    });
    const text = messages[0].content.at(-1).text;
    assert.match(text, /Maximum 20 words/);
    assert.match(text, /directly visible/);
    assert.match(text, /A man opens a door/);
  });
});

describe("reconcileExactIndexedRows", () => {
  const expected = [{ index: 2 }, { index: 7 }, { index: 11 }];

  it("accepts unique exact IDs and identifies only missing scenes", () => {
    const result = reconcileExactIndexedRows(expected, [
      { index: 2, note: "a" },
      { index: 11, note: "c" },
    ]);
    assert.deepEqual(result.missing.map((x) => x.index), [7]);
    assert.equal(result.acceptedById.get(2).note, "a");
    assert.equal(result.complete, false);
  });

  it("ignores renumbered, duplicate, and unknown IDs", () => {
    const result = reconcileExactIndexedRows(expected, [
      { index: 0, note: "renumbered" },
      { index: 2, note: "first" },
      { index: 2, note: "duplicate" },
      { index: 99, note: "unknown" },
    ]);
    assert.deepEqual(result.missing.map((x) => x.index), [7, 11]);
    assert.equal(result.acceptedById.get(2).note, "first");
    assert.equal(result.invalidCount, 3);
  });

  it("returns rows in server expected order", () => {
    const result = reconcileExactIndexedRows(expected, [
      { index: 11, note: "c" },
      { index: 2, note: "a" },
      { index: 7, note: "b" },
    ]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.ordered.map((x) => x.note), ["a", "b", "c"]);
  });
});

describe("semanticQuarantineLimit", () => {
  it("allows a small isolated set but caps at five percent", () => {
    assert.equal(semanticQuarantineLimit(20), 2);
    assert.equal(semanticQuarantineLimit(120), 6);
    assert.equal(semanticQuarantineLimit(200), 10);
  });
});

describe("v5 character identity and continuity prompts", () => {
  it("requires generic aliases to merge into named principals", () => {
    const messages = buildCanonicalizeCharactersMessages({
      movie: { title: "Nobody" },
      characters: [
        { name: "Becca", note: "Hutch's wife" },
        { name: "The blonde woman", note: "views a house with Hutch" },
      ],
      beatNotes: [{ index: 1, note: "Hutch and blonde woman inspect a house." }],
    });
    const text = messages[0].content[0].text;
    assert.match(text, /GENERIC-ALIAS RULE/);
    assert.match(text, /proper CHARACTER name/);
  });

  it("enforces continuity, canonical names, and exact word budgets", () => {
    const messages = buildContinuityMessages({
      beats: [{
        index: 4,
        startSec: 10,
        endSec: 20,
        reason: "Hutch enters the kitchen.",
        narration: "A man enters the kitchen.",
      }],
      characters: [{ name: "Hutch", note: "protagonist" }],
    });
    const text = messages[0].content;
    assert.match(text, /naturally continuing story/);
    assert.match(text, /canonical proper names/);
    assert.match(text, /MAX 20 WORDS/);
  });
});

