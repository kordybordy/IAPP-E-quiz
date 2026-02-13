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
   - Settings -> Pages -> “Deploy from a branch”
   - Branch: `main` / folder: `/ (root)`
4. Your site appears at:
   `https://<username>.github.io/<repo>/`


## Privacy
- Answers and in-progress attempts are stored in your browser (LocalStorage).
- If global leaderboard is configured and you click **Save result**, score data is sent to Supabase.

## Global leaderboard (Supabase)

The app supports a shared global leaderboard via Supabase REST API (`fetch`, no `supabase-js`).

The Supabase project URL and public anon key are hardcoded in `src/leaderboard/supabaseLeaderboard.js`:
- `SUPABASE_URL`: `https://afcwekhfisodipdijicd.supabase.com`
- `SUPABASE_ANON_KEY`: `sb_publishable_L7pMKjrigH0hgcYjq4SXmA_8TIY4Wxq`

### Required table/policies
Expected table: `public.leaderboard_scores` with RLS enabled and anon policies:
- `SELECT` for anon
- `INSERT` for anon

### How it works
- Results screen has a name input + **Save result** button.
- Global leaderboard loads from Supabase.
- If request fails, app keeps working with localStorage leaderboard and shows a warning.
- Requests include both required headers for browser Data API access: `apikey` and `Authorization: Bearer <anon key>`.

### Quick verification
1. Finish an exam and submit a score with **Save result**.
2. Confirm the entry appears in the global leaderboard section.
3. If Supabase is temporarily unavailable, confirm fallback local leaderboard still works.

## AI mode: "paragraph -> question" with quality gates

This repository now includes a **backend-only AI pipeline** suitable for a static frontend hosted on GitHub Pages.

### Why backend is required
The frontend remains static, but the OpenAI API key is kept server-side in a function/worker endpoint.

### Implemented architecture
- `api/generate-question.js` - HTTP endpoint (`POST`) for paragraph-based generation.
- `backend/aiQuestionService.js` - core pipeline with:
  - generator model call,
  - deterministic post-validation,
  - verifier model call,
  - in-memory cache by hashed input,
  - retries with exponential backoff + jitter for 429/503.

### AI pipeline flow (paragraph -> bank-style MCQ)
1. **Normalization + language detection** (`pl`/`en`).
2. **Topic tagging** (`rights`, `obligations`, `definitions`, `transfers`, etc.).
3. **Structured generation** with strict JSON schema.
4. **Verifier pass** (separate model, `temperature=0`) for correctness and form.
5. **Similarity gate** versus existing bank questions using embeddings + cosine.
6. **Decision**: accept / revise / reject.

### Similarity thresholds (starting defaults)
- `max_cosine_to_any_existing > 0.92` -> reject as probable duplicate
- `max_cosine_to_any_existing < 0.55` -> revise (too far from bank style)
- target window: `0.65-0.85` -> accept

You can pass existing bank texts to the API in `existing_questions` (array of strings or objects with `question`/`text`).

### Request payload (example)
```json
{
  "paragraph": "...",
  "language": "pl",
  "article_ref": "art. 6 ust. 1 lit. f",
  "existing_questions": ["...existing bank question text..."]
}
```

### Output shape
The endpoint returns a structured object containing:
- `language`, `article_ref`, `question`, `choices[4]`, `correct_label`, `rationale_short`, `difficulty`, `tags`, `needs_human_review`
- plus metadata (`verification`, `overlap_score`, `similarity`).

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


### Export questions to CSV/XLSX
A helper script exports `questions.corrected.json` into a flattened table (1 row = 1 MCQ or scenario subquestion), preserving fields for review workflows:
- `kind`, `scenario_id`, `subq_index`, `confidence`, `needs_human_review`, `review_reasons`
- choice columns `A`/`B`/`C`/`D` and `correct_label`

Run:
```bash
python3 scripts/export_questions.py
```

Output files:
- `questions.export.csv` encoded as `utf-8-sig` (Excel-friendly for Polish diacritics)
- `questions.export.xlsx` with sheets: `questions` and `needs_review`

Optional paths:
```bash
python3 scripts/export_questions.py --input questions.corrected.json --out-csv out.csv --out-xlsx out.xlsx
```

#
## Legacy / AI quiz source mode
- The home screen includes a **Question source** switch: `Legacy` (`questions.json`) or `AI` (`ai_questions.json`).
- The selected source is persisted in `localStorage` under `quiz_source`.
- If AI mode is selected and `ai_questions.json` is missing or empty, the app shows: `Brak puli AI. Spróbuj później.`

## Generate AI question pool offline
Use the generator script:

```bash
node scripts/generate_ai_questions.js   --out ai_questions.json   --count 200   --topics gdpr_rights,controller_obligations,lawful_bases,international_transfers,data_breach   --difficulty medium   --seed-prefix 2026-02-10
```

The script reads `OPENAI_API_KEY` from env when available and writes a stable format:
- `version`
- `generated_at`
- `items[]`

## GitHub Actions for automated generation
Two workflow variants are included:
- `.github/workflows/generate-ai-questions-direct.yml` - scheduled/manual run that commits directly to the default branch.
- `.github/workflows/generate-ai-questions-pr.yml` - scheduled/manual run that opens a PR to the default branch.

## Run tests
```bash
npm test
```
