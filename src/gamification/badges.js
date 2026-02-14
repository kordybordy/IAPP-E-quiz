(function attachBadges(global) {
  const BADGE_DEFS = [
    {
      id: "first_correct",
      label: "First Correct",
      awardedWhen: (attempt) => Number(attempt?.stats?.correctCount || 0) >= 1
    },
    {
      id: "hot_streak",
      label: "Hot Streak",
      awardedWhen: (attempt) => Number(attempt?.streak || 0) >= 3
    },
    {
      id: "speedster",
      label: "Speedster",
      awardedWhen: (attempt) => Number(attempt?.stats?.fastCorrectCount || 0) >= 5
    },
    {
      id: "points_500",
      label: "500 Club",
      awardedWhen: (attempt) => Number(attempt?.points || 0) >= 500
    }
  ];

  function ensureBadgesState(attempt) {
    if (!attempt.badges || !Array.isArray(attempt.badges)) {
      attempt.badges = [];
    }
    return attempt.badges;
  }

  function checkAndAwardBadges(attempt) {
    if (!attempt || typeof attempt !== "object") {
      return [];
    }

    const existing = new Set(ensureBadgesState(attempt));
    const newlyAwarded = [];

    BADGE_DEFS.forEach((badgeDef) => {
      if (!existing.has(badgeDef.id) && badgeDef.awardedWhen(attempt)) {
        existing.add(badgeDef.id);
        newlyAwarded.push(badgeDef.id);
      }
    });

    attempt.badges = Array.from(existing);

    return newlyAwarded;
  }

  global.checkAndAwardBadges = checkAndAwardBadges;
})(window);
