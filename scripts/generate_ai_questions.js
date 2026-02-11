#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_TOPICS = [
  "gdpr_rights",
  "controller_obligations",
  "lawful_bases",
  "international_transfers",
  "data_breach"
];

function parseArgs(argv) {
  const options = {
    out: "ai_questions.json",
    count: 200,
    topics: DEFAULT_TOPICS,
    difficulty: "medium",
    seedPrefix: new Date().toISOString().slice(0, 10),
    knowledge: "gdpr_knowledge.json",
    questions: "questions.json",
    cacheDir: ".cache/ai_questions",
    maxAttempts: 5,
    minConfidence: 0.85,
    // similarity gates:
    maxSimToStyleRef: 0.55,   // reject if too close to any style ref question
    maxSimToExisting: 0.60,   // reject if too close to already generated questions
    styleRefCount: 4
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    i++;

    if (key === "out") options.out = value;
    if (key === "count") options.count = Math.max(1, Number.parseInt(value, 10) || 1);
    if (key === "topics") options.topics = value.split(",").map(v => v.trim()).filter(Boolean);
    if (key === "difficulty") options.difficulty = value.trim() || "medium";
    if (key === "seed-prefix") options.seedPrefix = value.trim() || options.seedPrefix;
    if (key === "knowledge") options.knowledge = value.trim();
    if (key === "questions") options.questions = value.trim();
    if (key === "cache-dir") options.cacheDir = value.trim();
    if (key === "style-ref-count") options.styleRefCount = Math.max(0, Number.parseInt(value, 10) || 4);
  }

  if (!options.topics.length) options.topics = DEFAULT_TOPICS;
  return options;
}

/** ---------- Text utils + similarity ---------- **/

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    // keep polish letters
    .replace(/[^a-z0-9ąćęłńóśźż\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  const t = normalizeText(s).split(" ").filter(w => w.length >= 4);
  return new Set(t);
}

function jaccard(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

function maxSimilarityToList(questionText, list) {
  let best = 0;
  for (const item of list) {
    const t = typeof item === "string" ? item : (item?.text || item?.question || "");
    if (!t) continue;
    const sim = jaccard(questionText, t);
    if (sim > best) best = sim;
  }
  return best;
}

function sanitizeQuestionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    // avoid explicit article numbers in displayed question
    .replace(/\bArticle\s+\d+\b/gi, "GDPR provision")
    .replace(/\bArt\.\s*\d+\b/gi, "GDPR provision")
    .trim();
}

function ensureFourChoices(choices) {
  if (!Array.isArray(choices)) return null;
  const c = choices.map(x => String(x || "").trim()).filter(Boolean);
  if (c.length !== 4) return null;
  // uniqueness
  if (new Set(c.map(normalizeText)).size !== 4) return null;
  return c;
}

/** ---------- IO: load GDPR knowledge + DB questions ---------- **/

async function loadGdprKnowledge(filepath) {
  const raw = await fs.readFile(filepath, "utf8");
  const parsed = JSON.parse(raw);

  // Accept either array or {items: []}
  const items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.fragments || []);
  if (!Array.isArray(items) || !items.length) {
    throw new Error(`No GDPR knowledge items found in ${filepath}`);
  }

  // Expect: {id, topic, text} minimally
  const cleaned = items
    .map((x, idx) => ({
      id: String(x.id ?? `gdpr_${idx + 1}`),
      topic: String(x.topic ?? ""),
      text: String(x.text ?? x.fragment ?? "").trim()
    }))
    .filter(x => x.text.length >= 40);

  if (!cleaned.length) throw new Error(`GDPR knowledge in ${filepath} has no usable text items.`);
  return cleaned;
}

async function loadDbQuestions(filepath) {
  const raw = await fs.readFile(filepath, "utf8");
  const parsed = JSON.parse(raw);

  // Your DB seems to be {questions:[...]} with items like {text, choices:[{label,text,is_correct}], correct_label}
  const qs = parsed.questions || parsed.items || [];
  if (!Array.isArray(qs) || !qs.length) return [];

  return qs
    .map(q => ({
      id: q.id ?? q.question_id ?? null,
      text: String(q.text || q.question || "").trim()
    }))
    .filter(q => q.text.length >= 20);
}

async function loadExistingAiOut(outPath) {
  try {
    const raw = await fs.readFile(outPath, "utf8");
    const parsed = JSON.parse(raw);
    const items = parsed.items || [];
    if (!Array.isArray(items)) return { version: 1, generated_at: null, items: [] };
    return parsed;
  } catch {
    return { version: 1, generated_at: null, items: [] };
  }
}

/** ---------- Cache ---------- **/

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function readCache(cacheDir, key) {
  try {
    const p = path.join(cacheDir, `${key}.json`);
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(cacheDir, key, value) {
  await fs.mkdir(cacheDir, { recursive: true });
  const p = path.join(cacheDir, `${key}.json`);
  await fs.writeFile(p, JSON.stringify(value, null, 2), "utf8");
}

/** ---------- OpenAI Responses API JSON helper ---------- **/

async function callOpenAiJson(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      input: messages,
      text: { format: { type: "json_object" } }
    })
  });

  const data = await response.json();
  
  if (process.env.DEBUG_OPENAI === "1") {
    console.log("DEBUG OpenAI data.output:", JSON.stringify(data.output, null, 2).slice(0, 4000));
    console.log("DEBUG OpenAI data.error:", JSON.stringify(data.error, null, 2));
  }

  if (!response.ok) {
    // Responses API often includes error details in JSON
    throw new Error(`OpenAI API error: ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
  }

  // Try common places where JSON text may appear
  let text =
    data.output_text ??
    data.text ??
    null;

  // If not present, search in output array (Responses API structure)
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output) {
      // Common structure: { content: [{ type: "output_text", text: "..." }, ...] }
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && typeof c.text === "string") {
            text = c.text;
            break;
          }
          // Some variants use c?.text directly
          if (!text && typeof c?.text === "string") {
            text = c.text;
          }
        }
      }
      if (text) break;
    }
  }

  if (!text || typeof text !== "string") {
    throw new Error(`OpenAI API: no text output found. Keys: ${Object.keys(data).join(",")}`);
  }

  // The model should return JSON only, but sometimes wraps it; extract first {...} if needed
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : (trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed);

  return JSON.parse(jsonText);
}

/** ---------- Generation + validation ---------- **/

function buildStyleRefs(dbQuestions, topic, count) {
  // simplest: random sample from whole DB; you can improve by topic labels later
  if (!dbQuestions.length || count <= 0) return [];
  const refs = [];
  const used = new Set();
  while (refs.length < Math.min(count, dbQuestions.length)) {
    const idx = Math.floor(Math.random() * dbQuestions.length);
    if (used.has(idx)) continue;
    used.add(idx);
    refs.push(dbQuestions[idx].text);
  }
  return refs;
}

async function generateAndValidate({
  gdprItem,
  topic,
  difficulty,
  styleRefs,
  opts,
  existingAiQuestions
}) {
  const cachePayload = {
    topic,
    difficulty,
    gdpr_id: gdprItem.id,
    gdpr_text: gdprItem.text,
    style_refs: styleRefs
  };
  const cacheKey = sha256(JSON.stringify(cachePayload));
  const cached = await readCache(opts.cacheDir, cacheKey);
  if (cached) return cached;

  // 1) Generator
  const generatorPrompt = [
    {
      role: "system",
      content:
        [
          "You generate NEW GDPR multiple-choice quiz questions.",
          "Use the GDPR fragment for meaning; use reference questions ONLY for style and difficulty.",
          "DO NOT copy or paraphrase reference questions.",
          "Return strict JSON with keys: question, choices, correct_index.",
          "Rules: exactly 4 choices; exactly one correct answer; medium difficulty unless specified; do NOT cite article numbers in the question text; do NOT quote GDPR verbatim for long spans."
        ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        topic,
        difficulty,
        gdpr_fragment: gdprItem.text,
        reference_questions_style_only: styleRefs
      })
    }
  ];

  const generated = await callOpenAiJson(generatorPrompt);

  // Basic local shape check before validator call
  const shapeIssues = [];
  const qText = sanitizeQuestionText(generated?.question);
  const choices = ensureFourChoices(generated?.choices);
  const ci = generated?.correct_index;

  if (!qText || typeof qText !== "string" || qText.length < 20) shapeIssues.push("question_missing_or_too_short");
  if (!choices) shapeIssues.push("choices_not_4_unique_strings");
  if (!Number.isInteger(ci) || ci < 0 || ci > 3) shapeIssues.push("correct_index_invalid");

  // Similarity gates (local, early)
  const simToRefs = maxSimilarityToList(qText, styleRefs);
  const simToExisting = maxSimilarityToList(qText, existingAiQuestions.map(x => x.question));

  if (simToRefs > opts.maxSimToStyleRef) shapeIssues.push(`too_similar_to_style_refs:${simToRefs.toFixed(2)}`);
  if (simToExisting > opts.maxSimToExisting) shapeIssues.push(`too_similar_to_existing_ai:${simToExisting.toFixed(2)}`);

  // Reject immediately if obvious problems
  if (shapeIssues.length) {
    const result = {
      generated: {
        question: qText || "",
        choices: choices || [],
        correct_index: Number.isInteger(ci) ? ci : 0
      },
      validated: { ok: false, confidence: 0.2, reasons: shapeIssues }
    };
    await writeCache(opts.cacheDir, cacheKey, result);
    return result;
  }

  // 2) Validator (model-based)
  const validatorPrompt = [
    {
      role: "system",
      content:
        [
          "Validate a GDPR multiple choice question for a quiz.",
          'Return strict JSON: {"ok": boolean, "confidence": number, "reasons": string[]}.',
          "Rules: exactly one correct answer; exactly 4 choices; no article number citation in question text; not a near-copy of references; medium difficulty."
        ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: qText,
        choices,
        correct_index: ci,
        similarity_to_style_refs: simToRefs,
        similarity_to_existing_ai: simToExisting
      })
    }
  ];

  const validated = await callOpenAiJson(validatorPrompt);

  const result = {
    generated: { question: qText, choices, correct_index: ci },
    validated: validated && typeof validated === "object"
      ? validated
      : { ok: false, confidence: 0.2, reasons: ["validator_invalid_json"] }
  };

  await writeCache(opts.cacheDir, cacheKey, result);
  return result;
}

function buildAiItem(candidate, index, opts, topic, gdprItem, confidence, reasons) {
  return {
    id: `ai_${String(index + 1).padStart(6, "0")}`,
    topic,
    difficulty: opts.difficulty || "medium",
    question: sanitizeQuestionText(candidate.question),
    choices: candidate.choices,
    correct_index: candidate.correct_index,
    confidence,
    review_reasons: reasons || [],
    source: {
      gdpr_ref: gdprItem?.id || "GDPR (conceptual)",
      seed: `${opts.seedPrefix}|${topic}|${String(index + 1).padStart(4, "0")}`
    }
  };
}

async function main() {
  const opts = parseArgs(process.argv);

  const gdprKnowledge = await loadGdprKnowledge(opts.knowledge);
  const dbQuestions = await loadDbQuestions(opts.questions);
  const existingOut = await loadExistingAiOut(opts.out);

  const existingAiItems = Array.isArray(existingOut.items) ? existingOut.items : [];
  const existingAiQuestions = existingAiItems
    .map(x => ({ question: String(x.question || "").trim() }))
    .filter(x => x.question);

  const items = [...existingAiItems]; // append new ones (dedupe gate uses this)

  const byTopic = new Map();
  for (const item of gdprKnowledge) {
    const t = item.topic || "";
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t).push(item);
  }

  function pickGdprItem(topic) {
    const pool = byTopic.get(topic) || gdprKnowledge;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  let generatedCount = 0;
  const targetTotal = opts.count;

  while (generatedCount < targetTotal) {
    const topic = opts.topics[generatedCount % opts.topics.length];
    const gdprItem = pickGdprItem(topic);
    const styleRefs = buildStyleRefs(dbQuestions, topic, opts.styleRefCount);

    let accepted = null;
    let acceptedMeta = null;

    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      let result;
      try {
        result = await generateAndValidate({
          gdprItem,
          topic,
          difficulty: opts.difficulty,
          styleRefs,
          opts,
          existingAiQuestions
        });
      } catch (e) {
        console.log("DEBUG OpenAI error:", e?.message || e);
        
        result = {
          generated: null,
          validated: { ok: false, confidence: 0.0, reasons: ["openai_call_failed", String(e.message || e)] }
        };
      }

      const ok = result?.validated?.ok === true;
      const conf = Number(result?.validated?.confidence ?? 0);

      if (ok && conf >= opts.minConfidence) {
        accepted = result.generated;
        acceptedMeta = { confidence: conf, reasons: result.validated.reasons || [] };
        break;
      }
    }

    if (!accepted) {
      // Could not generate a safe question for this iteration; move on.
      generatedCount++;
      continue;
    }

    // Deduplicate vs existing AI items (question text similarity)
    const simToExistingAi = maxSimilarityToList(accepted.question, existingAiQuestions.map(x => x.question));
    if (simToExistingAi > opts.maxSimToExisting) {
      generatedCount++;
      continue;
    }

    const aiItem = buildAiItem(
      accepted,
      items.length,
      opts,
      topic,
      gdprItem,
      acceptedMeta.confidence,
      acceptedMeta.reasons
    );

    items.push(aiItem);
    existingAiQuestions.push({ question: aiItem.question });

    generatedCount++;
  }

  const out = {
    version: 1,
    generated_at: new Date().toISOString(),
    items
  };

  const outputPath = path.resolve(opts.out);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log(`AI pool: wrote ${items.length} items -> ${opts.out}`);
  console.log(`Cache dir: ${opts.cacheDir}`);
  console.log(`Knowledge: ${opts.knowledge} | Style refs: ${opts.questions}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
