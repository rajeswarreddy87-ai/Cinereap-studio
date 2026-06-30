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

  // ── Resolve story data from the analyze job ───────────────────────────────
  let storyData = {
    youtubeTitle: null,
    storySummary: null,
    movieTitle: (typeof movieTitle === "string" && movieTitle.trim()) ? movieTitle.trim() : null,
  };
  const analyzeJobId_ = analyzeJobId || job.analyzeJobId;
  if (analyzeJobId_) {
    const analyzeJob = await jobStore.get(analyzeJobId_).catch(() => null);
    if (analyzeJob?.result) {
      storyData.youtubeTitle = analyzeJob.result.youtubeTitle || null;
      storyData.storySummary = analyzeJob.result.storySummary || null;
      storyData.movieTitle   = storyData.movieTitle || analyzeJob.result.movieTitle || analyzeJob.result.youtubeTitle || null;
    }
  }

  // ── PRIMARY: enhanced real movie frames from rendered recap ────────────────
  const outputVideo = job.outputPath || path.join(OUTPUT_DIR, `recap-${req.params.jobId}.mp4`);
  let videoOk = false;
  try { await fs.stat(outputVideo); videoOk = true; } catch {}

  if (videoOk) {
    const duration = await new Promise((resolve) => {
      let out = "";
      const fp = spawn("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", outputVideo,
      ], { stdio: ["ignore", "pipe", "ignore"] });
      fp.stdout.on("data", (c) => { out += c; });
      fp.on("close", () => resolve(parseFloat(out.trim()) || 60));
      fp.on("error", () => resolve(60));
    });

    const sceneTs = await findSceneChangeTimestamps(outputVideo, duration);
    const TARGET_REGIONS = {
      dramatic:  { lo: 0.45, hi: 0.78, fallback: 0.62 },
      bold:      { lo: 0.18, hi: 0.58, fallback: 0.42 },
      cinematic: { lo: 0.55, hi: 0.90, fallback: 0.72 },
    };
    const pickTimestamp = (style) => {
      const { lo, hi, fallback } = TARGET_REGIONS[style];
      const inRegion = sceneTs.filter((t) => t >= duration * lo && t <= duration * hi);
      if (inRegion.length > 0) {
        const center = duration * ((lo + hi) / 2);
        return inRegion.reduce((a, b) => Math.abs(b - center) < Math.abs(a - center) ? b : a);
      }
      return Math.max(1, Math.min(duration * fallback, duration - 1));
    };
    await Promise.allSettled(
      VARIANTS.map(async (style) => {
        try {
          const timeSec = pickTimestamp(style);
          const dest = aiThumbPath(req.params.jobId, style);
          await extractStyledFrame(outputVideo, timeSec, dest, style);
          results[style] = `/jobs/${req.params.jobId}/ai-thumbnails/${style}`;
          console.log(`[ai-thumbnails ${req.params.jobId}] real-frame ${style} @ ${timeSec.toFixed(1)}s OK`);
        } catch (e) {
          errors[style] = String(e?.message || e);
          console.warn(`[ai-thumbnails ${req.params.jobId}] real-frame ${style} failed:`, e?.message || e);
        }
      })
    );
  }

  // ── FALLBACK: DALL-E only for styles where real frame extraction failed ───
  const missingStyles = VARIANTS.filter((style) => !results[style]);
  if (missingStyles.length > 0 && SERVER_OPENAI_KEY) {
    await Promise.allSettled(
      missingStyles.map(async (style) => {
        try {
          const prompt = buildChannelDallEPrompt(style, storyData);
          const dest = aiThumbPath(req.params.jobId, style);
          console.log(`[ai-thumbnails ${req.params.jobId}] DALL-E fallback ${style} prompt: ${prompt.slice(0, 120)}…`);
          await generateDalleThumbnail(SERVER_OPENAI_KEY, prompt, dest);
          results[style] = `/jobs/${req.params.jobId}/ai-thumbnails/${style}`;
          console.log(`[ai-thumbnails ${req.params.jobId}] DALL-E fallback ${style} OK`);
        } catch (e) {
          errors[style] = (errors[style] ? errors[style] + " | " : "") + String(e?.message || e);
          console.warn(`[ai-thumbnails ${req.params.jobId}] DALL-E fallback ${style} failed:`, e?.message || e);
        }
      })
    );
  }

  if (Object.keys(results).length === 0) {
    return res.status(502).json({ error: "All thumbnail variants failed", details: errors });
  }
  const thumbPaths = {};
  for (const [style] of Object.entries(results)) {
    thumbPaths[style] = aiThumbPath(req.params.jobId, style);
  }
  await jobStore.update(req.params.jobId, { aiThumbnailPaths: thumbPaths }).catch(() => {});
  res.json({ thumbnails: results, errors: Object.keys(errors).length ? errors : undefined });
});

/* ---------- GET /jobs/:jobId/ai-thumbnails/:style: serve stored variant ---- */
app.get("/jobs/:jobId/ai-thumbnails/:style", requireAuth, async (req, res) => {
