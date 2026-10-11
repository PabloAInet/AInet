#!/usr/bin/env node
/* test-radar-worker.js — spustí suché testy workeru TradeRadara (Python): agents/radar/test_radar.py
   (obchodní den, brány, stín odrazu) a agents/radar/test_projekty.py (ruce projektů roje: měření, stín, papír).
   Bez python3 se jen přeskočí, aby npm test prošel i tam, kde Python není (Render web). */
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const testy = ["test_radar.py", "test_projekty.py"].map(f => path.join(__dirname, "agents", "radar", f));
for (const py of ["python3", "python"]) {
  const v = spawnSync(py, ["--version"], { encoding: "utf8" });
  if (v.status !== 0 || !/Python 3\.(9|1\d)/.test((v.stdout || "") + (v.stderr || ""))) continue;
  for (const test of testy) {
    const r = spawnSync(py, ["-I", test], { encoding: "utf8", env: { ...process.env, RADAR_ETAPA: "1", RADAR_LIVE: "0" } });
    process.stdout.write(r.stdout || "");
    if (r.status !== 0) { process.stderr.write(r.stderr || ""); process.exit(r.status || 1); }
  }
  process.exit(0);
}
console.log("Radar worker: test přeskočen — python3 (≥ 3.9) není k dispozici.");
