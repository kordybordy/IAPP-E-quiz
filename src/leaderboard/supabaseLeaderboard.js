(function attachSupabaseLeaderboard(global) {
  const DEFAULT_LIMIT = 20;
  const SUPABASE_URL = "https://afcwekhfisodipdijicd.supabase.co";
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

  function parseJsonSafe(response, fallbackMessage) {
    return response
      .json()
      .catch(() => ({ message: fallbackMessage }));
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

    let durationSeconds;
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

    const headers = {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`
    };

    const response = await fetch(`${cfg.url}/rest/v1/leaderboard_scores`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([
        {
          name: valid.name,
          score: valid.score,
          total: valid.total,
          mode: valid.mode,
          duration_seconds: valid.durationSeconds
        }
      ])
    });

    if (!response.ok) {
      const details = await parseJsonSafe(response, "Unable to save score");
      throw new Error(details.message || "Unable to save score");
    }

    return parseJsonSafe(response, "Saved.");
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

    const headers = {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`
    };

    const response = await fetch(`${cfg.url}/rest/v1/leaderboard_scores?${query.toString()}`, {
      headers
    });

    if (!response.ok) {
      const details = await parseJsonSafe(response, "Unable to fetch leaderboard");
      throw new Error(details.message || "Unable to fetch leaderboard");
    }

    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  }

  global.SupabaseLeaderboard = {
    submitScore,
    fetchTopScores,
    isConfigured
  };
})(window);
