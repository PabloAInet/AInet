#!/usr/bin/env node
/* test-radar-worker.js — spustí suchý test workeru Radara (Python, agents/radar/test_radar.py).
   Bez python3 se jen přeskočí, aby npm test prošel i tam, kde Python není (Render web). */
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const test = path.join(__dirname, "agents", "radar", "test_radar.py");
for (const py of ["python3", "python"]) {
  const v = spawnSync(py, ["--version"], { encoding: "utf8" });
  if (v.status !== 0 || !/Python 3\.(9|1\d)/.test((v.stdout || "") + (v.stderr || ""))) continue;
  const r = spawnSync(py, ["-I", test], { encoding: "utf8", env: { ...process.env, RADAR_ETAPA: "1", RADAR_LIVE: "0" } });
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) { process.stderr.write(r.stderr || ""); process.exit(r.status || 1); }
  process.exit(0);
}
console.log("Radar worker: test přeskočen — python3 (≥ 3.9) není k dispozici.");
