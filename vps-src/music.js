/**
 * music.js — scene-adaptive background music planning (v2.2).
 *
 * Instead of one mood bed for the whole recap, the renderer now switches the
 * music to follow the on-screen mood. Claude tags each beat with a mood; here we
 * turn the per-beat on-screen DURATIONS + moods into an ordered list of music
 * "spans" (consecutive same-mood beats merged), each with a start offset and a
 * length on the recap timeline. A separate builder cuts each span from its mood
 * bed, crossfades between spans, and concatenates one music file the length of
 * the voiceover.
 *
 * This module is pure (no I/O) so the timeline math is fully unit-testable.
 */

export const MOODS = ["calm", "tense", "dramatic", "emotional", "epic", "mysterious", "dark", "upbeat"];

/** Coerce an arbitrary mood string to a known mood (default 'dramatic'). */
export function normaliseMood(m) {
  const v = String(m || "").toLowerCase().trim();
  return MOODS.includes(v) ? v : "dramatic";
}

/**
 * Merge consecutive beats that share a mood into spans on the recap timeline.
 *
 * @param {Array<{ mood:string }>} beats        per-beat moods (narration order)
 * @param {number[]} beatDurations               on-screen seconds per beat (from beats.js)
 * @param {object} [opts]
 * @param {number} [opts.minSpanSec=4] merge a too-short span into the previous one
 * @returns {Array<{ mood:string, startSec:number, durationSec:number }>}
 */
export function planMusicTimeline(beats, beatDurations, opts = {}) {
  const minSpanSec = Number.isFinite(opts.minSpanSec) ? opts.minSpanSec : 4;
  const n = Math.min(beats?.length || 0, beatDurations?.length || 0);
  if (n === 0) return [];

  // 1) Build raw spans by merging consecutive equal moods.
  const raw = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const mood = normaliseMood(beats[i]?.mood);
    const dur = Math.max(0, Number(beatDurations[i]) || 0);
    const last = raw[raw.length - 1];
    if (last && last.mood === mood) {
      last.durationSec += dur;
    } else {
      raw.push({ mood, startSec: cursor, durationSec: dur });
    }
    cursor += dur;
  }

  // 2) Absorb spans shorter than minSpanSec into the neighbour (prefer previous).
  const merged = [];
  for (const span of raw) {
    if (span.durationSec <= 0) continue;
    const prev = merged[merged.length - 1];
    if (span.durationSec < minSpanSec && prev) {
      // Extend previous span to swallow this short one (keeps prev's mood).
      prev.durationSec += span.durationSec;
      continue;
    }
    merged.push({ ...span });
  }

  // 3) Recompute start offsets so they are contiguous (defensive).
  let t = 0;
  for (const span of merged) {
    span.startSec = round3(t);
    span.durationSec = round3(span.durationSec);
    t += span.durationSec;
  }
  return merged;
}

/**
 * Pick the single dominant mood (most on-screen time). Used as the fallback
 * when scene-adaptive building is disabled or fails.
 *
 * @returns {string} a known mood
 */
export function dominantMood(beats, beatDurations) {
  const totals = new Map();
  const n = Math.min(beats?.length || 0, beatDurations?.length || 0);
  for (let i = 0; i < n; i++) {
    const mood = normaliseMood(beats[i]?.mood);
    totals.set(mood, (totals.get(mood) || 0) + (Number(beatDurations[i]) || 0));
  }
  let best = "dramatic";
  let bestVal = -1;
  for (const [mood, val] of totals) {
    if (val > bestVal) { bestVal = val; best = mood; }
  }
  return best;
}

function round3(n) { return Math.round(n * 1000) / 1000; }

