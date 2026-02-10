// Exam Simulator – static (no server)
// Loads questions.json, draws random questions, scores in-browser.

const STORAGE_KEY = "exam_simulator_static_v2";
const LEADERBOARD_KEY = "exam_simulator_leaderboard_v1";
const DEFAULT_QUESTION_COUNT = 90;
const DEFAULT_TIMER_MINUTES = 225;

let bank = null;     // {questions:[...]}
let attempt = null;  // {id, createdAt, questionIds:[...], answers:{qid:'A'|'B'...}, submitted:boolean, results?}
let currentIndex = 0;
let timerIntervalId = null;

const $ = (id) => document.getElementById(id);

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadSavedAttempt() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (e) {
    return null;
  }
}

function saveAttempt() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(attempt));
  } catch (e) {
    // ignore
  }
}

function clearAttempt() {
  localStorage.removeItem(STORAGE_KEY);
  stopTimer();
  attempt = null;
}


function loadLeaderboard() {
  try {
    const raw = localStorage.getItem(LEADERBOARD_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveLeaderboard(entries) {
  try {
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(entries));
  } catch (e) {
    // ignore
  }
}

function formatDuration(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function isDefaultMode(questionCount, timerEnabled, timerMinutes) {
  return questionCount === DEFAULT_QUESTION_COUNT && timerEnabled && timerMinutes === DEFAULT_TIMER_MINUTES;
}

function getTimerSettings() {
  const enabled = $("timerEnabled").checked;
  const raw = parseInt($("timerMinutes").value, 10);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMER_MINUTES;
  return { enabled, minutes };
}

function updateTimerSummary() {
  const { enabled, minutes } = getTimerSettings();
  $("timerSummary").textContent = enabled ? `${minutes} min` : "off";
}

function updateNicknameHelp() {
  const count = getSelectedQuestionCount();
  const { enabled, minutes } = getTimerSettings();
  const eligible = isDefaultMode(count, enabled, minutes);
  $("nicknameHelp").textContent = eligible
    ? "Eligible for leaderboard (default mode)."
    : "Only used for default mode (90 questions + 225-minute timer).";
}

function renderLeaderboard() {
  const entries = loadLeaderboard();
  const list = $("leaderboardList");
  if (!entries.length) {
    list.textContent = "No entries yet.";
    return;
  }

  const rows = entries
    .sort((a, b) => {
      if (b.correct !== a.correct) return b.correct - a.correct;
      if (a.elapsedSeconds !== b.elapsedSeconds) return a.elapsedSeconds - b.elapsedSeconds;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, 10)
    .map((e, idx) => `${idx + 1}. ${e.nickname} — ${e.correct}/${e.total} in ${formatDuration(e.elapsedSeconds)}`);

  list.innerHTML = rows.map(r => `<div>${r}</div>`).join("");
}

function stopTimer() {
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
}

function updateTimerInfo() {
  if (!attempt || !attempt.timerEnabled) {
    $("timerInfo").textContent = "Timer: off";
    return;
  }
  const remaining = Math.max(0, (attempt.timerEndsAt || 0) - Date.now());
  const remainingSeconds = Math.ceil(remaining / 1000);
  $("timerInfo").textContent = `Timer left: ${formatDuration(remainingSeconds)}`;
}

function startTimerIfNeeded() {
  stopTimer();
  if (!attempt || !attempt.timerEnabled || attempt.submitted) return;

  updateTimerInfo();
  timerIntervalId = setInterval(() => {
    const remaining = (attempt.timerEndsAt || 0) - Date.now();
    if (remaining <= 0) {
      stopTimer();
      updateTimerInfo();
      scoreAttempt();
      renderExam();
      renderResults();
      show("results");
      return;
    }
    updateTimerInfo();
  }, 1000);
}

function maybeAddLeaderboardEntry() {
  if (!attempt || !attempt.summary) return;
  if (!attempt.isDefaultMode) return;
  if (!attempt.nickname) return;

  const entries = loadLeaderboard();
  entries.push({
    nickname: attempt.nickname,
    correct: attempt.summary.correct,
    total: attempt.summary.total,
    elapsedSeconds: attempt.summary.elapsedSeconds || 0,
    createdAt: new Date().toISOString()
  });
  saveLeaderboard(entries);
  renderLeaderboard();
}

function show(sectionId) {
  ["home","exam","leaderboardTab","results"].forEach(id => {
    $(id).style.display = (id === sectionId) ? "" : "none";
  });
}

function setBankInfo() {
  const info = $("questionBankInfo");
  if (!bank) { info.textContent = "Loading question bank…"; return; }
  info.textContent = `${bank.question_count} questions loaded`;
  const maxCount = Math.max(1, bank.question_count);
  const input = $("questionCount");
  input.max = String(maxCount);
  if (!input.value) {
    input.value = String(Math.min(DEFAULT_QUESTION_COUNT, maxCount));
  } else {
    const current = parseInt(input.value, 10);
    if (!Number.isFinite(current) || current < 1) {
      input.value = "1";
    } else if (current > maxCount) {
      input.value = String(maxCount);
    }
  }
  $("questionCountHelp").textContent = `Max ${maxCount}`;
  updateQuestionCountText();
}

function getSelectedQuestionCount() {
  const input = $("questionCount");
  const raw = parseInt(input.value, 10);
  const max = bank ? bank.question_count : DEFAULT_QUESTION_COUNT;
  const safeMax = Math.max(1, max);
  if (!Number.isFinite(raw)) return Math.min(DEFAULT_QUESTION_COUNT, safeMax);
  return Math.min(Math.max(raw, 1), safeMax);
}

function updateQuestionCountText() {
  const count = getSelectedQuestionCount();
  $("questionCountText").textContent = String(count);
}

function pickQuestions(count) {
  const all = bank.questions.map(q => q.id);
  shuffle(all);
  return all.slice(0, count);
}

function startNewAttempt() {
  const count = getSelectedQuestionCount();
  const timer = getTimerSettings();
  const nickname = $("nickname").value.trim();
  const eligibleForLeaderboard = isDefaultMode(count, timer.enabled, timer.minutes);
  const now = Date.now();

  attempt = {
    id: uid(),
    createdAt: new Date().toISOString(),
    questionIds: pickQuestions(count),
    answers: {},         // { [qid]: 'A'|'B'|'C'|'D' }
    submitted: false,
    results: null,
    questionCount: count,
    startedAt: now,
    timerEnabled: timer.enabled,
    timerMinutes: timer.minutes,
    timerEndsAt: timer.enabled ? now + timer.minutes * 60 * 1000 : null,
    nickname: eligibleForLeaderboard ? nickname : "",
    isDefaultMode: eligibleForLeaderboard
  };
  currentIndex = 0;
  saveAttempt();
  renderExam();
  startTimerIfNeeded();
  show("exam");
}

function getQuestionById(qid) {
  return bank.questions.find(q => q.id === qid);
}

function answeredCount() {
  return Object.keys(attempt.answers).length;
}

function renderJumpBar() {
  const bar = $("jumpBar");
  bar.innerHTML = "";
  attempt.questionIds.forEach((qid, idx) => {
    const btn = document.createElement("button");
    btn.className = "jumpBtn secondary";
    btn.textContent = String(idx + 1);
    const ans = attempt.answers[qid];
    if (attempt.submitted && attempt.results) {
      const r = attempt.results[qid];
      if (r.status === "correct") btn.classList.add("answered");
      else if (r.status === "wrong") btn.classList.add("wrong");
      else btn.classList.add("unanswered");
    } else {
      if (ans) btn.classList.add("answered");
      else btn.classList.add("unanswered");
    }
    if (idx === currentIndex) btn.classList.add("current");
    btn.onclick = () => { currentIndex = idx; renderExam(); };
    bar.appendChild(btn);
  });
}

function renderExam() {
  const total = attempt.questionIds.length;
  $("attemptInfo").textContent = `${attempt.id.slice(0,8)} • ${answeredCount()}/${total} answered`;
  updateTimerInfo();
  $("progressText").textContent = `Question ${currentIndex + 1} of ${total}`;

  renderJumpBar();

  const qid = attempt.questionIds[currentIndex];
  const q = getQuestionById(qid);
  const your = attempt.answers[qid] || null;

  const card = $("questionCard");
  card.innerHTML = "";

  const top = document.createElement("div");
  top.className = "qTitle";
  top.innerHTML = `
    <div class="qNum">#${currentIndex + 1}</div>
    <div class="muted small mono">${q.exam} • Q${q.number ?? ""} • ID ${q.id}</div>
    <div class="qMeta muted small">${attempt.submitted ? "Submitted" : "In progress"}</div>
  `;
  card.appendChild(top);

  const text = document.createElement("div");
  text.className = "qText";
  text.textContent = q.text;
  card.appendChild(text);

  const choices = document.createElement("div");
  choices.className = "choices";

  q.choices.forEach(ch => {
    const row = document.createElement("label");
    row.className = "choice";
    const disabled = attempt.submitted ? "disabled" : "";
    const checked = (your === ch.label) ? "checked" : "";

    // Post-submit coloring
    if (attempt.submitted) {
      if (ch.is_correct) row.classList.add("correct");
      if (your && your === ch.label && !ch.is_correct) row.classList.add("yoursWrong");
    }

    row.innerHTML = `
      <input type="radio" name="q_${qid}" value="${ch.label}" ${checked} ${disabled} />
      <div class="lbl">${ch.label}</div>
      <div class="ctext"></div>
    `;
    row.querySelector(".ctext").textContent = ch.text;

    row.querySelector("input").addEventListener("change", (e) => {
      attempt.answers[qid] = e.target.value;
      saveAttempt();
      // update header/jumpbar quickly
      renderExam();
    });

    choices.appendChild(row);
  });

  card.appendChild(choices);

  $("prevBtn").disabled = (currentIndex === 0);
  $("nextBtn").disabled = (currentIndex === attempt.questionIds.length - 1);
}

function scoreAttempt() {
  const results = {}; // per qid: {status, correct, your}
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;

  attempt.questionIds.forEach(qid => {
    const q = getQuestionById(qid);
    const correctLabel = q.correct_label;
    const your = attempt.answers[qid] || null;
    let status = "unanswered";
    if (!your) {
      unanswered++;
    } else if (your === correctLabel) {
      status = "correct";
      correct++;
    } else {
      status = "wrong";
      wrong++;
    }
    results[qid] = { status, correct: correctLabel, your };
  });

  attempt.submitted = true;
  attempt.results = results;
  const now = Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((now - (attempt.startedAt || now)) / 1000));
  attempt.summary = { correct, wrong, unanswered, total: attempt.questionIds.length, elapsedSeconds };
  stopTimer();
  saveAttempt();
  maybeAddLeaderboardEntry();
}

function renderResults() {
  const s = attempt.summary;
  const elapsedText = s.elapsedSeconds != null ? `, time: ${formatDuration(s.elapsedSeconds)}` : "";
  $("scoreLine").textContent = `Score: ${s.correct} / ${s.total}  (wrong: ${s.wrong}, unanswered: ${s.unanswered}${elapsedText})`;
  $("newAttemptBtn").textContent = `New ${s.total}-question attempt`;

  const list = $("reviewList");
  list.innerHTML = "";

  const onlyWrong = $("showOnlyWrong").checked;

  attempt.questionIds.forEach((qid, idx) => {
    const q = getQuestionById(qid);
    const r = attempt.results[qid];

    if (onlyWrong && r.status === "correct") return;

    const item = document.createElement("div");
    item.className = "reviewItem";

    const badge = document.createElement("span");
    badge.className = "badge";
    if (r.status === "correct") { badge.classList.add("ok"); badge.textContent = "Correct"; }
    else if (r.status === "wrong") { badge.classList.add("bad"); badge.textContent = "Wrong"; }
    else { badge.classList.add("warn"); badge.textContent = "Unanswered"; }

    const top = document.createElement("div");
    top.className = "reviewTop";
    top.innerHTML = `<strong>#${idx + 1}</strong> <span class="muted small mono">${q.exam} • Q${q.number ?? ""} • ID ${q.id}</span>`;
    top.appendChild(badge);

    const qt = document.createElement("div");
    qt.className = "qText";
    qt.textContent = q.text;

    const ch = document.createElement("div");
    ch.className = "choices";

    q.choices.forEach(c => {
      const row = document.createElement("div");
      row.className = "choice";
      if (c.is_correct) row.classList.add("correct");
      if (r.your && r.your === c.label && !c.is_correct) row.classList.add("yoursWrong");

      row.innerHTML = `
        <div class="lbl">${c.label}</div>
        <div class="ctext"></div>
      `;
      row.querySelector(".ctext").textContent = c.text;
      ch.appendChild(row);
    });

    const note = document.createElement("div");
    note.className = "muted small";
    note.style.marginTop = "8px";
    note.textContent = `Your answer: ${r.your ?? "—"} • Correct answer: ${r.correct ?? "—"}`;

    item.appendChild(top);
    item.appendChild(qt);
    item.appendChild(ch);
    item.appendChild(note);

    list.appendChild(item);
  });
}

async function init() {
  // UI bindings
  $("startBtn").onclick = startNewAttempt;
  $("newAttemptBtn").onclick = () => { clearAttempt(); startNewAttempt(); };
  $("backHomeBtn").onclick = () => { stopTimer(); show("home"); };
  $("leaderboardTabBtn").onclick = () => { renderLeaderboard(); show("leaderboardTab"); };
  $("leaderboardBackBtn").onclick = () => { show("home"); };
  $("resumeBtn").onclick = () => { show("exam"); renderExam(); startTimerIfNeeded(); };
  $("resetBtn").onclick = () => { clearAttempt(); window.location.reload(); };
  $("questionCount").oninput = () => { updateQuestionCountText(); updateNicknameHelp(); };
  $("timerEnabled").onchange = () => { updateTimerSummary(); updateNicknameHelp(); };
  $("timerMinutes").oninput = () => { updateTimerSummary(); updateNicknameHelp(); };
  $("nickname").oninput = () => updateNicknameHelp();

  $("prevBtn").onclick = () => { currentIndex--; renderExam(); };
  $("nextBtn").onclick = () => { currentIndex++; renderExam(); };

  $("saveExitBtn").onclick = () => { saveAttempt(); stopTimer(); show("home"); };

  $("submitBtn").onclick = () => {
    // Simple guard: allow submit anytime
    scoreAttempt();
    renderExam(); // reflect colors in exam view
    renderResults();
    show("results");
  };

  $("showOnlyWrong").onchange = () => renderResults();

  // Load bank
  const res = await fetch("questions.json", { cache: "no-store" });
  bank = await res.json();
  setBankInfo();
  updateTimerSummary();
  updateNicknameHelp();
  renderLeaderboard();

  // Attempt state
  const saved = loadSavedAttempt();
  if (saved && saved.questionIds && saved.answers) {
    attempt = saved;
    $("questionCount").value = String(attempt.questionIds.length);
    $("timerEnabled").checked = !!attempt.timerEnabled;
    $("timerMinutes").value = String(attempt.timerMinutes || DEFAULT_TIMER_MINUTES);
    $("nickname").value = attempt.nickname || "";
    updateQuestionCountText();
    updateTimerSummary();
    updateNicknameHelp();
    $("resumeBtn").style.display = "";
    $("resetBtn").style.display = "";
    if (attempt.submitted) {
      renderResults();
      show("results");
    }
  }

  $("startBtn").disabled = false;
}

init();
