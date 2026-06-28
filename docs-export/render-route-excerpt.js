/* ---------- /render-from-ingest: trim + concat directly from a cached source ---------- */
app.post("/render-from-ingest", requireAuth, async (req, res) => {
  const {
    fileId,
    timestamps,
    voiceoverFileId,
    voiceoverFileIds,    // new — array of MP3 chunks to concat
    musicFileId,         // new — single MP3 to mix in (uploaded file)
    musicMood,           // new — name of a built-in mood bed in /data/music
    subtitlesSrt,        // new — raw .srt content to burn into video
    musicVolumeDb,       // new — optional, defaults to -14 dB
    beats,               // v2.2 — Option B: [{ startSec, endSec, narration, mood }] in narration order
    sceneAdaptiveMusic,  // v2.2 — when true + beats present, switch music mood per scene span
    analyzeJobId,        // v2.7 — ID of the analyze job whose frames CLIP should search
    targetMinutes,       // user-selected recap length (minutes)
    settings,
  } = req.body || {};
  if (!fileId) return res.status(400).json({ error: "fileId required" });
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    return res.status(400).json({ error: "timestamps required" });
  }
  const sourcePath = path.join(UPLOADS_DIR, fileId);
  try { await fs.access(sourcePath); } catch { return res.status(404).json({ error: "fileId not found" }); }

  // Resolve voiceover file IDs into a list. Both legacy single-id and new
  // array form are accepted; the array wins when both are provided.
  const voiceIds = Array.isArray(voiceoverFileIds) && voiceoverFileIds.length > 0
    ? voiceoverFileIds
    : (voiceoverFileId ? [voiceoverFileId] : []);
  for (const id of voiceIds) {
    try { await fs.access(path.join(UPLOADS_DIR, id)); }
    catch { return res.status(400).json({ error: `Missing voiceover: ${id}` }); }
  }
  if (musicFileId) {
    try { await fs.access(path.join(UPLOADS_DIR, musicFileId)); }
    catch { return res.status(400).json({ error: `Missing music: ${musicFileId}` }); }
  }
  // Resolve a built-in mood bed (no upload needed). Sanitise the mood name to a
  // bare filename so it can never escape /data/music.
  let resolvedMusicPath = null;
  if (!musicFileId && typeof musicMood === "string" && musicMood.trim()) {
    const safe = musicMood.trim().toLowerCase().replace(/[^a-z]/g, "");
    const candidate = path.join(MUSIC_DIR, `${safe}.mp3`);
    try { await fs.access(candidate); resolvedMusicPath = candidate; }
    catch { return res.status(400).json({ error: `Unknown music mood: ${musicMood}` }); }
  }

  const jobId = nanoid(10);
  const normalised = normaliseRenderSettings(settings || {});
  await jobStore.create(jobId, {
    status: "queued",
    progress: 0,
    message: "Queued",
    kind: "render",
    sourceFileId: fileId,
    voiceoverFileIds: voiceIds,
    musicFileId: musicFileId || null,
    hasSubtitles: typeof subtitlesSrt === "string" && subtitlesSrt.trim().length > 0,
    timestamps,
    settings: normalised,
  });

  withAutoRetry(jobId, "render", () => runRenderFromIngest(jobId, {
    sourcePath,
    timestamps,
    voiceoverFileIds: voiceIds,
    musicFileId: musicFileId || null,
    musicPathOverride: resolvedMusicPath,
    subtitlesSrt: typeof subtitlesSrt === "string" ? subtitlesSrt : "",
    musicVolumeDb,
    beats: Array.isArray(beats) ? beats : null,
    sceneAdaptiveMusic: sceneAdaptiveMusic !== false, // default ON when beats present
    analyzeJobId: typeof analyzeJobId === "string" && analyzeJobId.trim() ? analyzeJobId.trim() : null,
    targetMinutes: Number(targetMinutes) || Number(normalised?.targetMinutes) || 20,
    settings: normalised,
  })).catch(() => {});

  res.json({ jobId });
