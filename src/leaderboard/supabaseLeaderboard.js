(function attachSupabaseLeaderboard(global) {
  const DEFAULT_LIMIT = 20;
  const SUPABASE_URL = "https://afcwekhfisodipdijicd.supabase.com";
  const SUPABASE_ANON_KEY = "sb_publishable_L7pMKjrigH0hgcYjq4SXmA_8TIY4Wxq";

  function getConfig() {
    return {
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY
    };
  }

  function isConfigured() {
    const cfg = getConfig();
    return Boolean(cfg.url && cfg.anonKey);
  }

  function parseBodyText(text, fallbackMessage) {
    if (!text) return { message: fallbackMessage };
    try {
      return JSON.parse(text);
    } catch (error) {
      return { message: text };
    }
  }

  function validatePayload(payload) {
    const name = String(payload?.name || "").trim();
    if (!name || name.length < 1 || name.length > 30) {
      throw new Error("Name must be between 1 and 30 characters.");
    }

    const score = Number(payload?.score);
    const total = Number(payload?.total);

    if (!Number.isInteger(score) || !Number.isInteger(total) || total <= 0 || score < 0 || score > total) {
      throw new Error("Score data is invalid.");
    }

    let durationSeconds = null;
    if (payload?.durationSeconds != null && payload.durationSeconds !== "") {
      durationSeconds = Number(payload.durationSeconds);
      if (!Number.isInteger(durationSeconds) || durationSeconds < 0) {
        throw new Error("Duration must be a non-negative integer.");
      }
    }

    const mode = payload?.mode != null ? String(payload.mode).trim() : null;

    return {
      name,
      score,
      total,
      mode: mode || null,
      durationSeconds
    };
  }

  async function submitScore(payload) {
    const cfg = getConfig();
    if (!cfg.url || !cfg.anonKey) {
      throw new Error("Global leaderboard not configured.");
    }

    const valid = validatePayload(payload);

    const response = await fetch(`${cfg.url}/rest/v1/leaderboard_scores`, {
      method: "POST",
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([
        {
          name: valid.name,
          score: valid.score,
          total: valid.total,
          duration_seconds: valid.durationSeconds,
          mode: valid.mode
        }
      ])
    });

    const bodyText = await response.text();
    console.log("Supabase submitScore response:", response.status, bodyText);

    if (!response.ok) {
      const details = parseBodyText(bodyText, "Unable to save score");
      throw new Error(details.message || bodyText || "Unable to save score");
    }

    const parsed = parseBodyText(bodyText, "Saved.");
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async function fetchTopScores(options = {}) {
    const cfg = getConfig();
    if (!cfg.url || !cfg.anonKey) {
      throw new Error("Global leaderboard not configured.");
    }

    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
    const query = new URLSearchParams();
    query.set("select", "id,name,score,total,pct,duration_seconds,mode,created_at");
    query.set("order", "pct.desc,score.desc,created_at.desc");
    query.set("limit", String(limit));

    if (options.mode) {
      query.set("mode", `eq.${String(options.mode).trim()}`);
    }

    const response = await fetch(`${cfg.url}/rest/v1/leaderboard_scores?${query.toString()}`, {
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`
      }
    });

    const bodyText = await response.text();
    console.log("Supabase fetchTopScores response:", response.status, bodyText);

    if (!response.ok) {
      const details = parseBodyText(bodyText, "Unable to fetch leaderboard");
      throw new Error(details.message || bodyText || "Unable to fetch leaderboard");
    }

    const rows = parseBodyText(bodyText, "[]");
    return Array.isArray(rows) ? rows : [];
  }

  global.SupabaseLeaderboard = {
    submitScore,
    fetchTopScores,
    isConfigured
  };
})(window);
