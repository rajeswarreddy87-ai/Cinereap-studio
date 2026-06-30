    return { index: best, confidence: conf, reason: String(parsed.reason || "").slice(0, 160) };
  } catch (e) {
    console.warn(`[render ${jobId}] GEMINI beat ${beatIndex} failed:`, e?.message || e);
    return null;
  } finally {
    for (const p of tmpPaths) { try { await fs.unlink(p); } catch {} }
  }
}


function _dedupeCandidates(cands) {
  const out = [];
  for (const c of cands || []) {
    if (!c || !(Number(c.endSec) > Number(c.startSec) + 0.5)) continue;
    const mid = (Number(c.startSec) + Number(c.endSec)) / 2;
    if (out.some(o => Math.abs(((o.startSec + o.endSec) / 2) - mid) < 2.0)) continue;
    out.push({ ...c, startSec: Number(c.startSec), endSec: Number(c.endSec) });
  }
  return out.slice(0, 5);
}
function _tokSet(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2));
}
function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function findTranscriptCandidateForBeat(narration, transcriptSegments, sourceDurationSec = 0) {
  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) return null;
  const q = _tokSet(narration);
  if (!q.size) return null;
  let best = null;
  for (let i = 0; i < transcriptSegments.length; i++) {
    const st = Number(transcriptSegments[i].start ?? transcriptSegments[i].startSec ?? 0);
    let end = st;
    let text = "";
    for (let j = i; j < transcriptSegments.length; j++) {
      const sj = transcriptSegments[j];
      const sjEnd = Number(sj.end ?? sj.endSec ?? st);
      if (sjEnd - st > 18) break;
      text += " " + String(sj.text || "");
      end = Math.max(end, sjEnd);
    }
    const score = _jaccard(q, _tokSet(text));
    if (!best || score > best.score) best = { startSec: st, endSec: Math.max(end, st + 6), score, label: "whisper" };
  }
  if (!best || best.score < 0.09) return null;
  const dur = Math.min(14, Math.max(6, best.endSec - best.startSec + 4));
  const mid = (best.startSec + best.endSec) / 2;
  return {
    label: "whisper",
    startSec: Math.max(0, mid - dur / 2),
    endSec: sourceDurationSec > 0 ? Math.min(sourceDurationSec, mid + dur / 2) : mid + dur / 2,
    score: best.score,
  };
}

/* ---------- routes ---------- */
app.get("/health", (_req, res) => {
