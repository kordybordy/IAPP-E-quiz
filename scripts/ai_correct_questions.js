import fs from "fs/promises";

const DEFAULT_INPUT = "questions.json";
const DEFAULT_OUTPUT = "questions.corrected.json";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_DELAY_MS = 250;
const HARDCODED_API_KEY =
  "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";

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, limit: null, startId: null, model: DEFAULT_MODEL, delayMs: DEFAULT_DELAY_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--in") args.input = argv[i + 1];
    if (arg === "--out") args.output = argv[i + 1];
    if (arg === "--limit") args.limit = Number(argv[i + 1]);
    if (arg === "--start-id") args.startId = Number(argv[i + 1]);
    if (arg === "--model") args.model = argv[i + 1];
    if (arg === "--delay-ms") args.delayMs = Number(argv[i + 1]);
  }
  return args;
}

function buildPrompt(question) {
  return [
    "You are a meticulous editor for exam questions.",
    "Fix grammar, clarity, and formatting only.",
    "Do not change the meaning, difficulty, or factual correctness.",
    "Keep exactly four choices labeled A-D.",
    "Keep the correct label the same as provided.",
    "If a scenario is provided, edit it for clarity but do not change its meaning.",
    "Return strict JSON with keys: scenario_text (string or null), text (string), choices (array of {label,text}), correct_label.",
    "JSON only."
  ].join("\n");
}

async function callOpenAI({ apiKey, model, question }) {
  const body = {
    model,
    messages: [
      { role: "system", content: buildPrompt(question) },
      {
        role: "user",
        content: JSON.stringify({
          scenario_text: question.scenario_text,
          text: question.text,
          choices: question.choices.map((choice) => ({ label: choice.label, text: choice.text })),
          correct_label: question.correct_label
        })
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0.2
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI API response missing content.");
  }
  return JSON.parse(content);
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY || HARDCODED_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Set it in your environment before running.");
  }

  const { input, output, limit, startId, model, delayMs } = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(input, "utf-8");
  const payload = JSON.parse(raw);

  const questions = payload.questions;
  let filtered = questions;
  if (startId !== null && Number.isFinite(startId)) {
    filtered = filtered.filter((q) => q.id >= startId);
  }
  if (limit !== null && Number.isFinite(limit)) {
    filtered = filtered.slice(0, limit);
  }

  const errors = [];

  for (let i = 0; i < filtered.length; i += 1) {
    const q = filtered[i];
    try {
      const corrected = await callOpenAI({ apiKey, model, question: q });

      q.scenario_text = corrected.scenario_text;
      q.text = corrected.text;
      q.correct_label = corrected.correct_label;
      q.choices = corrected.choices.map((choice) => ({
        label: choice.label,
        text: choice.text,
        is_correct: choice.label === corrected.correct_label
      }));

      const count = i + 1;
      const total = filtered.length;
      process.stdout.write(`Corrected question ${q.id} (${count}/${total})\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ id: q.id, error: message });
      process.stderr.write(`Failed to correct question ${q.id}: ${message}\n`);
    }

    if (i < filtered.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  payload.question_count = payload.questions.length;
  payload.errors = errors;
  await fs.writeFile(output, JSON.stringify(payload, null, 2));
  process.stdout.write(`Wrote corrected questions to ${output}\n`);
  if (errors.length > 0) {
    process.stdout.write(`Encountered ${errors.length} errors. See payload.errors in ${output}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
