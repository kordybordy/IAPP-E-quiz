import { AIQuestionService } from "../backend/aiQuestionService.js";

const sharedCache = new Map();

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function parseJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const body = await parseJson(req);
  if (!body?.paragraph || typeof body.paragraph !== "string") {
    return jsonResponse(400, { error: "paragraph_required" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { error: "missing_openai_api_key" });
  }

  const service = new AIQuestionService({
    apiKey,
    cache: sharedCache,
    config: {
      generatorModel: process.env.AI_GENERATOR_MODEL || "gpt-4.1-mini",
      verifierModel: process.env.AI_VERIFIER_MODEL || "gpt-4.1-mini"
    }
  });

  try {
    const result = await service.generateFromParagraph({
      paragraph: body.paragraph,
      language: body.language || "pl",
      articleRef: body.article_ref || "",
      existingQuestions: Array.isArray(body.existing_questions) ? body.existing_questions : []
    });
    return jsonResponse(200, result);
  } catch (error) {
    return jsonResponse(422, {
      error: "generation_failed",
      message: error.message
    });
  }
}
