// Exam Simulator – static (no server)
// Loads questions.json, draws random questions, scores in-browser.

const STORAGE_KEY = "exam_simulator_static_v2";
const LEADERBOARD_NAME_KEY = "exam_simulator_last_leaderboard_name";
const QUIZ_SOURCE_KEY = "quiz_source";
const DEFAULT_QUESTION_COUNT = 90;
const DEFAULT_TIMER_MINUTES = 150;
const LEGACY_SOURCE = "legacy";
const AI_SOURCE = "ai";
const MIXED_SOURCE = "mixed";
const EXAM_MODE = "exam";
const FEEDBACK_MODE = "feedback";
const FEEDBACK_NEXT_DELAY_MS = 900;

let bank = null;     // {questions:[...]}
let attempt = null;  // {id, createdAt, questionIds:[...], answers:{qid:'A'|'B'...}, submitted:boolean, results?}
let currentIndex = 0;
let timerIntervalId = null;

const SECTION_IDS = ["home", "exam", "leaderboardTab", "results"];
const VIEW_TRANSITION_MS = 145;
let isViewTransitioning = false;

const $ = (id) => document.getElementById(id);

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // ignore
  }
}

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}


function loadQuizSource() {
  const raw = safeStorageGet(QUIZ_SOURCE_KEY);
  if (raw === AI_SOURCE || raw === MIXED_SOURCE) return raw;
  return LEGACY_SOURCE;
}

function saveQuizSource(source) {
  safeStorageSet(QUIZ_SOURCE_KEY, source);
}

function getSelectedQuizSource() {
  const ai = $("quizSourceAi");
  const mixed = $("quizSourceMixed");
  if (mixed && mixed.checked) return MIXED_SOURCE;
  return ai && ai.checked ? AI_SOURCE : LEGACY_SOURCE;
}

function setSelectedQuizSource(source) {
  const legacyInput = $("quizSourceLegacy");
  const aiInput = $("quizSourceAi");
  const mixedInput = $("quizSourceMixed");
  if (legacyInput) legacyInput.checked = source === LEGACY_SOURCE;
  if (aiInput) aiInput.checked = source === AI_SOURCE;
  if (mixedInput) mixedInput.checked = source === MIXED_SOURCE;

}

function getSelectedQuizMode() {
  const feedbackModeInput = $("quizModeFeedback");
  return feedbackModeInput && feedbackModeInput.checked ? FEEDBACK_MODE : EXAM_MODE;
}

function toLegacyQuestion(aiItem, index) {
  const labels = ["A", "B", "C", "D"];
  const choices = Array.isArray(aiItem.choices) ? aiItem.choices.slice(0, 4) : [];
  return {
    id: aiItem.id || `ai_${String(index + 1).padStart(6, "0")}`,
    exam: "AI",
    number: index + 1,
    scenario_id: null,
    scenario_text: null,
    text: aiItem.question || "",
    choices: choices.map((choiceText, choiceIndex) => ({
      label: labels[choiceIndex],
      text: choiceText,
      is_correct: choiceIndex === aiItem.correct_index
    })),
    correct_label: labels[aiItem.correct_index] || null,
    source: aiItem.source || {}
  };
}

function normalizeBank(raw, sourceType) {
  if (sourceType === AI_SOURCE) {
    const items = Array.isArray(raw?.items) ? raw.items : [];
    const questions = items
      .filter(item => Array.isArray(item.choices) && item.choices.length === 4 && Number.isInteger(item.correct_index) && item.correct_index >= 0 && item.correct_index <= 3 && item.question)
      .map((item, idx) => toLegacyQuestion(item, idx));

    return {
      question_count: questions.length,
      questions
    };
  }

  if (raw && Array.isArray(raw.questions)) {
    return raw;
  }

  return { question_count: 0, questions: [] };
}

async function loadQuestionBank(sourceType) {
  if (sourceType === MIXED_SOURCE) {
    const [legacyBank, aiBank] = await Promise.all([
      loadQuestionBank(LEGACY_SOURCE),
      loadQuestionBank(AI_SOURCE).catch(() => ({ question_count: 0, questions: [] }))
    ]);

    const questions = [...legacyBank.questions, ...aiBank.questions];
    return {
      question_count: questions.length,
      questions
    };
  }

  const targetFile = sourceType === AI_SOURCE ? "ai_questions.json" : "questions.json";
  let response;
  try {
    response = await fetch(targetFile, { cache: "no-store" });
  } catch (error) {
    if (sourceType === AI_SOURCE) {
      throw new Error("Brak puli AI. Spróbuj później.");
    }
    throw error;
  }

  if (!response.ok) {
    if (sourceType === AI_SOURCE) {
      throw new Error("Brak puli AI. Spróbuj później.");
    }
    throw new Error(`Failed to load ${targetFile}`);
  }

  const json = await response.json();
  const normalized = normalizeBank(json, sourceType);

  if (sourceType === AI_SOURCE && normalized.question_count === 0) {
    throw new Error("Brak puli AI. Spróbuj później.");
  }

  return normalized;
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
    return normalizeAttemptState(parsed);
  } catch (e) {
    return null;
  }
}

function createDefaultFeedbackState(existingFeedback = null) {
  const source = existingFeedback && typeof existingFeedback === "object" ? existingFeedback : {};

  return {
    questionStartedAtByQid: source.questionStartedAtByQid && typeof source.questionStartedAtByQid === "object"
      ? source.questionStartedAtByQid
      : {},
    hintUsedByQid: source.hintUsedByQid && typeof source.hintUsedByQid === "object"
      ? source.hintUsedByQid
      : {},
    scoredQids: Array.isArray(source.scoredQids)
      ? source.scoredQids
      : [],
    evaluationByQid: source.evaluationByQid && typeof source.evaluationByQid === "object"
      ? source.evaluationByQid
      : {}
  };
}

function normalizeAttemptState(rawAttempt) {
  if (!rawAttempt || typeof rawAttempt !== "object") return null;

  const normalized = { ...rawAttempt };

  if (normalized.mode !== EXAM_MODE && normalized.mode !== FEEDBACK_MODE) {
    normalized.mode = EXAM_MODE;
  }

  normalized.points = Number.isFinite(Number(normalized.points)) ? Number(normalized.points) : 0;

  normalized.streak = Number.isFinite(Number(normalized.streak)) ? Number(normalized.streak) : 0;

  if (!Array.isArray(normalized.badges)) {
    normalized.badges = [];
  }

  normalized.feedback = createDefaultFeedbackState(normalized.feedback);

  return normalized;
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
  const timerEnabledEl = $("timerEnabled");
  const timerMinutesEl = $("timerMinutes");
  if (!timerEnabledEl || !timerMinutesEl) {
    return { enabled: true, minutes: DEFAULT_TIMER_MINUTES };
  }

  const enabled = timerEnabledEl.checked;
  const raw = parseInt(timerMinutesEl.value, 10);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMER_MINUTES;
  return { enabled, minutes };
}

function updateTimerSummary() {
  const { enabled } = getTimerSettings();
  const timerSummary = $("timerSummary");
  if (!timerSummary) return;
  timerSummary.textContent = enabled ? "minutes" : "off";
}


function leaderboardMode() {
  if (!attempt) return "unknown";
  const source = getSelectedQuizSource();
  const sourceLabel = source === AI_SOURCE ? "ai" : source === MIXED_SOURCE ? "mixed" : "legacy";
  const timerLabel = attempt.timerEnabled ? `${attempt.timerMinutes || DEFAULT_TIMER_MINUTES}m` : "off";
  return `${attempt.questionIds.length}q_${timerLabel}_${sourceLabel}`;
}

function getSavedLeaderboardName() {
  return safeStorageGet(LEADERBOARD_NAME_KEY) || "";
}

function saveLeaderboardName(name) {
  safeStorageSet(LEADERBOARD_NAME_KEY, name);
}

function renderListEntries(listEl, rows, formatter, emptyText) {
  if (!listEl) return;
  if (!rows.length) {
    listEl.textContent = emptyText;
    return;
  }
  listEl.innerHTML = rows.map(formatter).join("");
}

function safePercent(score, total, pct) {
  if (Number.isFinite(Number(pct))) return Number(pct);
  if (!Number.isFinite(Number(score)) || !Number.isFinite(Number(total)) || Number(total) <= 0) return 0;
  return (Number(score) / Number(total)) * 100;
}

function isNetworkCorsErrorMessage(message) {
  return typeof message === "string" && message.includes("network/CORS");
}

function globalLeaderboardFallbackMessage(error, action) {
  if (isNetworkCorsErrorMessage(error?.message)) {
    return `Couldn’t ${action} global leaderboard (network/CORS).`;
  }
  return `Couldn’t ${action} global leaderboard.`;
}

function formatGlobalLeaderboardRows(rows) {
  return rows.map((entry, idx) => {
    const pct = safePercent(entry.score, entry.total, entry.pct).toFixed(1);
    const duration = Number.isInteger(entry.duration_seconds) ? formatDuration(entry.duration_seconds) : "—";
    return `
      <div class="lbRow">
        <div class="lbPrimary">
          <span class="lbRank">#${idx + 1}</span>
          <span class="lbName">${entry.name}</span>
        </div>
        <div class="lbMeta">
          <span class="lbScore">${entry.score}/${entry.total}</span>
          <span class="lbPercent">${pct}%</span>
          <span class="lbDuration">${duration}</span>
        </div>
      </div>
    `;
  });
}

async function refreshGlobalLeaderboards() {
  const tabList = $("globalLeaderboardList");
  const resultsList = $("resultsGlobalLeaderboardList");
  const notice = $("globalLeaderboardNotice");

  if (!window.SupabaseLeaderboard || !window.SupabaseLeaderboard.isConfigured()) {
    if (notice) notice.textContent = "Global leaderboard not configured.";
    renderListEntries(tabList, [], () => "", "Global leaderboard unavailable.");
    renderListEntries(resultsList, [], () => "", "Global leaderboard unavailable.");
    return;
  }

  if (notice) notice.textContent = "";
  if (tabList) tabList.textContent = "Loading…";
  if (resultsList) resultsList.textContent = "Loading…";

  try {
    const rows = await window.SupabaseLeaderboard.fetchTopScores({ limit: 20 });
    const formatted = formatGlobalLeaderboardRows(rows);
    renderListEntries(tabList, formatted, r => r, "No global entries yet.");
    renderListEntries(resultsList, formatted, r => r, "No global entries yet.");
  } catch (error) {
    const text = globalLeaderboardFallbackMessage(error, "load");
    if (notice) notice.textContent = text;
    renderListEntries(tabList, [], () => "", text);
    renderListEntries(resultsList, [], () => "", text);
  }
}

async function saveResultToGlobalLeaderboard() {
  const msg = $("saveResultMessage");
  if (!attempt || !attempt.summary) return;

  if (!window.SupabaseLeaderboard || !window.SupabaseLeaderboard.isConfigured()) {
    msg.textContent = "Global leaderboard unavailable.";
    return;
  }

  const input = $("resultsName");
  const name = input.value.trim();
  if (name.length < 1 || name.length > 30) {
    msg.textContent = "Name must be between 1 and 30 characters.";
    return;
  }

  const payload = {
    name,
    score: attempt.summary.correct,
    total: attempt.summary.total,
    mode: leaderboardMode(),
    durationSeconds: attempt.summary.elapsedSeconds
  };

  msg.textContent = "Saving…";
  try {
    await window.SupabaseLeaderboard.submitScore(payload);
    saveLeaderboardName(name);
    msg.textContent = "Saved to global leaderboard.";
    refreshGlobalLeaderboards();
  } catch (error) {
    msg.textContent = globalLeaderboardFallbackMessage(error, "save to");
  }
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

function show(sectionId) {
  if (!SECTION_IDS.includes(sectionId) || isViewTransitioning) return;

  const nextSection = $(sectionId);
  const currentSectionId = SECTION_IDS.find(id => {
    const section = $(id);
    return section && window.getComputedStyle(section).display !== "none";
  });
  const currentSection = currentSectionId ? $(currentSectionId) : null;

  const isLeaderboardView = sectionId === "leaderboardTab";
  $("homeTabBtn").classList.toggle("active", !isLeaderboardView);
  $("leaderboardTabBtn").classList.toggle("active", isLeaderboardView);

  if (!nextSection || currentSection === nextSection) return;

  isViewTransitioning = true;

  if (currentSection) {
    currentSection.classList.remove("view-enter");
    currentSection.classList.add("view-exit");
  }

  window.setTimeout(() => {
    SECTION_IDS.forEach(id => {
      const section = $(id);
      if (!section) return;
      section.style.display = (id === sectionId) ? "" : "none";
      section.classList.remove("view-exit");
    });

    nextSection.classList.remove("view-exit");
    nextSection.classList.add("view-enter");

    let transitionDone = false;
    const finishTransition = () => {
      if (transitionDone) return;
      transitionDone = true;
      nextSection.classList.remove("view-enter");
      nextSection.removeEventListener("animationend", finishTransition);
      isViewTransitioning = false;
    };

    nextSection.addEventListener("animationend", finishTransition);
    window.setTimeout(finishTransition, 220);
  }, VIEW_TRANSITION_MS);
}

function setBankInfo(sourceType = LEGACY_SOURCE) {
  const info = $("questionBankInfo");
  if (!bank) { info.textContent = "Loading question bank…"; return; }
  info.textContent = "";
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
  const countText = $("questionCountText");
  if (countText) {
    countText.textContent = String(count);
  }
}

function isAiQuestion(question) {
  return question && question.exam === "AI";
}

function pickQuestions(count, sourceType) {
  const requested = Math.max(1, count);

  if (sourceType === MIXED_SOURCE) {
    const aiIds = bank.questions.filter(isAiQuestion).map(q => q.id);
    const legacyIds = bank.questions.filter(q => !isAiQuestion(q)).map(q => q.id);

    shuffle(aiIds);
    shuffle(legacyIds);

    const targetAi = Math.floor(requested / 2);
    const targetLegacy = requested - targetAi;

    const pickedAi = aiIds.slice(0, Math.min(targetAi, aiIds.length));
    const missingAi = targetAi - pickedAi.length;

    const legacyNeed = targetLegacy + Math.max(0, missingAi);
    const pickedLegacy = legacyIds.slice(0, Math.min(legacyNeed, legacyIds.length));

    const picked = [...pickedLegacy, ...pickedAi];

    if (picked.length < requested) {
      const used = new Set(picked);
      const aiOverflow = aiIds.filter(id => !used.has(id));
      picked.push(...aiOverflow.slice(0, requested - picked.length));
    }

    return shuffle(picked).slice(0, requested);
  }

  const all = bank.questions.map(q => q.id);
  shuffle(all);
  return all.slice(0, requested);
}

function startNewAttempt() {
  if (!bank || !Array.isArray(bank.questions) || bank.questions.length === 0) {
    return;
  }
  const count = getSelectedQuestionCount();
  const timer = getTimerSettings();
  const sourceType = getSelectedQuizSource();
  const mode = getSelectedQuizMode();
  const eligibleForLeaderboard = isDefaultMode(count, timer.enabled, timer.minutes);
  const now = Date.now();

  attempt = {
    id: uid(),
    createdAt: new Date().toISOString(),
    questionIds: pickQuestions(count, sourceType),
    answers: {},         // { [qid]: 'A'|'B'|'C'|'D' }
    submitted: false,
    results: null,
    questionCount: count,
    startedAt: now,
    timerEnabled: timer.enabled,
    timerMinutes: timer.minutes,
    timerEndsAt: timer.enabled ? now + timer.minutes * 60 * 1000 : null,
    nickname: "",
    isDefaultMode: eligibleForLeaderboard,
    mode,
    points: 0,
    streak: 0,
    badges: [],
    feedback: createDefaultFeedbackState()
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

function ensureFeedbackAttemptState() {
  if (!attempt.feedback || typeof attempt.feedback !== "object") {
    attempt.feedback = {};
  }
  if (!attempt.feedback.questionStartedAtByQid || typeof attempt.feedback.questionStartedAtByQid !== "object") {
    attempt.feedback.questionStartedAtByQid = {};
  }
  if (!attempt.feedback.evaluationByQid || typeof attempt.feedback.evaluationByQid !== "object") {
    attempt.feedback.evaluationByQid = {};
  }
  if (!attempt.feedback.hintUsedByQid || typeof attempt.feedback.hintUsedByQid !== "object") {
    attempt.feedback.hintUsedByQid = {};
  }
  if (!Array.isArray(attempt.feedback.scoredQids)) {
    attempt.feedback.scoredQids = [];
  }
}

function updateFeedbackControls(isFeedbackMode, qid, q) {
  const submitBtn = $("submitBtn");
  const hintBtn = $("hintBtn");
  const skipBtn = $("skipBtn");
  const pointsInfo = $("pointsInfo");
  const feedbackMessage = $("feedbackMessage");

  submitBtn.textContent = isFeedbackMode ? "Finish" : "Submit";

  if (!isFeedbackMode) {
    if (hintBtn) hintBtn.style.display = "none";
    if (skipBtn) skipBtn.style.display = "none";
    if (pointsInfo) {
      pointsInfo.style.display = "none";
      pointsInfo.textContent = "";
    }
    if (feedbackMessage) {
      feedbackMessage.style.display = "none";
      feedbackMessage.textContent = "";
    }
    return;
  }

  ensureFeedbackAttemptState();

  if (pointsInfo) {
    pointsInfo.style.display = "block";
    pointsInfo.textContent = `Points: ${attempt.points || 0} • Streak: ${attempt.streak || 0}`;
  }

  const evaluated = !!attempt.feedback.evaluationByQid[qid];
  const hintUsed = !!attempt.feedback.hintUsedByQid[qid];

  if (hintBtn) {
    hintBtn.style.display = "inline-flex";
    hintBtn.disabled = attempt.submitted || evaluated || hintUsed;
  }

  if (skipBtn) {
    skipBtn.style.display = "inline-flex";
    skipBtn.disabled = attempt.submitted || evaluated;
  }

  if (feedbackMessage) {
    let message = "";
    if (evaluated) {
      const result = attempt.feedback.evaluationByQid[qid];
      message = result.status === "correct"
        ? "Correct"
        : result.status === "skipped"
          ? `Skipped. Correct answer: ${result.correct ?? "—"}`
          : `Incorrect, correct is ${result.correct ?? "—"}`;
    } else if (hintUsed) {
      message = `Hint used: Correct answer is ${q.correct_label ?? "—"}. (-25 points)`;
    }

    feedbackMessage.textContent = message;
    feedbackMessage.style.display = message ? "block" : "none";
  }
}

function handleFeedbackHint() {
  if (!attempt || attempt.mode !== FEEDBACK_MODE) return;
  const qid = attempt.questionIds[currentIndex];
  const q = getQuestionById(qid);
  if (!q) return;

  ensureFeedbackAttemptState();
  const alreadyScored = attempt.feedback.scoredQids.includes(qid);
  const hintUsed = !!attempt.feedback.hintUsedByQid[qid];
  if (alreadyScored || hintUsed) return;

  attempt.feedback.hintUsedByQid[qid] = true;

  if (typeof window.awardPoints === "function") {
    window.awardPoints(attempt, {
      isCorrect: false,
      timeTaken: null,
      usedHint: true,
      skipped: false
    });
  }

  if (typeof window.checkAndAwardBadges === "function") {
    window.checkAndAwardBadges(attempt);
  }

  saveAttempt();
  renderExam();
}

function handleFeedbackSkip() {
  if (!attempt || attempt.mode !== FEEDBACK_MODE) return;
  const qid = attempt.questionIds[currentIndex];
  const q = getQuestionById(qid);
  if (!q) return;

  ensureFeedbackAttemptState();
  const alreadyScored = attempt.feedback.scoredQids.includes(qid);
  if (alreadyScored) return;

  delete attempt.answers[qid];

  const startedAt = Number(attempt.feedback.questionStartedAtByQid[qid]);
  const timeTaken = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    : null;

  if (typeof window.awardPoints === "function") {
    window.awardPoints(attempt, {
      isCorrect: false,
      timeTaken,
      usedHint: !!attempt.feedback.hintUsedByQid[qid],
      skipped: true,
      questionId: qid
    });
  }

  if (typeof window.checkAndAwardBadges === "function") {
    window.checkAndAwardBadges(attempt);
  }

  attempt.feedback.evaluationByQid[qid] = {
    status: "skipped",
    your: null,
    correct: q.correct_label,
    timeTaken
  };

  saveAttempt();
  renderExam();
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
  const isFeedbackMode = attempt.mode === FEEDBACK_MODE;

  if (isFeedbackMode) {
    ensureFeedbackAttemptState();
    const alreadyScored = attempt.feedback.scoredQids.includes(qid);
    if (!alreadyScored && !Number.isFinite(Number(attempt.feedback.questionStartedAtByQid[qid]))) {
      attempt.feedback.questionStartedAtByQid[qid] = Date.now();
      saveAttempt();
    }
  }

  const feedbackResult = isFeedbackMode ? attempt.feedback?.evaluationByQid?.[qid] : null;

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
    const disableForFeedback = isFeedbackMode && attempt.feedback?.scoredQids?.includes(qid);
    const disabled = (attempt.submitted || disableForFeedback) ? "disabled" : "";
    const checked = (your === ch.label) ? "checked" : "";

    // Post-submit coloring
    if (attempt.submitted || feedbackResult) {
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
      const selected = e.target.value;
      attempt.answers[qid] = selected;

      const startedAt = Number(attempt.feedback?.questionStartedAtByQid?.[qid]);
      const timeTaken = Number.isFinite(startedAt)
        ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        : null;

      if (attempt.mode === FEEDBACK_MODE) {
        ensureFeedbackAttemptState();

        const alreadyScored = attempt.feedback.scoredQids.includes(qid);
        const isCorrect = selected === q.correct_label;

        if (!alreadyScored) {
          if (typeof window.awardPoints === "function") {
            window.awardPoints(attempt, {
              isCorrect,
              timeTaken,
              usedHint: !!attempt.feedback?.hintUsedByQid?.[qid],
              skipped: false,
              questionId: qid
            });
          }

          if (typeof window.checkAndAwardBadges === "function") {
            window.checkAndAwardBadges(attempt);
          }
        }

        attempt.feedback.evaluationByQid[qid] = {
          status: isCorrect ? "correct" : "wrong",
          your: selected,
          correct: q.correct_label,
          timeTaken
        };

        saveAttempt();
        renderExam();

        const indexAtSelection = currentIndex;
        window.setTimeout(() => {
          if (!attempt || attempt.mode !== FEEDBACK_MODE) return;
          if (currentIndex !== indexAtSelection) return;
          if (currentIndex >= attempt.questionIds.length - 1) return;
          currentIndex += 1;
          saveAttempt();
          renderExam();
        }, FEEDBACK_NEXT_DELAY_MS);
        return;
      }

      saveAttempt();
      renderExam();
    });

    choices.appendChild(row);
  });

  card.appendChild(choices);

  updateFeedbackControls(isFeedbackMode, qid, q);

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
}

function renderResults() {
  const s = attempt.summary;
  const elapsedText = s.elapsedSeconds != null ? `, time: ${formatDuration(s.elapsedSeconds)}` : "";
  $("scoreLine").textContent = `Score: ${s.correct} / ${s.total}  (wrong: ${s.wrong}, unanswered: ${s.unanswered}${elapsedText})`;
  const resultNameInput = $("resultsName");
  if (resultNameInput && !resultNameInput.value) {
    resultNameInput.value = getSavedLeaderboardName();
  }
  $("saveResultMessage").textContent = "";
  $("newAttemptBtn").textContent = `New ${s.total}-question attempt`;
  refreshGlobalLeaderboards();

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
  $("homeTabBtn").onclick = () => { stopTimer(); show("home"); };
  $("leaderboardTabBtn").onclick = async () => { await refreshGlobalLeaderboards(); show("leaderboardTab"); };
  $("leaderboardBackBtn").onclick = () => { show("home"); };
  $("resumeBtn").onclick = () => { show("exam"); renderExam(); startTimerIfNeeded(); };
  $("resetBtn").onclick = () => { clearAttempt(); window.location.reload(); };
  $("questionCount").oninput = () => { updateQuestionCountText(); };
  $("timerEnabled").onchange = () => { updateTimerSummary(); };
  $("timerMinutes").oninput = () => { updateTimerSummary(); };
  $("resultsName").value = getSavedLeaderboardName();

  $("prevBtn").onclick = () => { currentIndex--; renderExam(); };
  $("nextBtn").onclick = () => { currentIndex++; renderExam(); };

  $("saveExitBtn").onclick = () => { saveAttempt(); stopTimer(); show("home"); };
  $("hintBtn").onclick = handleFeedbackHint;
  $("skipBtn").onclick = handleFeedbackSkip;

  $("submitBtn").onclick = () => {
    // In feedback mode this acts as Finish.
    scoreAttempt();
    renderExam(); // reflect colors in exam view
    renderResults();
    show("results");
  };

  $("showOnlyWrong").onchange = () => renderResults();
  $("saveResultBtn").onclick = saveResultToGlobalLeaderboard;
  $("resultsName").oninput = () => { $("saveResultMessage").textContent = ""; };

  // Source selection + question bank
  const savedSource = loadQuizSource();
  setSelectedQuizSource(savedSource);

  const sourceInputs = document.querySelectorAll("input[name=quizSource]");
  sourceInputs.forEach((input) => {
    input.onchange = async () => {
      const nextSource = getSelectedQuizSource();
      saveQuizSource(nextSource);
      setSelectedQuizSource(nextSource);
      clearAttempt();
      try {
        bank = await loadQuestionBank(nextSource);
        setBankInfo(nextSource);
        updateQuestionCountText();
        $("startBtn").disabled = false;
      } catch (error) {
        $("questionBankInfo").textContent = error.message || "Failed to load question bank.";
        $("startBtn").disabled = true;
      }
    };
  });

  try {
    bank = await loadQuestionBank(savedSource);
    setBankInfo(savedSource);
  } catch (error) {
    if (savedSource !== LEGACY_SOURCE) {
      try {
        bank = await loadQuestionBank(LEGACY_SOURCE);
        saveQuizSource(LEGACY_SOURCE);
        setSelectedQuizSource(LEGACY_SOURCE);
        setBankInfo(LEGACY_SOURCE);
        $("questionBankInfo").textContent = "";
      } catch (legacyError) {
        $("questionBankInfo").textContent = legacyError.message || "Failed to load question bank.";
        $("startBtn").disabled = true;
        updateTimerSummary();
        refreshGlobalLeaderboards();
        return;
      }
    } else {
      $("questionBankInfo").textContent = error.message || "Failed to load question bank.";
      $("startBtn").disabled = true;
      updateTimerSummary();
      refreshGlobalLeaderboards();
      return;
    }
  }
  updateTimerSummary();
  refreshGlobalLeaderboards();

  // Attempt state
  const saved = loadSavedAttempt();
  if (saved && saved.questionIds && saved.answers) {
    attempt = saved;
    saveAttempt();
    $("questionCount").value = String(attempt.questionIds.length);
    $("timerEnabled").checked = !!attempt.timerEnabled;
    $("timerMinutes").value = String(attempt.timerMinutes || DEFAULT_TIMER_MINUTES);
    updateQuestionCountText();
    updateTimerSummary();
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
