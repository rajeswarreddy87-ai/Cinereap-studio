import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAnalyzeMessages, parseAnalysisResponse } from "./analyze.js";

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

