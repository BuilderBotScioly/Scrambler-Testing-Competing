/* Scrambler Tool (Div B 2026 rules) - Static GitHub Pages
   - Local-only login (PBKDF2 hash in localStorage)
   - Practice tab: timer + run recorder + chart + summary + CSV
   - Meet tab: timer + multiple teams; each team has run1/run2 inputs (distance + up to 3 times averaged + bucket/penalties/failed)
*/

const $ = (id) => document.getElementById(id);

// ---------- Storage ----------
const LS = {
  USERS: "scrambler_users_v3",
  RUNS:  "scrambler_runs_v3",
  MEET:  "scrambler_meet_v3",
  SESSION: "scrambler_session_v3"
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function getUsers() { return loadJSON(LS.USERS, {}); }
function setUsers(u) { saveJSON(LS.USERS, u); }

function getRuns() { return loadJSON(LS.RUNS, []); }
function setRuns(r) { saveJSON(LS.RUNS, r); }

function getMeetAll() { return loadJSON(LS.MEET, {}); }
function setMeetAll(x) { saveJSON(LS.MEET, x); }

function getSession() { return loadJSON(LS.SESSION, null); }
function setSession(user) { saveJSON(LS.SESSION, { user }); }
function clearSession() { localStorage.removeItem(LS.SESSION); }

function uid() { return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16); }

function showMsg(el, text, err=false) {
  if (!el) return;
  el.textContent = text;
  el.style.color = err ? "var(--danger)" : "var(--accent)";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(x) { return Math.round(x * 100) / 100; }

// ---------- Crypto (PBKDF2) ----------
function bytesToB64(bytes) {
  let s = "";
  bytes.forEach(b => s += String.fromCharCode(b));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2Hash(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: 150000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function createUser(username, password) {
  const users = getUsers();
  if (users[username]) throw new Error("That username already exists.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hash(password, salt);
  users[username] = {
    saltB64: bytesToB64(salt),
    hashB64: bytesToB64(hash),
    createdAt: new Date().toISOString()
  };
  setUsers(users);
}

async function verifyUser(username, password) {
  const users = getUsers();
  const u = users[username];
  if (!u) return false;
  const salt = b64ToBytes(u.saltB64);
  const hash = await pbkdf2Hash(password, salt);
  return bytesToB64(hash) === u.hashB64;
}

// ---------- App State ----------
let currentUser = null;
let chart = null;

// ---------- Tabs ----------
function setTab(name) {
  const p = $("practiceTab");
  const m = $("meetTab");
  const bp = $("tabPractice");
  const bm = $("tabMeet");

  if (name === "meet") {
    p.classList.add("hidden");
    m.classList.remove("hidden");
    bp.classList.remove("active");
    bm.classList.add("active");
    renderMeet();
  } else {
    m.classList.add("hidden");
    p.classList.remove("hidden");
    bm.classList.remove("active");
    bp.classList.add("active");
    renderRunsTable();
    renderChart();
    renderPracticeSummary();
  }
}

// ---------- Time averaging ----------
function avgOfTimes(t1, t2, t3) {
  const arr = [t1, t2, t3]
    .map(Number)
    .filter(v => Number.isFinite(v) && v >= 0);
  if (!arr.length) return 0;
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}

// ---------- Scoring (2026 Div B) ----------
function computeScore(inp) {
  const base = 100;

  const failed = !!inp.failedRun;
  const distCm = failed ? 2500 : num(inp.vehicleDistanceCm);

  const timeAvg = failed ? 0 : avgOfTimes(inp.time1, inp.time2, inp.time3);

  const distanceScore = 2.0 * distCm;
  const timeScore = timeAvg;

  const bucket = inp.bucketBonus ? -100 : 0;
  const cv = inp.competitionViolationPoints ? 150 : 0;
  const conv = inp.constructionViolationPoints ? 300 : 0;

  const total = base + distanceScore + timeScore + bucket + cv + conv;

  return {
    total: round2(total),
    timeAvg: round2(timeAvg),
    breakdown: {
      distCm: round2(distCm),
      distanceScore: round2(distanceScore),
      timeAvg: round2(timeAvg),
      bucket,
      penalties: cv + conv,
      failed
    }
  };
}

// ---------- Timers (two independent timers) ----------
function createTimer(prefix) {
  // prefix: "p" or "m"
  let msLeft = 8 * 60 * 1000;
  let interval = null;
  let running = false;

  function fmtMMSS(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  function updateUI() {
    $(`${prefix}TimerDisplay`).textContent = fmtMMSS(msLeft);
    $(`${prefix}TimerState`).textContent = running ? "Running" : "Paused/Ready";
  }

  function stop() {
    running = false;
    if (interval) clearInterval(interval);
    interval = null;
    updateUI();
  }

  function start() {
    if (running) return;
    running = true;
    let last = performance.now();
    interval = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      msLeft -= dt;
      if (msLeft <= 0) {
        msLeft = 0;
        stop();
        $(`${prefix}TimerState`).textContent = "Time!";
      }
      updateUI();
    }, 100);
    updateUI();
  }

  function pause() { if (running) stop(); }
  function resume() { if (!running && msLeft > 0) start(); }
  function restart() {
    stop();
    msLeft = 8 * 60 * 1000;
    $(`${prefix}TimerState`).textContent = "Ready";
    updateUI();
  }

  updateUI();
  return { start, pause, resume, restart, updateUI };
}

let pTimer, mTimer;

// ---------- Practice: runs ----------
function getUserRuns(user) { return getRuns().filter(r => r.user === user); }

function readPracticeForm() {
  return {
    targetDistanceM: num($("targetDistanceM").value),
    vehicleDistanceCm: num($("vehicleDistanceCm").value),

    time1: $("runTimeS1").value,
    time2: $("runTimeS2").value,
    time3: $("runTimeS3").value,

    carAngleDeg: num($("carAngleDeg").value),
    dialTurns: num($("dialTurns").value),
    winds: num($("winds").value),

    bucketBonus: $("bucketBonus").checked,
    failedRun: $("failedRun").checked,

    competitionViolationPoints: $("competitionViolation").value === "150",
    constructionViolationPoints: $("constructionViolation").value === "300",

    notes: $("notes").value.trim()
  };
}

function updateScorePreview() {
  const inp = readPracticeForm();
  const sc = computeScore(inp);
  $("scoreOut").textContent = sc.total.toFixed(2);
  $("scoreBreakdown").textContent =
    `Avg time used: ${sc.timeAvg.toFixed(2)}s • 100 + (2.0×${sc.breakdown.distCm}=${sc.breakdown.distanceScore}) + ${sc.breakdown.timeAvg} + (${sc.breakdown.bucket}) + penalties(${sc.breakdown.penalties})`
    + (sc.breakdown.failed ? " [FAILED]" : "");
}

function saveRun() {
  if (!currentUser) return;

  const inp = readPracticeForm();
  const sc = computeScore(inp);

  const run = {
    id: uid(),
    user: currentUser,
    createdAt: new Date().toISOString(),

    targetDistanceM: inp.targetDistanceM,
    vehicleDistanceCm: inp.failedRun ? 2500 : inp.vehicleDistanceCm,

    time1: inp.time1 || "",
    time2: inp.time2 || "",
    time3: inp.time3 || "",
    timeAvg: sc.timeAvg,

    bucketBonus: inp.bucketBonus,
    competitionViolation: inp.competitionViolationPoints,
    constructionViolation: inp.constructionViolationPoints,
    failedRun: inp.failedRun,

    carAngleDeg: inp.carAngleDeg,
    dialTurns: inp.dialTurns,
    winds: inp.winds,

    score: sc.total,
    notes: inp.notes
  };

  const all = getRuns();
  all.push(run);
  setRuns(all);

  showMsg($("runMsg"), `Saved. Score: ${run.score.toFixed(2)} (avg time ${run.timeAvg.toFixed(2)}s)`);
  renderRunsTable();
  renderChart();
  renderPracticeSummary();
}

function deleteRun(runId) {
  const ok = confirm("Delete this run?");
  if (!ok) return;
  setRuns(getRuns().filter(r => r.id !== runId));
  renderRunsTable();
  renderChart();
  renderPracticeSummary();
}

function clearMyRuns() {
  const ok = confirm("Delete ALL your saved runs on this device?");
  if (!ok) return;
  setRuns(getRuns().filter(r => r.user !== currentUser));
  showMsg($("runMsg"), "Cleared your runs.");
  renderRunsTable();
  renderChart();
  renderPracticeSummary();
}

// ---------- CSV helpers ----------
function toCSV(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [];
  lines.push(headers.map(esc).join(","));
  for (const row of rows) lines.push(headers.map(h => esc(row[h])).join(","));
  return lines.join("\n");
}

function download(filename, content, mime="text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportRunsCSV() {
  const runs = getUserRuns(currentUser).slice().sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  const headers = [
    "id","user","createdAt",
    "targetDistanceM","vehicleDistanceCm",
    "time1","time2","time3","timeAvg",
    "bucketBonus","competitionViolation","constructionViolation","failedRun",
    "carAngleDeg","dialTurns","winds",
    "score","notes"
  ];
  download(`scrambler_runs_${currentUser}.csv`, toCSV(runs, headers), "text/csv");
}

// ---------- Chart ----------
function buildChartData(runs) {
  const sorted = runs.slice().sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  const mode = $("chartMode").value;

  if (mode === "scoreVsDistance") {
    return {
      type: "scatter",
      labels: [],
      datasets: [{
        label: "Score vs Distance (cm)",
        data: sorted.map(r => ({ x: Number(r.vehicleDistanceCm), y: Number(r.score) }))
      }]
    };
  }
  return {
    type: "line",
    labels: sorted.map(r => new Date(r.createdAt).toLocaleString()),
    datasets: [{
      label: "Score over time",
      data: sorted.map(r => Number(r.score)),
      tension: 0.15
    }]
  };
}

function renderChart() {
  const runs = getUserRuns(currentUser);
  const ctx = $("chart").getContext("2d");
  const built = buildChartData(runs);

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: built.type,
    data: { labels: built.labels, datasets: built.datasets },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: built.type === "scatter"
        ? {
            x: { title: { display: true, text: "Vehicle Distance (cm)" } },
            y: { title: { display: true, text: "Run Score (lower is better)" } }
          }
        : {
            x: { ticks: { autoSkip: true, maxTicksLimit: 8 } },
            y: { title: { display: true, text: "Run Score (lower is better)" } }
          }
    }
  });
}

function exportChartCSV() {
  const runs = getUserRuns(currentUser).slice().sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  const mode = $("chartMode").value;

  let rows, headers;
  if (mode === "scoreVsDistance") {
    headers = ["createdAt","vehicleDistanceCm","score"];
    rows = runs.map(r => ({ createdAt: r.createdAt, vehicleDistanceCm: r.vehicleDistanceCm, score: r.score }));
  } else {
    headers = ["createdAt","score"];
    rows = runs.map(r => ({ createdAt: r.createdAt, score: r.score }));
  }
  download(`scrambler_chart_${mode}_${currentUser}.csv`, toCSV(rows, headers), "text/csv");
}

// ---------- Runs table ----------
function renderRunsTable() {
  const tbody = $("runsTable").querySelector("tbody");
  tbody.innerHTML = "";

  const runs = getUserRuns(currentUser).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt));

  for (const r of runs) {
    const tr = document.createElement("tr");
    const dateStr = new Date(r.createdAt).toLocaleString();

    const cells = [
      dateStr,
      r.targetDistanceM || "",
      r.vehicleDistanceCm,
      r.time1 ?? "", r.time2 ?? "", r.time3 ?? "",
      Number(r.timeAvg ?? 0).toFixed(2),
      r.bucketBonus ? "Y" : "N",
      r.competitionViolation ? "Y" : "N",
      r.constructionViolation ? "Y" : "N",
      r.failedRun ? "Y" : "N",
      r.carAngleDeg || "",
      r.dialTurns || "",
      r.winds || "",
      Number(r.score).toFixed(2),
      r.notes || ""
    ];

    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }

    const tdDel = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Delete";
    btn.addEventListener("click", () => deleteRun(r.id));
    tdDel.appendChild(btn);
    tr.appendChild(tdDel);

    tbody.appendChild(tr);
  }
}

// ---------- Practice Summary ----------
function approxEq(a,b,t) { return Math.abs(a-b) <= t; }
function trackKey(m) {
  const mm = Number(m);
  if (!Number.isFinite(mm) || mm === 0) return "(blank)";
  return mm.toFixed(2);
}
function setupKey(r) {
  const a = Number(r.carAngleDeg || 0).toFixed(1);
  const t = Number(r.dialTurns || 0).toFixed(2);
  const w = Number(r.winds || 0).toFixed(0);
  return `${a}° | ${t} turns | ${w} winds`;
}

function renderPracticeSummary() {
  const tbody = $("practiceTable").querySelector("tbody");
  tbody.innerHTML = "";
  const msg = $("practiceMsg");

  const targetStr = $("filterTrackM").value.trim();
  const tolStr = $("filterToleranceM").value.trim();
  const tol = tolStr ? num(tolStr) : null;

  let runs = getUserRuns(currentUser);

  if (targetStr) {
    const t = num(targetStr);
    if (tol !== null && tol > 0) runs = runs.filter(r => Number.isFinite(r.targetDistanceM) && approxEq(num(r.targetDistanceM), t, tol));
    else runs = runs.filter(r => Number.isFinite(r.targetDistanceM) && approxEq(num(r.targetDistanceM), t, 0.005));
  }

  if (!runs.length) {
    showMsg(msg, "No runs match this filter.");
    window.__practiceSummary = [];
    return;
  }
  showMsg(msg, `Showing ${runs.length} run(s).`);

  const byTrack = new Map();
  for (const r of runs) {
    const k = trackKey(r.targetDistanceM);
    if (!byTrack.has(k)) byTrack.set(k, []);
    byTrack.get(k).push(r);
  }

  const keys = [...byTrack.keys()].sort((a,b) => {
    if (a === "(blank)") return 1;
    if (b === "(blank)") return -1;
    return Number(a) - Number(b);
  });

  const summary = [];

  for (const k of keys) {
    const rs = byTrack.get(k);
    const scores = rs.map(x => Number(x.score)).filter(Number.isFinite);
    const n = scores.length;
    const avg = n ? scores.reduce((p,c)=>p+c,0)/n : NaN;
    const best = n ? Math.min(...scores) : NaN;

    const bySetup = new Map();
    for (const r of rs) {
      const sk = setupKey(r);
      if (!bySetup.has(sk)) bySetup.set(sk, []);
      bySetup.get(sk).push(r);
    }

    let bestSetupAvg = "", bestAvgVal = Infinity;
    let bestSetupSingle = "", bestSingleVal = Infinity;

    for (const [sk, sRuns] of bySetup.entries()) {
      const ss = sRuns.map(x => Number(x.score)).filter(Number.isFinite);
      if (!ss.length) continue;
      const sAvg = ss.reduce((p,c)=>p+c,0)/ss.length;
      const sBest = Math.min(...ss);

      if (sAvg < bestAvgVal) {
        bestAvgVal = sAvg;
        bestSetupAvg = `${sk} (avg ${round2(sAvg).toFixed(2)}; n=${ss.length})`;
      }
      if (sBest < bestSingleVal) {
        bestSingleVal = sBest;
        bestSetupSingle = `${sk} (best ${round2(sBest).toFixed(2)})`;
      }
    }

    const tr = document.createElement("tr");
    const cells = [
      k,
      n,
      Number.isFinite(avg) ? round2(avg).toFixed(2) : "",
      Number.isFinite(best) ? round2(best).toFixed(2) : "",
      bestSetupAvg,
      bestSetupSingle
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);

    summary.push({
      trackGroupM: k,
      runsCount: n,
      avgScore: Number.isFinite(avg) ? round2(avg) : "",
      bestScore: Number.isFinite(best) ? round2(best) : "",
      bestSetupByAvg: bestSetupAvg,
      bestSetupBySingle: bestSetupSingle
    });
  }

  window.__practiceSummary = summary;
}

function exportPracticeSummaryCSV() {
  const rows = window.__practiceSummary || [];
  if (!rows.length) return showMsg($("practiceMsg"), "Nothing to export yet. Click Apply first.", true);
  download(`scrambler_practice_summary_${currentUser}.csv`, toCSV(rows, Object.keys(rows[0])), "text/csv");
}

// ---------- Meet ----------
function getMeetRows(user) {
  const all = getMeetAll();
  return all[user] || [];
}
function setMeetRows(user, rows) {
  const all = getMeetAll();
  all[user] = rows;
  setMeetAll(all);
}

function meetRunScore(run) {
  const sc = computeScore(run);
  return { score: sc.total, timeAvg: sc.timeAvg };
}

function renderMeet() {
  const tbody = $("meetTable").querySelector("tbody");
  tbody.innerHTML = "";
  const rows = getMeetRows(currentUser);

  for (const row of rows) {
    const tr = document.createElement("tr");

    const r1 = meetRunScore(row.run1);
    const r2 = meetRunScore(row.run2);

    const bestOf2 = Math.min(r1.score, r2.score);
    const final = bestOf2 + (row.notImpounded ? 5000 : 0);

    // helpers to make inputs
    const makeNum = (val, cls, onChange) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "0.01";
      inp.className = cls || "";
      inp.value = val ?? "";
      inp.addEventListener("input", () => onChange(inp.value));
      return inp;
    };
    const makeChk = (checked, onChange) => {
      const inp = document.createElement("input");
      inp.type = "checkbox";
      inp.checked = !!checked;
      inp.addEventListener("change", () => onChange(inp.checked));
      return inp;
    };

    // Team
    const tdTeam = document.createElement("td");
    const teamIn = document.createElement("input");
    teamIn.value = row.team || "";
    teamIn.placeholder = "Team";
    teamIn.addEventListener("input", () => { row.team = teamIn.value; setMeetRows(currentUser, rows); });
    tdTeam.appendChild(teamIn);
    tr.appendChild(tdTeam);

    function addRunCells(runObj, computed) {
      // Dist
      let td = document.createElement("td");
      td.appendChild(makeNum(runObj.vehicleDistanceCm, "mini", v => { runObj.vehicleDistanceCm = v; setMeetRows(currentUser, rows); renderMeet(); }));
      tr.appendChild(td);

      // t1,t2,t3
      ["time1","time2","time3"].forEach((k) => {
        td = document.createElement("td");
        td.appendChild(makeNum(runObj[k], "micro", v => { runObj[k] = v; setMeetRows(currentUser, rows); renderMeet(); }));
        tr.appendChild(td);
      });

      // Avg
      td = document.createElement("td");
      td.textContent = computed.timeAvg.toFixed(2);
      tr.appendChild(td);

      // Bucket
      td = document.createElement("td");
      td.appendChild(makeChk(runObj.bucketBonus, v => { runObj.bucketBonus = v; setMeetRows(currentUser, rows); renderMeet(); }));
      tr.appendChild(td);

      // CV
      td = document.createElement("td");
      td.appendChild(makeChk(runObj.competitionViolationPoints, v => { runObj.competitionViolationPoints = v; setMeetRows(currentUser, rows); renderMeet(); }));
      tr.appendChild(td);

      // ConV
      td = document.createElement("td");
      td.appendChild(makeChk(runObj.constructionViolationPoints, v => { runObj.constructionViolationPoints = v; setMeetRows(currentUser, rows); renderMeet(); }));
      tr.appendChild(td);

      // Score
      td = document.createElement("td");
      td.textContent = computed.score.toFixed(2);
      tr.appendChild(td);
    }

    addRunCells(row.run1, r1);
    addRunCells(row.run2, r2);

    // Best-of-2
    let td = document.createElement("td");
    td.textContent = bestOf2.toFixed(2);
    tr.appendChild(td);

    // Not impounded
    td = document.createElement("td");
    td.appendChild(makeChk(row.notImpounded, v => { row.notImpounded = v; setMeetRows(currentUser, rows); renderMeet(); }));
    tr.appendChild(td);

    // Final
    td = document.createElement("td");
    td.textContent = final.toFixed(2);
    tr.appendChild(td);

    // Remove
    td = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => {
      const idx = rows.findIndex(r => r.id === row.id);
      if (idx >= 0) rows.splice(idx, 1);
      setMeetRows(currentUser, rows);
      renderMeet();
    });
    td.appendChild(btn);
    tr.appendChild(td);

    tbody.appendChild(tr);
  }
}

function addMeetTeam() {
  const rows = getMeetRows(currentUser);
  rows.push({
    id: uid(),
    team: "",
    notImpounded: false,
    run1: {
      vehicleDistanceCm: "",
      time1: "", time2: "", time3: "",
      bucketBonus: false,
      failedRun: false, // you can add a column for this later if you want
      competitionViolationPoints: false,
      constructionViolationPoints: false
    },
    run2: {
      vehicleDistanceCm: "",
      time1: "", time2: "", time3: "",
      bucketBonus: false,
      failedRun: false,
      competitionViolationPoints: false,
      constructionViolationPoints: false
    }
  });
  setMeetRows(currentUser, rows);
  renderMeet();
  showMsg($("meetMsg"), "Added team row.");
}

function clearMeet() {
  const ok = confirm("Clear the meet table for this user on this device?");
  if (!ok) return;
  setMeetRows(currentUser, []);
  renderMeet();
  showMsg($("meetMsg"), "Cleared meet table.");
}

function exportMeetCSV() {
  const rows = getMeetRows(currentUser);

  const out = rows.map(row => {
    const r1 = computeScore(row.run1);
    const r2 = computeScore(row.run2);
    const best = Math.min(r1.total, r2.total);
    const final = best + (row.notImpounded ? 5000 : 0);

    return {
      team: row.team || "",
      notImpounded: !!row.notImpounded,

      run1_distCm: row.run1.vehicleDistanceCm ?? "",
      run1_t1: row.run1.time1 ?? "",
      run1_t2: row.run1.time2 ?? "",
      run1_t3: row.run1.time3 ?? "",
      run1_timeAvg: r1.timeAvg,
      run1_bucket: !!row.run1.bucketBonus,
      run1_cv: !!row.run1.competitionViolationPoints,
      run1_conv: !!row.run1.constructionViolationPoints,
      run1_score: r1.total,

      run2_distCm: row.run2.vehicleDistanceCm ?? "",
      run2_t1: row.run2.time1 ?? "",
      run2_t2: row.run2.time2 ?? "",
      run2_t3: row.run2.time3 ?? "",
      run2_timeAvg: r2.timeAvg,
      run2_bucket: !!row.run2.bucketBonus,
      run2_cv: !!row.run2.competitionViolationPoints,
      run2_conv: !!row.run2.constructionViolationPoints,
      run2_score: r2.total,

      bestOf2: best,
      finalMeetScore: final
    };
  });

  const headers = Object.keys(out[0] || { team: "" });
  download(`scrambler_meet_${currentUser}.csv`, toCSV(out, headers), "text/csv");
}

// ---------- Auth UI ----------
function setAuthedUI(user) {
  currentUser = user;
  $("who").textContent = user;
  $("authCard").classList.add("hidden");
  $("app").classList.remove("hidden");

  setTab("practice");
  renderRunsTable();
  renderChart();
  renderPracticeSummary();
  renderMeet();
}

function setLoggedOutUI() {
  currentUser = null;
  $("authCard").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("password").value = "";
  $("authMsg").textContent = "";
}

// ---------- Wire ----------
function wire() {
  // Timers
  pTimer = createTimer("p");
  mTimer = createTimer("m");

  $("pTimerStart").addEventListener("click", pTimer.start);
  $("pTimerPause").addEventListener("click", pTimer.pause);
  $("pTimerResume").addEventListener("click", pTimer.resume);
  $("pTimerRestart").addEventListener("click", pTimer.restart);

  $("mTimerStart").addEventListener("click", mTimer.start);
  $("mTimerPause").addEventListener("click", mTimer.pause);
  $("mTimerResume").addEventListener("click", mTimer.resume);
  $("mTimerRestart").addEventListener("click", mTimer.restart);

  // Tabs
  $("tabPractice").addEventListener("click", () => setTab("practice"));
  $("tabMeet").addEventListener("click", () => setTab("meet"));

  // Auth
  $("btnSignup").addEventListener("click", async () => {
    const username = $("username").value.trim();
    const password = $("password").value;
    if (username.length < 3) return showMsg($("authMsg"), "Username must be at least 3 characters.", true);
    if (password.length < 6) return showMsg($("authMsg"), "Password must be at least 6 characters.", true);

    try {
      await createUser(username, password);
      setSession(username);
      showMsg($("authMsg"), "Account created. Logged in.");
      setAuthedUI(username);
    } catch (e) {
      showMsg($("authMsg"), e.message || "Could not create account.", true);
    }
  });

  $("btnLogin").addEventListener("click", async () => {
    const username = $("username").value.trim();
    const password = $("password").value;
    if (!username || !password) return showMsg($("authMsg"), "Enter username and password.", true);

    const ok = await verifyUser(username, password);
    if (!ok) return showMsg($("authMsg"), "Login failed.", true);

    setSession(username);
    showMsg($("authMsg"), "Logged in.");
    setAuthedUI(username);
  });

  $("btnLogout").addEventListener("click", () => {
    clearSession();
    setLoggedOutUI();
  });

  // Practice
  $("btnCalc").addEventListener("click", () => { $("runMsg").textContent = ""; updateScorePreview(); });
  $("btnSave").addEventListener("click", () => { $("runMsg").textContent = ""; updateScorePreview(); saveRun(); });

  [
    "vehicleDistanceCm",
    "runTimeS1","runTimeS2","runTimeS3",
    "bucketBonus","failedRun",
    "competitionViolation","constructionViolation"
  ].forEach(id => {
    $(id).addEventListener("input", updateScorePreview);
    $(id).addEventListener("change", updateScorePreview);
  });

  $("btnExportRuns").addEventListener("click", exportRunsCSV);
  $("btnClearRuns").addEventListener("click", clearMyRuns);

  $("chartMode").addEventListener("change", renderChart);
  $("btnExportChart").addEventListener("click", exportChartCSV);

  $("btnApplyPractice").addEventListener("click", renderPracticeSummary);
  $("btnExportPractice").addEventListener("click", exportPracticeSummaryCSV);

  // Meet
  $("btnAddTeam").addEventListener("click", addMeetTeam);
  $("btnExportMeet").addEventListener("click", exportMeetCSV);
  $("btnClearMeet").addEventListener("click", clearMeet);

  // Restore session
  const sess = getSession();
  if (sess?.user) setAuthedUI(sess.user);
  else setLoggedOutUI();

  updateScorePreview();
}

wire();
