function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying on failure with exponential backoff.
 * Calls onAttemptFail(attemptNumber, error) after each failed attempt.
 */
async function retryWithBackoff(fn, { retries = 3, delaysMs = [2000, 4000, 8000], onAttemptFail } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry permanent errors (e.g. EBLOCKED, EOVERQUOTA, wrong credentials)
      if (err.nonRetryable) throw err;
      if (onAttemptFail) onAttemptFail(attempt + 1, err);
      if (attempt < retries) {
        await sleep(delaysMs[attempt] || delaysMs[delaysMs.length - 1]);
      }
    }
  }
  throw lastErr;
}

module.exports = { sleep, retryWithBackoff };
