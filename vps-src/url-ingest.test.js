import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFetchPlan, extractDriveId, suggestCacheFilename } from "./url-ingest.js";

describe("buildFetchPlan", () => {
  it("rejects empty / non-string input", () => {
    assert.equal(buildFetchPlan("").kind, "unsupported");
    assert.equal(buildFetchPlan(null).kind, "unsupported");
    assert.equal(buildFetchPlan(undefined).kind, "unsupported");
  });

  it("rejects magnet links", () => {
    const p = buildFetchPlan("magnet:?xt=urn:btih:abcdef");
    assert.equal(p.kind, "unsupported");
    assert.match(p.reason, /torrent/i);
  });

  it("rejects non-http schemes", () => {
    assert.equal(buildFetchPlan("ftp://example.com/file.mp4").kind, "unsupported");
  });

  it("rejects DRM streaming hosts", () => {
    for (const u of [
      "https://www.netflix.com/watch/123",
      "https://www.primevideo.com/detail/abc",
      "https://www.disneyplus.com/movies/xyz",
      "https://hotstar.com/movies/abc",
    ]) {
      const p = buildFetchPlan(u);
      assert.equal(p.kind, "unsupported", `expected ${u} to be rejected`);
      assert.match(p.reason, /DRM|streaming/i);
    }
  });

  it("normalises Google Drive /file/d/ URLs to a direct-download URL", () => {
    const p = buildFetchPlan("https://drive.google.com/file/d/ABC123xyz/view?usp=sharing");
    assert.equal(p.kind, "http");
    assert.match(p.url, /drive\.usercontent\.google\.com/);
    assert.match(p.url, /id=ABC123xyz/);
    assert.equal(p.detectedSource, "google-drive");
  });

  it("normalises Google Drive ?id= URLs", () => {
    const p = buildFetchPlan("https://drive.google.com/open?id=XYZ789abc");
    assert.equal(p.kind, "http");
    assert.match(p.url, /id=XYZ789abc/);
  });

  it("forces Dropbox dl=1", () => {
    const p = buildFetchPlan("https://www.dropbox.com/s/abcdef/movie.mp4?dl=0");
    assert.equal(p.kind, "http");
    assert.match(p.url, /[?&]dl=1/);
    assert.equal(p.detectedSource, "dropbox");
  });

  it("routes YouTube and archive.org through yt-dlp", () => {
    assert.equal(buildFetchPlan("https://www.youtube.com/watch?v=abc").kind, "ytdlp");
    assert.equal(buildFetchPlan("https://youtu.be/abc").kind, "ytdlp");
    assert.equal(buildFetchPlan("https://archive.org/details/some-film").kind, "ytdlp");
    assert.equal(buildFetchPlan("https://vimeo.com/12345").kind, "ytdlp");
  });

  it("treats any other https URL as a direct HTTP download", () => {
    const p = buildFetchPlan("https://my-vps.example.com/movies/awesome.mkv");
    assert.equal(p.kind, "http");
    assert.equal(p.detectedSource, "direct");
  });
});

describe("extractDriveId", () => {
  it("pulls id from /file/d/", () => {
    const url = new URL("https://drive.google.com/file/d/ABC123/view");
    assert.equal(extractDriveId(url), "ABC123");
  });
  it("pulls id from ?id= query string", () => {
    const url = new URL("https://drive.google.com/uc?export=download&id=DEF456");
    assert.equal(extractDriveId(url), "DEF456");
  });
  it("returns null for folder URLs", () => {
    const url = new URL("https://drive.google.com/drive/folders/GHI789");
    assert.equal(extractDriveId(url), null);
  });
});

describe("suggestCacheFilename", () => {
  it("uses .mp4 extension for http plans", () => {
    assert.equal(suggestCacheFilename({ kind: "http" }, "abc"), "ingest-abc.mp4");
  });
  it("uses .mp4 for ytdlp plans (we transcode to mp4 on first probe)", () => {
    assert.equal(suggestCacheFilename({ kind: "ytdlp" }, "xyz"), "ingest-xyz.mp4");
  });
});
