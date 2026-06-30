
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
    await Promise.allSettled(
      VARIANTS.map(async (style) => {
        const dest = aiThumbPath(req.params.jobId, style);
        const candidates = pickBeatCandidates(style);
        let ok = false;
        let chosen = null;
        for (const timeSec of candidates) {
          try {
            await extractStyledFrame(sourceVideo, timeSec, dest, style);
            ok = true; chosen = timeSec; break;
          } catch {}
        }
        if (ok) {
          results[style] = `/jobs/${req.params.jobId}/ai-thumbnails/${style}`;
          console.log(`[ai-thumbnails ${req.params.jobId}] source-frame ${style} @ ${chosen.toFixed(1)}s OK (analyze=${analyzeJobId_ || 'auto'})`);
        } else {
          errors[style] = `source-frame extraction failed (${candidates.length} candidates)`;
          console.warn(`[ai-thumbnails ${req.params.jobId}] source-frame ${style} failed (${candidates.length} candidates)`);
        }
      })
    );
  }

  // ── Secondary fallback: enhanced real frames from rendered recap ──────────
  let videoOk = false;
  try { await fs.stat(outputVideo); videoOk = true; } catch {}
  const stillMissingAfterSource = VARIANTS.filter((style) => !results[style]);
  if (videoOk && stillMissingAfterSource.length > 0) {
    const duration = await new Promise((resolve) => {
      let out = "";
      const fp = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", outputVideo], { stdio: ["ignore", "pipe", "ignore"] });
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
      stillMissingAfterSource.map(async (style) => {
        try {
          const timeSec = pickTimestamp(style);
          const dest = aiThumbPath(req.params.jobId, style);
          await extractStyledFrame(outputVideo, timeSec, dest, style);
          results[style] = `/jobs/${req.params.jobId}/ai-thumbnails/${style}`;
          console.log(`[ai-thumbnails ${req.params.jobId}] render-frame ${style} @ ${timeSec.toFixed(1)}s OK`);
        } catch (e) {
          errors[style] = (errors[style] ? errors[style] + " | " : "") + String(e?.message || e);
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
