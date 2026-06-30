# CineRecap VPS Pipeline — Code Reference (v2.8.6)

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
| **Thumbnails** | `src/index.js` | `docs-export/thumbnail-excerpt.js` | Real-frame-first thumbnail generation |
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

Verify: `GET /health` → `"version": "2.8.6"`

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


## v2.7.4 SigLIP + Gemini activation

- Gemini key inserted into VPS `.env`; `/health` now reports `geminiVerifier: true`, `geminiModel: gemini-2.5-flash`.
- Visual sidecar upgraded from OpenCLIP ViT-B/32 to SigLIP via OpenCLIP:
  - `VISUAL_MODEL_NAME=ViT-SO400M-14-SigLIP2`
  - `VISUAL_MODEL_PRETRAINED=webli`
- Dockerfile now installs `transformers`, `sentencepiece`, and `protobuf`, required by SigLIP tokenizer.
- Container was rebuilt and recreated. Verified inside container:

```json
{"ok":true,"model":true,"modelName":"ViT-SO400M-14-SigLIP2","pretrained":"webli","jobs":0}
```

Operational note: first SigLIP startup downloaded/loaded ~5GB model cache and took several minutes; subsequent starts should be faster from `/data/models`.


## v2.7.5 fixes after latest render review

Latest reviewed render: `h8NLCAIL99` / analyze `SocpiqYc6E`. Findings:

- SigLIP loaded and embedded 179 frames, but the render did not log direct visual-window application.
- Gemini reported `verified 80 beats, applied 0`, because candidate construction was too strict/silent.
- Final beats 80 and 81 had `SYNC-FIX` drift of `1.21s` and `8.48s`, because the gap-fill own-scene re-trim compared against expanded beat end instead of current assembled video duration.

Fixes:

- SigLIP best match is now always retained as a Gemini candidate, even if not directly applied.
- Direct SigLIP application threshold lowered/configurable: `VISUAL_APPLY_THRESHOLD` default `0.16`.
- Gemini REST video part payload changed to snake_case (`inline_data`, `mime_type`).
- Gemini logs now report `attempted`, `applied`, `rejected`, `failed`, and `skipped` counts.
- Gemini acceptance threshold configurable: `GEMINI_ACCEPT_THRESHOLD` default `0.35`.
- Final/climax beat gap-fill Step 1 now compares against current assembled video duration, allowing longer own-scene re-trims for final beats.
- Gap-fill Step 1 now logs successful re-trims.


## v2.7.6 Gemini verifier reliability fix

Latest live render `yown2PRCCE` showed the job UI stuck at `Voicing scene 83/83`, but logs confirmed TTS had completed and the render had moved through SigLIP/Gemini. The stale UI message was because the job progress was not updated during the verifier stage.

Findings from `yown2PRCCE`:

- SigLIP embedded 179 frames.
- Gemini attempted candidate verification but failed/returned no usable choices, so it applied 0 visual changes.
- Tail-beat gap-fill fix worked: final beats re-trimmed own scene and sync validation finished `81 PASS / 0 WARN / 0 FIX`.

Fixes:

- Gemini request now uses JSON mode (`responseMimeType: application/json`).
- Gemini thinking disabled for verifier (`thinkingConfig: { thinkingBudget: 0 }`) so output tokens are not consumed by hidden reasoning.
- Gemini max output raised to 512.
- Logs now include `no JSON in response` snippets when parsing fails.
- `GEMINI_VERIFY_MAX_BEATS` lowered to 35 in `.env` to avoid overload/rate instability.

`GET /health` now reports `version: 2.7.6`.


## v2.7.7 stream-duration drift fix

User-observed issue: climax video stream ended ~1 minute before narration; player froze on last frame while audio continued.

Measured root cause on `recap-yown2PRCCE.mp4`:

```text
video stream duration: 1181.93s
audio stream duration: 1231.33s
delta: ~49.4s
```

Segment probe showed each `beat-muxed-*` MP4 had video about 0.28–0.31s longer than audio; across ~80 beats this accumulated and confused the final concat/encode timestamps. The final encode then produced a shorter video stream and longer audio stream.

Fixes:

- `_muxVideoWithVoice()` now hard-clamps each beat segment with `-t <actual MP3 duration>` so each segment's video/audio timelines stay equal.
- Final encode video filter adds a `tpad` safety guard so the video stream cannot end before the final audio stream.
- Final encode adds `-t outputDurationSec` to clamp the MP4 to expected concat duration.
- Post-render ffprobe validation now logs final video/audio stream durations and warns if delta >1s.

`GET /health` now reports `version: 2.7.7`.


## v2.7.8 controlled video retiming

User recommendation: to avoid narration drifting into the next scene, retime video to narration where safe.

Fix:

- `_muxVideoWithVoice()` now compares assembled beat video duration to actual beat MP3 duration.
- If the ratio is within safe bounds (`VIDEO_RETIME_MIN=0.82`, `VIDEO_RETIME_MAX=1.18`), video is retimed with FFmpeg `setpts=PTS/speed`.
  - ratio < 1.0: video is slowed down to cover narration.
  - ratio > 1.0: video is sped up to finish with narration.
- Larger mismatches still use existing gap-fill / tpad fallback to avoid unnatural speed changes.
- Logs show retimed beats:

```text
BEAT-RETIME: beat-muxed-... video=12.00s audio=13.00s speed=0.923x
```

Current env:

```bash
VIDEO_RETIME_MIN=0.82
VIDEO_RETIME_MAX=1.18
```

`GET /health` now reports `version: 2.7.8`.


## v2.7.9 analyze retry and no-beats fail-fast

Live render `uQ_VvjDHPb` failed because analyze job `xZY3pxqB2M` fell back after Claude `529 overloaded` and produced `timestamps` but no `beats`. Render then tried to build a beat-mux with no voice files and failed at `buildConcatManifest`.

Fixes:

- `callClaude()` now retries overload/rate-limit/temporary failures up to 4 attempts with backoff.
- If scene-aware analysis still fails due Claude overload, analyze fails loudly instead of falling back to timestamp-only fixed-frame mode.
- Analyze now rejects results with no `beats`.
- Render now fails early with a clear message if no beat-level narration exists: `Analysis incomplete: no beat-level narration found for this movie. Rerun Analyze before rendering.`

`GET /health` now reports `version: 2.7.9`.


## v2.8.0 copyright-safe visual mode

User requested copyright-safe transformations but no captions/subtitles.

Enabled by default:

```bash
COPYRIGHT_SAFE_MODE=true
COPYRIGHT_SAFE_MAX_CLIP_SEC=3.0
WATERMARK_TEXT=Plotline Panic
```

Render behavior:

- Shorter max visual cut duration: `maxClipSec=3.0` when copyright-safe mode is enabled.
- Final video filter applies visible transformations:
  - 6% crop/zoom
  - scale/crop to final canvas
  - contrast/brightness/saturation/gamma shift
  - subtle grain/noise
  - black border/frame
  - top-left watermark
- Source audio remains muted in source clips.
- Captions/subtitles are NOT auto-enabled.

Important: this reduces Content ID risk but cannot guarantee no copyright claim/strike.

`GET /health` now reports `version: 2.8.0`.


## v2.8.1 hook and climax safeguards

Additional safeguards after enabling copyright-safe mode:

- `maxClipSec` is now a hard cap even when importance/beatType dynamic cutting is enabled. In copyright-safe mode, high-importance and climax beats get more sub-clips, not longer clips.
- Hook V2 now expands chosen sourceBeatIds with neighbouring beats under copyright-safe mode, producing more short hook clips instead of a few long clips.
- Hook clip cap added:

```bash
COPYRIGHT_SAFE_HOOK_CLIP_SEC=2.5
```

This preserves hook coverage while staying copyright-safer.

`GET /health` now reports `version: 2.8.1`.


## v2.8.2 copyright-safe hoist fix

Latest short render `NaY9wnFIlS` produced ~15 seconds because v2.8.1 referenced `COPYRIGHT_SAFE_MODE` before it was initialized.

Logs showed:

```text
sync planning failed, falling back to loop align: Cannot access 'COPYRIGHT_SAFE_MODE' before initialization
HOOK-V2 failed: Cannot access 'COPYRIGHT_SAFE_MODE' before initialization
BEAT-MUX MAP: 127 sub-clips → 1 body beats
FINAL A/V durations: video=15.40s audio=15.38s
```

Fix:

- `COPYRIGHT_SAFE_MODE` and watermark text are now initialized at the top of `runRenderFromIngest()`, before sync planning and hook generation.
- The duplicate late initialization in final encode was removed.

`GET /health` now reports `version: 2.8.2`.


## v2.8.3 hook retention prompt upgrade

Latest full render had good body A/V stream sync but hook quality was weak.

Fixes:

- Hook beat scoring now boosts shock/emotion/action/family-loss/revenge beats.
- Hook beat scoring penalizes ordinary setup/business/paperwork beats.
- Hook prompt rewritten to require a high-retention 55-75 word hook focused on surprise, shock, emotion, danger, action, betrayal, revenge, or family loss.
- Hook prompt now explicitly disallows generic setup and asks for a concrete unanswered question.
- Hook generation now uses the server's stronger Claude model (`claude-opus-4-5`) instead of Haiku fallback when available.
- Hook max output increased to 700 tokens.

`GET /health` now reports `version: 2.8.3`.


## v2.8.4 body prompt grounding upgrade

User observed wrong character names and relationships in the body narration.

Fixes:

- Removed permissive reliance on model training knowledge when no cast list is provided.
- Names may now be used only when supported by transcript, extracted character list, on-screen text, or unmistakable dialogue.
- If a name or relationship is uncertain, Claude is instructed to use a neutral role label such as `the trainer`, `the manager`, `the daughter`, `one of the men`, etc.
- Added a mandatory `CHARACTER / RELATIONSHIP ACCURACY CONTRACT` to the body prompt.
- Strengthened attribution rule: no guessing job/relationship/action when multiple characters appear; use `one of them` if ambiguous.
- Added explicit `NAME SAFETY` rule in narration quality section.

`GET /health` now reports `version: 2.8.4`.


## v2.8.5 body-only prompt restoration after app-side overwrite

After app-side YouTube/upload/thumbnail changes, the live server still had most body safeguards, but one Stage-A beat-note prompt still allowed `use your knowledge` for character names when no cast list was provided.

Fix:

- Replaced the remaining permissive beat-note fallback with strict transcript/evidence-based naming.
- Hook generation and YouTube upload/metadata/thumbnail code were not modified.
- Verified YouTube routes and hook routes remain present.

`GET /health` now reports `version: 2.8.5`.


## v2.8.6 real-frame-first thumbnails

User requested thumbnails from actual movie frames, not generic AI images.

Fixes:

- `/jobs/:jobId/ai-thumbnails` now uses enhanced real frames from the rendered recap as primary source.
- DALL-E is fallback-only if real-frame extraction fails for a style.
- Frame styling upgraded for clickable channel-style thumbnails:
  - close crop / zoom
  - 1280x720 upscale/crop
  - stronger contrast/saturation/sharpening
  - cinematic color grade
  - vignette/border
- Styles still supported: `dramatic`, `bold`, `cinematic`.

Logs should now show:

```text
[ai-thumbnails <job>] real-frame dramatic @ ...s OK
```

instead of DALL-E-first generation.

`GET /health` now reports `version: 2.8.6`.
