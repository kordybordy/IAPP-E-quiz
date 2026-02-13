(function attachSupabaseLeaderboard(global) {
  const DEFAULT_LIMIT = 20;
  const SUPABASE_URL = "https://afcwekhfisodipdijicd.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_L7pMKjrigH0hgcYjq4SXmA_8TIY4Wxq";
  const NETWORK_ERROR_MESSAGE = "Cannot reach global leaderboard (network/CORS). Check Supabase URL and allowed origins.";

  function getConfig() {
    return {
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY
    };
  }

  function normalizeAndValidateSupabaseUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) {
      throw new Error("Global leaderboard URL is missing.");
    }

    let parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw new Error("Global leaderboard URL is invalid. Expected format: https://<project-ref>.supabase.co");
    }

    if (parsed.protocol !== "https:") {
      throw new Error("Global leaderboard URL must use HTTPS.");
    }

    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error("Global leaderboard URL must be the base project URL only (no path, query, or auth data).");
    }

    if (!/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)) {
      throw new Error("Global leaderboard URL must match: https://<project-ref>.supabase.co");
    }

    return parsed.origin;
  }

  function getValidatedConfig() {
    const cfg = getConfig();
    if (!cfg.url || !cfg.anonKey) {
      throw new Error("Global leaderboard not configured.");
    }

    return {
      url: normalizeAndValidateSupabaseUrl(cfg.url),
      anonKey: cfg.anonKey
    };
  }

  function isConfigured() {
    try {
      getValidatedConfig();
      return true;
    } catch (error) {
      return false;
    }
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
    const cfg = getValidatedConfig();

    const valid = validatePayload(payload);

    const headers = {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`
    };

    let response;
    try {
      response = await fetch(`${cfg.url}/rest/v1/leaderboard_scores`, {
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
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(NETWORK_ERROR_MESSAGE);
      }
      throw error;
    }

    if (!response.ok) {
      const details = await parseJsonSafe(response, "Unable to save score");
      throw new Error(details.message || "Unable to save score");
    }

    return parseJsonSafe(response, "Saved.");
  }

  async function fetchTopScores(options = {}) {
    const cfg = getValidatedConfig();

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

    let response;
    try {
      response = await fetch(`${cfg.url}/rest/v1/leaderboard_scores?${query.toString()}`, {
        headers
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(NETWORK_ERROR_MESSAGE);
      }
      throw error;
    }

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
