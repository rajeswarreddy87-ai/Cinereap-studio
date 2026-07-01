/**
 * TMDb cast lookup (v2.9.7). Whisper has no speaker diarization, so Claude has to
 * guess who says what — the #1 source of wrong character names/relationships in
 * the narration. A real cast list (character names, top-billed) passed to the
 * analyze prompts as `movie.cast` dramatically improves accuracy.
 *
 * Supports both TMDb auth styles:
 *   - v3 API key  -> passed as ?api_key=...
 *   - v4 read token (JWT, starts "eyJ") -> Authorization: Bearer ...
 */

const TMDB_BASE = "https://api.themoviedb.org/3";

async function _tmdbGet(pathAndQuery, apiKey) {
  const isV4 = apiKey.startsWith("eyJ");
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = isV4 ? `${TMDB_BASE}${pathAndQuery}` : `${TMDB_BASE}${pathAndQuery}${sep}api_key=${encodeURIComponent(apiKey)}`;
  const opts = isV4 ? { headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" } } : {};
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status} for ${pathAndQuery.split("?")[0]}`);
  return res.json();
}

/**
 * Look up a film by title (+ optional year) and return a comma-separated list of
 * top-billed CHARACTER names (not actors), or null if nothing usable is found.
 */
export async function fetchTmdbCast({ apiKey, title, year, maxCharacters = 15 }) {
  if (!apiKey || !title) return null;

  const q = `/search/movie?query=${encodeURIComponent(title)}${year ? `&year=${encodeURIComponent(year)}` : ""}`;
  const search = await _tmdbGet(q, apiKey);
  const results = Array.isArray(search?.results) ? search.results : [];
  if (results.length === 0) return null;

  // Prefer an exact (case-insensitive) title match, else the most popular result.
  const lc = String(title).trim().toLowerCase();
  const exact = results.find((r) => String(r.title || r.original_title || "").trim().toLowerCase() === lc);
  const chosen = exact
    || results.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  if (!chosen?.id) return null;

  const credits = await _tmdbGet(`/movie/${chosen.id}/credits`, apiKey);
  const cast = Array.isArray(credits?.cast) ? credits.cast : [];

  const names = cast
    .slice(0, maxCharacters)
    .map((c) => String(c?.character || "").trim())
    // Drop non-character labels and voice/uncredited noise.
    .filter((n) => n && !/^self$|uncredited|\(voice\)|^voice$/i.test(n))
    // "Billy 'The Great' Hope / Narrator" -> "Billy 'The Great' Hope"
    .map((n) => n.split("/")[0].trim())
    .filter(Boolean);

  const uniq = [...new Set(names)];
  return uniq.length ? uniq.join(", ") : null;
}
