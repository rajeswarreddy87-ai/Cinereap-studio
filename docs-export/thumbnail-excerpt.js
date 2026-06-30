    const imgRes = await fetch(entry.url);
    if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
    buf = Buffer.from(await imgRes.arrayBuffer());
  } else if (entry?.b64_json) {
    buf = Buffer.from(entry.b64_json, "base64");
  } else {
    throw new Error("No url or b64_json in DALL-E response");
  }
  // Re-encode to JPEG via ffmpeg (normalises size + strips metadata)
  const tmpPng = destPath + ".tmp.png";
  await fs.writeFile(tmpPng, buf);
  await new Promise((resolve) => {
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", tmpPng,
      "-vf", "scale=1280:-2", "-q:v", "3", destPath], { stdio: "ignore" });
    ff.on("close", resolve); ff.on("error", resolve);
  });
  try { await fs.unlink(tmpPng); } catch {}
  await fs.stat(destPath); // throws if file wasn't written
  return destPath;
}

// Build a channel-style DALL-E prompt from the story data.
// The goal: hyperrealistic YouTube thumbnail showing hero in danger — matching
// the "Super Short Summary" channel aesthetic (close-up face, tabloid drama).
function buildChannelDallEPrompt(style, { youtubeTitle, storySummary, movieTitle }) {
  const title = (youtubeTitle || movieTitle || "a dramatic movie scene").replace(/['"]/g, "");
  const summary = (storySummary || "").slice(0, 220).replace(/['"]/g, "");
  const storyCtx = summary
    ? `Story context: "${summary}". `
    : "";

  if (style === "dramatic") {
    return (
      `${storyCtx}` +
      `YouTube movie recap thumbnail — tabloid drama style, title: "${title}". ` +
      `Hyperrealistic cinematic close-up: the PROTAGONIST (the victim or hero from this story) fills most of the frame. ` +
      `Their face shows raw fear, desperation, or pain — wide eyes, tense jaw, sweat. ` +
      `A threatening figure or dark force looms behind them or is partially visible at the edge. ` +
      `Dramatic chiaroscuro: face lit from one side by a harsh amber/orange practical light, ` +
      `deep black background with cool blue shadows. Shallow depth of field, film grain, ` +
      `sharp on the eyes. No text. No watermarks. No subtitles. 16:9 aspect ratio.`
    );
  }
  if (style === "bold") {
    return (
      `${storyCtx}` +
      `YouTube thumbnail — high-voltage confrontation scene for: "${title}". ` +
      `Hyperrealistic film still: the hero faces the antagonist or threat head-on. ` +
      `Both figures tense, aggressive body language, intense eye contact or a physical clash. ` +
      `Extreme high-contrast lighting — vivid warm orange side-light on hero, ` +
      `cold blue/green on the antagonist. Punchy oversaturated colors. ` +
      `Camera slightly low-angle to emphasise power struggle. No text. No watermarks. 16:9.`
    );
  }
  // cinematic
  return (
    `${storyCtx}` +
    `Widescreen cinematic YouTube thumbnail for: "${title}". ` +
    `The protagonist stands small against an imposing, dangerous environment or crowd. ` +
    `Atmospheric: moody blue-grey haze, orange-amber practical lights in background, ` +
    `Hollywood orange-teal colour grade, heavy film grain, epic scale. ` +
    `The hero's body language conveys vulnerability or defiance. ` +
    `Netflix key-art quality. No text. No watermarks. 16:9 aspect ratio.`
  );
}

/* ---------- POST /jobs/:jobId/ai-thumbnails: real-frame channel thumbnails -- */
// Primary: enhanced real frames from the rendered recap video (actual movie character faces).
// Fallback: DALL-E only if real-frame extraction fails.
app.post("/jobs/:jobId/ai-thumbnails", requireAuth, async (req, res) => {
  const job = await jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });

  const { analyzeJobId, movieTitle } = req.body || {};

  const VARIANTS = ["dramatic", "bold", "cinematic"];
  const results = {};
  const errors  = {};

  // ── Resolve story data and source/analyze beats ──────────────────────────
  let storyData = {
    youtubeTitle: null,
    storySummary: null,
    movieTitle: (typeof movieTitle === "string" && movieTitle.trim()) ? movieTitle.trim() : null,
    sourceFileId: job.sourceFileId || job.result?.sourceFileId || null,
    beats: [],
  };
  let analyzeJobId_ = analyzeJobId || job.analyzeJobId;
  if (!analyzeJobId_ && storyData.sourceFileId) {
    const allJobs = await jobStore.list().catch(() => []);
    const latestAnalyze = allJobs
      .filter((j) => j.kind === "analyze" && j.status === "done" &&
        (j.sourceFileId === storyData.sourceFileId || j.result?.sourceFileId === storyData.sourceFileId) &&
        Array.isArray(j.result?.beats) && j.result.beats.length > 0)
      .sort((a, b) => (b.completedAt || b.updatedAt || b.createdAt || 0) - (a.completedAt || a.updatedAt || a.createdAt || 0))[0];
    analyzeJobId_ = latestAnalyze?.id || null;
  }
  if (analyzeJobId_) {
    const analyzeJob = await jobStore.get(analyzeJobId_).catch(() => null);
    if (analyzeJob?.result) {
      storyData.youtubeTitle = analyzeJob.result.youtubeTitle || null;
      storyData.storySummary = analyzeJob.result.storySummary || null;
      storyData.movieTitle   = storyData.movieTitle || analyzeJob.result.movieTitle || analyzeJob.result.youtubeTitle || null;
      storyData.sourceFileId = storyData.sourceFileId || analyzeJob.result.sourceFileId || analyzeJob.sourceFileId || null;
      storyData.beats = Array.isArray(analyzeJob.result.beats) ? analyzeJob.result.beats : [];
    }
  }

  // ── PRIMARY: actual source-movie hero-in-trouble frames from analyze beats ─
  const outputVideo = job.outputPath || path.join(OUTPUT_DIR, `recap-${req.params.jobId}.mp4`);
  const sourceVideo = storyData.sourceFileId ? path.join(UPLOADS_DIR, storyData.sourceFileId) : null;
  let sourceOk = false;
  try { if (sourceVideo) { await fs.stat(sourceVideo); sourceOk = true; } } catch {}

  const scoreThumbBeat = (b, style) => {
    const txt = String(b?.narration || b?.reason || "").toLowerCase();
    let score = Number(b?.importance || 0);
    if (/blood|shot|gun|death|dies|killed|funeral|grave|crash|hospital|cry|tears|daughter|wife|loss|grief|custody/i.test(txt)) score += style === "dramatic" ? 14 : 8;
    if (/fight|brawl|punch|knockout|chase|threat|attacks|corner|low blow|uppercut|revenge|escobar/i.test(txt)) score += style === "bold" ? 14 : 7;
    if (/alone|crowd|arena|cemetery|grave|city|night|final|climax|champion|palace/i.test(txt)) score += style === "cinematic" ? 12 : 4;
    if (/contract|business|paperwork|press conference|pool|party|speech/i.test(txt)) score -= 8;
    return score;
  };

  const pickBeatCandidates = (style) => {
    const beats = storyData.beats || [];
    return beats
      .filter((b) => Number.isFinite(Number(b.startSec)) && Number.isFinite(Number(b.endSec)) && Number(b.endSec) > Number(b.startSec))
      .map((b) => ({ beat: b, score: scoreThumbBeat(b, style) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .flatMap(({ beat }) => {
        const st = Number(beat.startSec), en = Number(beat.endSec);
        const dur = Math.max(0.5, en - st);
        return [st + dur * 0.28, st + dur * 0.50, st + dur * 0.72];
      });
  };

  if (sourceOk && storyData.beats.length > 0) {
    const usedThumbTimes = [];
    for (const style of VARIANTS) {
      const dest = aiThumbPath(req.params.jobId, style);
      const candidates = pickBeatCandidates(style);
      let ok = false;
      let chosen = null;
      let chosenBrightness = 0;
      for (const timeSec of candidates) {
        if (usedThumbTimes.some((t) => Math.abs(t - timeSec) < 18)) continue; // avoid same moment across variants
        try {
          await extractStyledFrame(sourceVideo, timeSec, dest, style);
          const bright = await measureImageBrightness(dest);
          if (bright < Number(process.env.THUMB_MIN_BRIGHTNESS || 58)) {
            console.log(`[ai-thumbnails ${req.params.jobId}] source-frame ${style} @ ${timeSec.toFixed(1)}s rejected dark brightness=${bright.toFixed(1)}`);
            try { await fs.unlink(dest); } catch {}
            continue;
          }
          ok = true; chosen = timeSec; chosenBrightness = bright; usedThumbTimes.push(timeSec); break;
        } catch {}
      }
      // If all bright/unique candidates failed, allow the best candidate even if dark rather than DALL-E generic.
      if (!ok && candidates.length > 0) {
        for (const timeSec of candidates) {
          try {
            await extractStyledFrame(sourceVideo, timeSec, dest, style);
            const bright = await measureImageBrightness(dest);
            ok = true; chosen = timeSec; chosenBrightness = bright; usedThumbTimes.push(timeSec); break;
          } catch {}
        }
      }
      if (ok) {
        results[style] = `/jobs/${req.params.jobId}/ai-thumbnails/${style}`;
