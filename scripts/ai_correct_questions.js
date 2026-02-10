import fs from "node:fs/promises";
import crypto from "node:crypto";

const DEFAULT_INPUT = "questions.json";
const DEFAULT_OUTPUT = "questions.corrected.json";
const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_DELAY_MS = 0;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_CACHE = ".cache/ai_correct_cache.jsonl";
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    limit: null,
    startId: null,
    model: DEFAULT_MODEL,
    delayMs: DEFAULT_DELAY_MS,
    concurrency: DEFAULT_CONCURRENCY,
    cacheFile: process.env.AI_CACHE || DEFAULT_CACHE,
    scenarioMode: "keep"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--in") args.input = next;
    if (arg === "--out") args.output = next;
    if (arg === "--limit") args.limit = Number(next);
    if (arg === "--start-id") args.startId = Number(next);
    if (arg === "--model") args.model = next;
    if (arg === "--delay-ms") args.delayMs = Number(next);
    if (arg === "--concurrency") args.concurrency = Number(next);
    if (arg === "--cache") args.cacheFile = next;
    if (arg === "--scenario-mode") args.scenarioMode = next;
  }

  if (!["keep", "drop", "group"].includes(args.scenarioMode)) {
    throw new Error("Invalid --scenario-mode. Expected one of: keep, drop, group.");
  }

  return args;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeText(raw) {
  if (raw === null || raw === undefined) return null;

  return String(raw)
    .normalize("NFC")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/\s+([,.;:?!\)\]])/g, "$1")
    .replace(/([,.;:?!])(\S)/g, "$1 $2")
    .replace(/\(\s+/g, "(")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuestionShape(question) {
  const normalizedChoices = (question.choices || []).map((choice) => ({
    ...choice,
    label: String(choice.label || "").trim().toUpperCase(),
    text: normalizeText(choice.text) || ""
  }));

  return {
    ...question,
    scenario_text: normalizeText(question.scenario_text),
    text: normalizeText(question.text) || "",
    correct_label: String(question.correct_label || "").trim().toUpperCase(),
    choices: normalizedChoices
  };
}

function isSuspicious(question) {
  const badChars = /\uFFFD|\s{3,}|[A-Za-z]{2,}-\s+[a-z]{2,}/;
  const tooLongQuestion = (question.text || "").length > 450;
  const malformedChoices = (question.choices || []).length !== 4 || question.choices.some((c) => (c.text || "").length === 0 || (c.text || "").length > 350);
  const weirdChars = badChars.test(question.text || "") || question.choices.some((c) => badChars.test(c.text || ""));
  return tooLongQuestion || malformedChoices || weirdChars;
}

async function loadCache(cacheFile) {
  const cache = new Map();
  try {
    const raw = await fs.readFile(cacheFile, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      cache.set(parsed.key, parsed.value);
    }
  } catch {
    // Intentionally ignore missing cache file.
  }
  return cache;
}

async function appendCache(cacheFile, key, value) {
  await fs.mkdir(cacheFile.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await fs.appendFile(cacheFile, `${JSON.stringify({ key, value })}\n`, "utf-8");
}

function buildPrompt() {
  return [
    "Jesteś narzędziem do rekonstrukcji pytań testowych po OCR.",
    "Naprawiaj tylko formę: literówki, odstępy, artefakty OCR i podział na pytanie + 4 odpowiedzi A-D.",
    "NIE zmieniaj sensu merytorycznego i NIE dodawaj informacji.",
    "Zachowaj correct_label dokładnie taki jak wejściowy.",
    "Jeżeli nie masz wysokiej pewności, ustaw needs_human_review=true i confidence <= 0.6.",
    "Zwróć wyłącznie JSON zgodny ze schematem."
  ].join("\n");
}

function buildSchema() {
  return {
    name: "repair_question",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scenario_text", "text", "choices", "correct_label", "confidence", "needs_human_review", "notes"],
      properties: {
        scenario_text: { anyOf: [{ type: "string" }, { type: "null" }] },
        text: { type: "string", minLength: 5 },
        choices: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "text"],
            properties: {
              label: { type: "string", enum: ["A", "B", "C", "D"] },
              text: { type: "string", minLength: 1 }
            }
          }
        },
        correct_label: { type: "string", enum: ["A", "B", "C", "D"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        needs_human_review: { type: "boolean" },
        notes: { type: "array", items: { type: "string" } }
      }
    }
  };
}

function validateRepair(original, repaired) {
  if (!repaired || typeof repaired !== "object") throw new Error("Repair result is not an object.");
  if (!Array.isArray(repaired.choices) || repaired.choices.length !== 4) throw new Error("Repair choices must contain exactly 4 elements.");

  const labels = repaired.choices.map((choice) => choice.label);
  const uniqueLabels = new Set(labels);
  if (uniqueLabels.size !== 4 || ["A", "B", "C", "D"].some((label) => !uniqueLabels.has(label))) {
    throw new Error("Repair choices must contain labels A, B, C, D exactly once.");
  }

  if (repaired.correct_label !== original.correct_label) {
    throw new Error("Repair changed correct_label, which is not allowed.");
  }
}

async function callResponsesAPI({ apiKey, model, question, prev, next }) {
  const payload = {
    q: {
      id: question.id,
      scenario_text: question.scenario_text,
      text: question.text,
      choices: question.choices.map((choice) => ({ label: choice.label, text: choice.text })),
      correct_label: question.correct_label
    },
    prev: prev
      ? { id: prev.id, text: prev.text, choices: prev.choices.map((choice) => ({ label: choice.label, text: choice.text })) }
      : null,
    next: next
      ? { id: next.id, text: next.text, choices: next.choices.map((choice) => ({ label: choice.label, text: choice.text })) }
      : null
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      input: [
        { role: "developer", content: buildPrompt() },
        { role: "user", content: JSON.stringify(payload) }
      ],
      text: { format: { type: "json_schema", ...buildSchema() } }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`OpenAI API error ${response.status}: ${errorText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  if (!data.output_text) {
    throw new Error("OpenAI API response missing output_text.");
  }

  return JSON.parse(data.output_text);
}

async function withRetry(task, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const status = error?.status;
      const retryable = typeof status === "number" && RETRYABLE_STATUS.has(status);
      if (!retryable || attempt === attempts) throw error;

      const backoff = Math.min(1000 * 2 ** (attempt - 1), 10000);
      const jitter = Math.floor(Math.random() * 250);
      await wait(backoff + jitter);
    }
  }
  throw new Error("Retry loop exhausted unexpectedly.");
}

function toLegacyQuestion(original, repaired) {
  const correct = original.correct_label;
  return {
    ...original,
    scenario_text: normalizeText(repaired.scenario_text),
    text: normalizeText(repaired.text) || original.text,
    correct_label: correct,
    choices: repaired.choices.map((choice) => ({
      label: choice.label,
      text: normalizeText(choice.text) || "",
      is_correct: choice.label === correct
    })),
    source: {
      origin: "ai_repair",
      confidence: repaired.confidence,
      needs_human_review: repaired.needs_human_review,
      notes: repaired.notes
    }
  };
}

function transformScenarios(questions, mode) {
  if (mode === "drop") {
    return questions.filter((q) => !q.scenario_id);
  }

  if (mode === "keep") {
    return questions;
  }

  const singles = [];
  const grouped = new Map();

  for (const question of questions) {
    if (!question.scenario_id) {
      singles.push({ ...question, kind: "single" });
      continue;
    }

    if (!grouped.has(question.scenario_id)) {
      grouped.set(question.scenario_id, {
        id: `S_${question.scenario_id}`,
        kind: "scenario",
        exam: question.exam,
        scenario: {
          id: question.scenario_id,
          text: question.scenario_text || ""
        },
        subquestions: []
      });
    }

    grouped.get(question.scenario_id).subquestions.push({
      id: String(question.id),
      number: question.number,
      text: question.text,
      choices: question.choices.map((choice) => ({ label: choice.label, text: choice.text })),
      correct_label: question.correct_label,
      source: question.source || { origin: "ocr", confidence: 1 }
    });
  }

  const scenarioRecords = Array.from(grouped.values());
  return [...singles, ...scenarioRecords];
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Set it in your environment before running.");
  }

  const { input, output, limit, startId, model, delayMs, concurrency, cacheFile, scenarioMode } = parseArgs(process.argv.slice(2));
  const payload = JSON.parse(await fs.readFile(input, "utf-8"));

  payload.questions = payload.questions.map(normalizeQuestionShape);

  let selected = payload.questions;
  if (startId !== null && Number.isFinite(startId)) {
    selected = selected.filter((q) => Number(q.id) >= startId);
  }
  if (limit !== null && Number.isFinite(limit)) {
    selected = selected.slice(0, limit);
  }

  const cache = await loadCache(cacheFile);
  const errors = [];

  const repairedSelected = await runWithConcurrency(selected, concurrency, async (question, i) => {
    const prev = i > 0 ? selected[i - 1] : null;
    const next = i < selected.length - 1 ? selected[i + 1] : null;

    if (!isSuspicious(question)) {
      return { ...question, source: { origin: "normalized", confidence: 1, needs_human_review: false, notes: [] } };
    }

    const cacheKey = sha256(JSON.stringify({ question, prev, next, model }));
    if (cache.has(cacheKey)) {
      return toLegacyQuestion(question, cache.get(cacheKey));
    }

    try {
      const repaired = await withRetry(() => callResponsesAPI({ apiKey, model, question, prev, next }));
      validateRepair(question, repaired);
      await appendCache(cacheFile, cacheKey, repaired);
      cache.set(cacheKey, repaired);
      const updated = toLegacyQuestion(question, repaired);
      process.stdout.write(`Corrected question ${question.id} (${i + 1}/${selected.length})\n`);
      if (delayMs > 0) {
        await wait(delayMs);
      }
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ id: question.id, error: message });
      process.stderr.write(`Failed to correct question ${question.id}: ${message}\n`);
      return { ...question, source: { origin: "failed", confidence: 0, needs_human_review: true, notes: [message] } };
    }
  });

  const repairedMap = new Map(repairedSelected.map((q) => [String(q.id), q]));
  const merged = payload.questions.map((q) => repairedMap.get(String(q.id)) || q);

  const transformed = transformScenarios(merged, scenarioMode);

  const outputPayload = {
    ...payload,
    questions: transformed,
    question_count: transformed.length,
    errors,
    metadata: {
      scenario_mode: scenarioMode,
      repaired_subset_count: repairedSelected.length,
      errors_count: errors.length
    }
  };

  await fs.writeFile(output, JSON.stringify(outputPayload, null, 2));
  process.stdout.write(`Wrote corrected questions to ${output}\n`);
  if (errors.length > 0) {
    process.stdout.write(`Encountered ${errors.length} errors. See payload.errors in ${output}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
