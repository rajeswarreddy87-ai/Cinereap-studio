import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildConcatManifest, buildRenderArgs, buildTrimArgs, normaliseRenderSettings, RESOLUTION_PRESETS } from "./ffmpeg-args.js";

describe("normaliseRenderSettings", () => {
  it("falls back to 1080p when resolution is unknown", () => {
    const s = normaliseRenderSettings({ resolution: "8k" });
    assert.equal(s.resolution, "1080p");
    assert.equal(s.width, 1920);
    assert.equal(s.height, 1080);
  });
  it("respects 2160p preset", () => {
    const s = normaliseRenderSettings({ resolution: "2160p" });
    assert.equal(s.width, 3840);
    assert.equal(s.height, 2160);
    assert.equal(s.codec, "libx265");
  });
  it("clamps crf into [14, 32]", () => {
    assert.equal(normaliseRenderSettings({ crf: 5 }).crf, 14);
    assert.equal(normaliseRenderSettings({ crf: 99 }).crf, 32);
    assert.equal(normaliseRenderSettings({ crf: 20 }).crf, 20);
  });
  it("defaults muteOriginalAudio to true and respects explicit false", () => {
    assert.equal(normaliseRenderSettings({}).muteOriginalAudio, true);
    assert.equal(normaliseRenderSettings({ muteOriginalAudio: false }).muteOriginalAudio, false);
  });
});

describe("buildConcatManifest", () => {
  it("emits one quoted line per clip", () => {
    const out = buildConcatManifest(["/a/b.mp4", "/c d/e.mp4"]);
    assert.equal(out, "file '/a/b.mp4'\nfile '/c d/e.mp4'\n");
  });
  it("escapes single quotes inside paths", () => {
    const out = buildConcatManifest(["/a's/b.mp4"]);
    assert.match(out, /'\\''/);
  });
  it("throws on empty input", () => {
    assert.throws(() => buildConcatManifest([]));
  });
});

describe("buildRenderArgs", () => {
  const base = {
    concatListPath: "/tmp/list.txt",
    outputPath: "/tmp/out.mp4",
    settings: { resolution: "1080p" },
  };
  it("always includes concat demuxer + safe=0", () => {
    const a = buildRenderArgs(base);
    assert.ok(a.includes("-f"));
    const fi = a.indexOf("-f");
    assert.equal(a[fi + 1], "concat");
    assert.ok(a.includes("-safe"));
  });
  it("drops audio (-an) when no voiceover is supplied", () => {
    const a = buildRenderArgs(base);
    assert.ok(a.includes("-an"));
    assert.ok(!a.includes("-c:a"));
  });
  it("maps voiceover to audio stream when provided", () => {
    const a = buildRenderArgs({ ...base, voiceoverPath: "/tmp/voice.mp3" });
    assert.ok(a.includes("-map"));
    // Video comes from the filter graph ([vout]); audio is the [voice] label.
    const idx = a.indexOf("-map");
    assert.equal(a[idx + 1], "[vout]");
    assert.equal(a[idx + 3], "[voice]");
    assert.ok(a.includes("-c:a"));
    assert.ok(a.includes("aac"));
    assert.ok(a.includes("-shortest"));
  });
  it("uses libx265 codec for 2160p", () => {
    const a = buildRenderArgs({ ...base, settings: { resolution: "2160p" } });
    const cv = a.indexOf("-c:v");
    assert.equal(a[cv + 1], "libx265");
  });
  it("emits a faststart flag for streaming-friendly MP4", () => {
    const a = buildRenderArgs(base);
    assert.ok(a.includes("-movflags"));
    const mi = a.indexOf("-movflags");
    assert.equal(a[mi + 1], "+faststart");
  });
});

describe("buildTrimArgs", () => {
  it("defaults to frame-accurate re-encode with audio stripped", () => {
    const a = buildTrimArgs({ inputPath: "/in.mp4", startSec: 10, endSec: 20, outputPath: "/out.mp4" });
    assert.ok(a.includes("-an"));
    const cv = a.indexOf("-c:v");
    assert.notEqual(cv, -1);
    assert.equal(a[cv + 1], "libx264");
  });
  it("supports reencode:false for fast lossless cuts", () => {
    const a = buildTrimArgs({ inputPath: "/in.mp4", startSec: 10, endSec: 20, outputPath: "/out.mp4", reencode: false });
    assert.ok(a.includes("-c"));
    assert.equal(a[a.indexOf("-c") + 1], "copy");
  });
  it("rejects inverted ranges", () => {
    assert.throws(() => buildTrimArgs({ inputPath: "/in.mp4", startSec: 10, endSec: 5, outputPath: "/out.mp4" }));
  });
});

describe("RESOLUTION_PRESETS", () => {
  it("exposes the three documented presets", () => {
    assert.deepEqual(Object.keys(RESOLUTION_PRESETS).sort(), ["1080p", "1440p", "2160p"]);
  });
});

