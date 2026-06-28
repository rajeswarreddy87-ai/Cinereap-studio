# CineRecap VPS Pipeline — Code Reference (v2.7.4)

**Server path:** `/root/cinerecap-render-server/`  
**Live URL:** `http://109.123.241.130:4040`  
**Exported copies in this repo:** `docs-export/`
**Latest VPS patch:** v2.7.4 — post-trim hook footage, protected scene locks, Whisper candidate windows, optional Gemini Flash verifier, tail-beat full-MP3 gap fill.

---

## Simple pipeline (what actually runs)

```
1. POST /upload/movie          → fileId
2. POST /analyze               → analyzeJobId + beats[] (178 scenes typical)
3. POST /render-from-ingest    → recap MP4
```

Your Android app already follows this correctly (confirmed in `api.ts` + `index.tsx`).

---

## Module map (copy-paste source files)

| Module | VPS path | Exported file | Role |
|--------|----------|---------------|------|
| **Timeline builder** | `src/beats.js` | `docs-export/beats.js` | `planSyncedRender()`, `buildSyncedTimeline()`, `computeBeatDurations()` |
| **Scene selection** | `src/scenes.js` | `docs-export/scenes.js` | FFmpeg scene detection, `FRAMES_PER_SCENE=5`, `SCENE_THRESHOLD=0.25` |
| **Analysis + narration** | `src/analyze.js` | `docs-export/analyze.js` | Claude prompts, `extractFrames()`, `analyzeWithScenes()` |
| **Beat assembly / mux** | `src/index.js` | `docs-export/beat-mux-excerpt.js` | Per-beat video concat + `_muxVideoWithVoice()` |
| **Hook generation** | `src/index.js` | `docs-export/hook-generation-excerpt.js` | HOOK-V2 Claude prompt + `sourceBeatIds` |
| **Timeline sync block** | `src/index.js` | `docs-export/timeline-sync-excerpt.js` | Whisper align, sync score, subdivide |
| **Gemini verifier** | `src/index.js` | `docs-export/gemini-verifier-excerpt.js` | Whisper/OpenCLIP/Gemini candidate verification |
| **Render API** | `src/index.js` | `docs-export/render-route-excerpt.js` | `POST /render-from-ingest` |
| **FFmpeg helpers** | `src/ffmpeg-args.js` | `docs-export/ffmpeg-args.js` | `buildTrimArgs()`, `buildRenderArgs()`, `setpts` slow-mo |
| **Music ducking** | `src/music.js` + index.js | `docs-export/music.js` | Mood beds, sidechain compress |

Full render worker: `src/index.js` → `runRenderFromIngest()` (~lines 3300–5600)

---

## Frames Claude analyzes

From `scenes.js`:

```javascript
export const FRAMES_PER_SCENE = 5;  // start, 25%, mid, 75%, end of each scene
export const SCENE_THRESHOLD = 0.25; // ~120–180 scenes per 2-hour film
```

**Total frames sent to Claude** = `min(140, max(8, frameBudget || 60))` for legacy path, OR **~5 × number of detected scenes** for scene-aware path.

Example: 150 detected scenes × 5 frames = **~750 frames** (batched to Claude in groups).

Default `frameBudget` from app/server: **60–140** if scene detection falls back.

---

## Claude model (latest renders)

| Step | Model | Source |
|------|-------|--------|
| `/analyze` | **claude-opus-4-5** | `SERVER_ANTHROPIC_MODEL` env / server default |
| HOOK-V2 text | claude-haiku-4-5 or gpt-4o-mini | fallback in render |
| Latest analyze job | `GkT1FmH4A1` / `BsAz4bjZ8K` | logs: `claude-opus-4-5` |

**Will Opus fix Hector/Jonathan name swaps?** It already runs Opus for analysis. Name errors are **content accuracy** (transcript grounding), not timing. Opus helps but is not 100% — transcript must match dialogue at that timestamp.

---

## Why fixes seem to break something else

The pipeline has **two separate problems** that look like the same bug:

| Type | Symptom | What server measures |
|------|---------|---------------------|
| **Timing sync** | Audio ends before/after video | `SYNC-VALIDATION`, `drift=0.3s` |
| **Content sync** | Funeral in narration, boxing on screen | NOT measured — sync score can be 100% while content is wrong |

Fixing timing (per-beat TTS, beat mux, Whisper) does **not** fix wrong scene selection or wrong character names.

**Layers that interact:**
1. Analyze (178 beats, narration, scene windows)
2. Beat trim (178 → 71) — **drops scenes**
3. HOOK-V2 prepend — **can show credits if beat < 120s**
4. CLIP semantic match — can pick wrong window
5. Chronological sort — reorders beats + audio together
6. Music ducking — can overpower if bed too loud

Each layer was added to fix a prior issue → new edge cases.

---

## Latest render log summary

| Job | Analyze | Beats | Sync score | Issues logged |
|-----|---------|-------|------------|---------------|
| `H9u-xpMSAF` | `BsAz4bjZ8K` Opus | 178→71 | 100% | Whisper partial nulls; hook prepended |
| `Z9QV1mscWi` | `GkT1FmH4A1` Opus | 178→70 | 100% | 1 beat WARN 0.32s drift |

Server reports **0.3–0.6s timing drift** — not 5–10s.  
**5–10s perceived drift** = wrong scene for ~2–3 beats accumulating visually.

---

## v2.7.2 / v2.7.3 server fixes (deployed)

1. **HOOK credits fix** — hook beats must be `startSec >= 120s` (no logo/credits footage)
2. **HOOK lookup** — uses `_preTrimBeats` for stable scene windows
3. **Beat trim** — protects funeral/death/climax beats from stratified drop
4. **Music** — default bed `-26dB` (was `-18`), stronger ducking `ratio=12`
5. **v2.7.1 fixes retained** — analyzeJobId auto-resolve, per-beat TTS, video speed-up in mux

Verify: `GET /health` → `"version": "2.7.4"`

---

## Key functions (quick reference)

### Timeline builder (`beats.js`)

```javascript
planSyncedRender({ script, scenes, voiceTotalSec, beatTexts, beatDurations })
  → { timeline, beatDurations, beatTexts }

buildSyncedTimeline(scenes, beatDurations, opts)
  → [{ startSec, endSec, beatIndex }]  // sub-clips ≤6s each
```

### Beat assembly (`index.js`)

```
For each beat:
  1. Concat sub-clips → beat video (video only)
  2. GAP-FILL if video shorter than TTS (borrow footage / slow-mo)
  3. _muxVideoWithVoice(beatVideo, beatTTS) → synced segment
Concat all segments + optional hook prepend + music duck
```

### Hook generation (`index.js`)

```
1. Score beats by importance/emotion (post-trim)
2. Claude writes hookText + sourceBeatIds[]
3. Trim footage from those beat windows
4. TTS hook narration
5. Mux → prepend to body
```

---

## Android app checklist (confirmed ✅)

| Check | Status |
|-------|--------|
| `POST /render-from-ingest` | ✅ `api.ts:147` |
| `fileId` | ✅ always sent |
| `beats` + `analyzeJobId` | ✅ both sent |
| `targetMinutes` | ✅ dynamic 15–25 min |
| No `POST /render` | ✅ not used |

---

## Recommended next render test

1. Force fresh analyze: `{ forceRefresh: true }` on `/analyze`
2. Check logs for: `HOOK-V2 beat #N at Xs < intro floor — skipping`
3. Check logs for: `BEAT-TRIM: protected key scene kept`
4. Verify funeral beat narration text matches `startSec` in analyze JSON

---

## Full file copy commands (on VPS)

```bash
cd /root/cinerecap-render-server
tar czf cinerecap-pipeline-code.tar.gz src/beats.js src/scenes.js src/analyze.js src/ffmpeg-args.js src/music.js src/index.js
```

Download `cinerecap-pipeline-code.tar.gz` for complete copy-paste archive.


## v2.7.3 additional fixes

- Hoisted `_preTrimBeats` so HOOK-V2 no longer fails with `not defined`.
- Fixed `srcDurClip` scope so CLIP matching no longer skips with `srcDurClip is not defined`.
- Enforced intro-safe floor by filtering pre-logo/credits beats before timeline planning.
- Removed beat-level video speed-up and padded video tail to actual MP3 duration so final words are not cut by `-shortest`.
- Persisted final `result` metadata (`downloadUrl`, duration, size, hookIncluded, beatsRendered).


## v2.7.4 additional fixes

- Hook footage now resolves from the post-trim beat list used to write hook narration, fixing hook narration/video mismatch.
- Protected story beats (funeral, cemetery, grave, death, shooting, climax, hospital, etc.) are locked against CLIP/text recentering so important visuals are not moved away from their analyzed source windows.
- Source Whisper transcript cache is loaded during render and used to produce candidate timestamp windows for dialogue-heavy beats.
- Optional Gemini Flash verifier added: when `GEMINI_API_KEY` is set, the server sends top candidate short clips (analyze/current/OpenCLIP/Whisper) and lets Gemini choose the best visual match.
- Tail beats use actual MP3 duration for gap-fill so climax/final narration is less likely to play over a frozen last frame.
- Default TTS speed is slightly slower (`0.95`) unless overridden by app/settings/env.

### Gemini activation

Add to `/root/cinerecap-render-server/.env` and recreate the container:

```bash
GEMINI_API_KEY=your_google_ai_studio_key
GEMINI_MODEL=gemini-2.5-flash
GEMINI_VERIFY_MAX_BEATS=80
cd /root/cinerecap-render-server && docker compose up -d --force-recreate render
```

`GET /health` should then show `geminiVerifier: true`.
