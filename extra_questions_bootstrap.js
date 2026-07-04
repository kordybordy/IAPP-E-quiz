(function attachExtraQuestionsBootstrap(global) {
  const originalFetch = global.fetch.bind(global);

  function isQuestionsRequest(input) {
    const url = typeof input === "string" ? input : input && input.url;
    if (!url) return false;
    try {
      const parsed = new URL(url, global.location.href);
      return parsed.pathname.endsWith("/questions.json") || parsed.pathname === "/questions.json";
    } catch (error) {
      return String(url).endsWith("questions.json");
    }
  }

  function mergeBanks(primary, extra) {
    const primaryQuestions = Array.isArray(primary && primary.questions) ? primary.questions : [];
    const extraQuestions = Array.isArray(extra && extra.questions) ? extra.questions : [];
    const byId = new Map(primaryQuestions.map((question) => [String(question.id), question]));

    extraQuestions.forEach((question) => {
      if (!question || question.id == null) return;
      byId.set(String(question.id), question);
    });

    const questions = Array.from(byId.values());
    return {
      ...primary,
      question_count: questions.length,
      questions
    };
  }

  global.fetch = async function fetchWithExtraQuestions(input, init) {
    const response = await originalFetch(input, init);
    if (!isQuestionsRequest(input)) return response;

    try {
      const [primary, extraResponse] = await Promise.all([
        response.clone().json(),
        originalFetch("extra_questions.json", { cache: "no-store" })
      ]);

      if (!extraResponse.ok) return response;

      const merged = mergeBanks(primary, await extraResponse.json());
      return new Response(JSON.stringify(merged), {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      return response;
    }
  };
})(window);
