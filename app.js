// Exam Simulator – static (no server)
// Loads questions.json, draws 50 random questions, scores in-browser.

const STORAGE_KEY = "exam_simulator_static_v1";

let bank = null;     // {questions:[...]}
let attempt = null;  // {id, createdAt, questionIds:[...], answers:{qid:'A'|'B'...}, submitted:boolean, results?}
let currentIndex = 0;

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
  attempt = null;
}

function show(sectionId) {
  ["home","exam","results"].forEach(id => {
    $(id).style.display = (id === sectionId) ? "" : "none";
  });
}

function setBankInfo() {
  const info = $("questionBankInfo");
  if (!bank) { info.textContent = "Loading question bank…"; return; }
  info.textContent = `${bank.question_count} questions loaded`;
}

function pick50() {
  const all = bank.questions.map(q => q.id);
  shuffle(all);
  return all.slice(0, 50);
}

function startNewAttempt() {
  attempt = {
    id: uid(),
    createdAt: new Date().toISOString(),
    questionIds: pick50(),
    answers: {},         // { [qid]: 'A'|'B'|'C'|'D' }
    submitted: false,
    results: null
  };
  currentIndex = 0;
  saveAttempt();
  renderExam();
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
  $("attemptInfo").textContent = `${attempt.id.slice(0,8)} • ${answeredCount()}/50 answered`;
  $("progressText").textContent = `Question ${currentIndex + 1} of 50`;

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
  attempt.summary = { correct, wrong, unanswered, total: attempt.questionIds.length };
  saveAttempt();
}

function renderResults() {
  const s = attempt.summary;
  $("scoreLine").textContent = `Score: ${s.correct} / ${s.total}  (wrong: ${s.wrong}, unanswered: ${s.unanswered})`;

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
  $("backHomeBtn").onclick = () => { show("home"); };
  $("resumeBtn").onclick = () => { show("exam"); renderExam(); };
  $("resetBtn").onclick = () => { clearAttempt(); window.location.reload(); };

  $("prevBtn").onclick = () => { currentIndex--; renderExam(); };
  $("nextBtn").onclick = () => { currentIndex++; renderExam(); };

  $("saveExitBtn").onclick = () => { saveAttempt(); show("home"); };

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

  // Attempt state
  const saved = loadSavedAttempt();
  if (saved && saved.questionIds && saved.answers) {
    attempt = saved;
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
