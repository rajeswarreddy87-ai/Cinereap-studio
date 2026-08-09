import { analyzeScenes, detectSceneCuts, probeDurationSec } from "./scenes.js";

const f = "/tmp/scenetest.mp4";
const dur = await probeDurationSec(f);
console.log("duration:", dur);
const cuts = await detectSceneCuts(f, { threshold: 0.3 });
console.log("raw cuts:", cuts);
const res = await analyzeScenes(f, {
  outDir: "/tmp/scenetest-frames",
  targetCount: 12,
  maxClipSeconds: 5,
  threshold: 0.3,
  onProgress: (p, m) => console.log(`  [${p}%] ${m}`),
});
console.log("scenes:", res.scenes.length);
for (const s of res.scenes) {
  console.log(`  #${s.index} clip ${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)} kf ${s.keyframeSec.toFixed(1)} frame=${s.framePath ? "ok" : "MISSING"}`);
}
