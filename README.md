# Exam Simulator (Static)

This is a **pure static** exam simulator (HTML + JS) that:
- randomly draws **50 questions** from the question bank
- lets you answer
- scores you and shows a full review

No Python, no server.

## Run locally
Just open `index.html` in a browser.

> Tip: some browsers block `fetch()` from `file://`.  
> If that happens, use any tiny static server, e.g. VS Code “Live Server”.
> On GitHub Pages it works normally.

## Host on GitHub Pages
1. Create a new GitHub repo (e.g. `exam-simulator`)
2. Upload these files to the repo root:
   - `index.html`
   - `app.js`
   - `styles.css`
   - `questions.json`
   - `.nojekyll`
3. In GitHub:
   - Settings → Pages → “Deploy from a branch”
   - Branch: `main` / folder: `/ (root)`
4. Your site appears at:
   `https://<username>.github.io/<repo>/`


## Privacy
All answers are stored only in your browser (LocalStorage). Nothing is sent anywhere.

## AI mode: "paragraph → question" with quality gates

This repository now includes a **backend-only AI pipeline** suitable for a static frontend hosted on GitHub Pages.

### Why backend is required
The frontend remains static, but the OpenAI API key is kept server-side in a function/worker endpoint.

### Implemented architecture
- `api/generate-question.js` – HTTP endpoint (`POST`) for paragraph-based generation.
- `backend/aiQuestionService.js` – core pipeline with:
  - generator model call,
  - deterministic post-validation,
  - verifier model call,
  - in-memory cache by hashed input,
  - retries with exponential backoff + jitter for 429/503.

### Request payload (example)
```json
{
  "paragraph": "...",
  "language": "pl",
  "article_ref": "art. 6 ust. 1 lit. f"
}
```

### Output shape
The endpoint returns a structured object containing:
- `language`, `article_ref`, `question`, `choices[4]`, `correct_label`, `rationale`, `difficulty`
- plus verification metadata (`verification`, `overlap_score`).

### Quality controls included
1. **Schema-driven generation** (Structured Output JSON schema).
2. **Choice integrity checks** (exactly 4 unique answers A-D, unique texts, valid `correct_label`).
3. **Anti-copy filter** using n-gram overlap (`paragraph` vs `question`).
4. **Difficulty floor** (heuristic + model-provided score must be >= 2).
5. **Second-model verification** for grounding and distractor correctness.

### Environment variables
- `OPENAI_API_KEY` (required)
- `AI_GENERATOR_MODEL` (optional, default: `gpt-4.1-mini`)
- `AI_VERIFIER_MODEL` (optional, default: `gpt-4.1-mini`)


### GitHub Secrets note (important)
- `OPENAI_API_KEY` stored in **GitHub Secrets** is available only to GitHub Actions jobs.
- GitHub Pages is static hosting, so browser code and Pages itself cannot read repository secrets at runtime.
- Use GitHub Secrets for offline/background jobs (e.g. `.github/workflows/ai-clean.yml`) and run runtime AI generation via an external backend (Cloudflare Worker / Vercel / Netlify / server).

### Run tests
```bash
npm test
```
