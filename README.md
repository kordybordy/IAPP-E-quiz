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

## OCR repair script (OpenAI Responses API)
Use `scripts/ai_correct_questions.js` to normalize OCR artifacts and optionally reconstruct suspicious records with structured JSON output.

Example:

```bash
OPENAI_API_KEY=... node scripts/ai_correct_questions.js \
  --in questions.json \
  --out questions.corrected.json \
  --scenario-mode group \
  --concurrency 3
```

Key flags:
- `--scenario-mode keep|drop|group` (default: `keep`)
- `--start-id <id>` and `--limit <n>` for partial runs
- `--cache <path>` to reuse prior model outputs
- `--delay-ms <ms>` to throttle requests if needed
