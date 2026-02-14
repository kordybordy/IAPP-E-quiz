(function attachPoints(global) {
  const FEEDBACK_MODE = "feedback";

  const POINT_RULES = {
    correctBase: 100,
    wrongBase: 0,
    streakBonusStep: 15,
    speedBonusThresholdSeconds: 20,
    speedBonus: 20,
    hintPenalty: 25,
    skipPenalty: 50
  };

  function toFiniteNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function clampNonNegative(value) {
    return Math.max(0, Math.floor(toFiniteNumber(value, 0)));
  }

  function ensureFeedbackState(attempt) {
    if (!attempt.feedback || typeof attempt.feedback !== "object") {
      attempt.feedback = {};
    }

    if (!Array.isArray(attempt.feedback.scoredQids)) {
      attempt.feedback.scoredQids = [];
    }

    return attempt.feedback;
  }


  function ensureStatsState(attempt) {
    if (!attempt.stats || typeof attempt.stats !== "object") {
      attempt.stats = {};
    }

    if (!Number.isFinite(Number(attempt.stats.correctCount))) {
      attempt.stats.correctCount = 0;
    }

    if (!Number.isFinite(Number(attempt.stats.fastCorrectCount))) {
      attempt.stats.fastCorrectCount = 0;
    }

    if (!Number.isFinite(Number(attempt.stats.skippedCount))) {
      attempt.stats.skippedCount = 0;
    }

    return attempt.stats;
  }

  function awardPoints(attempt, { isCorrect, timeTaken, usedHint, skipped, questionId } = {}) {
    if (!attempt || typeof attempt !== "object") {
      return {
        awarded: 0,
        totalPoints: 0,
        streak: 0,
        duplicate: false,
        breakdown: {
          base: 0,
          streakBonus: 0,
          speedBonus: 0,
          penalties: 0
        }
      };
    }

    attempt.points = clampNonNegative(attempt.points);
    attempt.streak = clampNonNegative(attempt.streak);

    const feedback = ensureFeedbackState(attempt);
    const stats = ensureStatsState(attempt);

    if (attempt.mode === FEEDBACK_MODE && questionId) {
      const alreadyScored = feedback.scoredQids.includes(questionId);
      if (alreadyScored) {
        return {
          awarded: 0,
          totalPoints: attempt.points,
          streak: attempt.streak,
          duplicate: true,
          breakdown: {
            base: 0,
            streakBonus: 0,
            speedBonus: 0,
            penalties: 0
          }
        };
      }
      feedback.scoredQids.push(questionId);
    }

    const correct = !!isCorrect;
    const skippedQuestion = !!skipped;

    if (correct && !skippedQuestion) {
      attempt.streak += 1;
    } else {
      attempt.streak = 0;
    }

    const base = correct && !skippedQuestion ? POINT_RULES.correctBase : POINT_RULES.wrongBase;
    const streakBonus = attempt.streak > 1
      ? (attempt.streak - 1) * POINT_RULES.streakBonusStep
      : 0;

    const speedBonus = correct && !skippedQuestion && toFiniteNumber(timeTaken, Number.POSITIVE_INFINITY) <= POINT_RULES.speedBonusThresholdSeconds
      ? POINT_RULES.speedBonus
      : 0;

    const penalties = (usedHint ? POINT_RULES.hintPenalty : 0) + (skippedQuestion ? POINT_RULES.skipPenalty : 0);

    const awarded = clampNonNegative(base + streakBonus + speedBonus - penalties);

    if (correct && !skippedQuestion) {
      stats.correctCount += 1;
      if (toFiniteNumber(timeTaken, Number.POSITIVE_INFINITY) <= POINT_RULES.speedBonusThresholdSeconds) {
        stats.fastCorrectCount += 1;
      }
    }

    if (skippedQuestion) {
      stats.skippedCount += 1;
    }

    attempt.points += awarded;

    return {
      awarded,
      totalPoints: attempt.points,
      streak: attempt.streak,
      duplicate: false,
      breakdown: {
        base,
        streakBonus,
        speedBonus,
        penalties
      }
    };
  }

  global.awardPoints = awardPoints;
})(window);
