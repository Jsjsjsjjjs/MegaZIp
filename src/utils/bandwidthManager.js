'use strict';

const EventEmitter = require('events');

/**
 * Global shared manager to handle MEGA rate limits and bandwidth quotas.
 * Automatically pauses download operations when bandwidth limits are hit
 * and resumes when the wait period expires.
 */
class BandwidthManager extends EventEmitter {
  constructor() {
    super();
    this.pausedUntil = 0;
    this.lastWaitSeconds = 0;
    this.reason = null;
    this.timer = null;
  }

  isPaused() {
    return Date.now() < this.pausedUntil;
  }

  getRemainingSeconds() {
    if (!this.isPaused()) return 0;
    return Math.max(0, Math.ceil((this.pausedUntil - Date.now()) / 1000));
  }

  /**
   * Triggers a bandwidth limit pause.
   * @param {number} waitSeconds - Seconds to wait before resuming.
   * @param {string} source - Component reporting the limit (e.g. 'mirrorEngine', 'downloadEngine').
   */
  triggerPause(waitSeconds, source = 'system') {
    const sec = Math.max(120, parseInt(waitSeconds, 10) || 3600);
    const newPauseUntil = Date.now() + (sec * 1000);

    if (newPauseUntil > this.pausedUntil) {
      this.pausedUntil = newPauseUntil;
      this.lastWaitSeconds = sec;
      const hrs = (sec / 3600).toFixed(2);
      this.reason = `MEGA bandwidth limit reached (${sec}s / ~${hrs} hrs wait)`;

      const resumeTimeStr = new Date(this.pausedUntil).toLocaleTimeString();
      console.warn(`[BandwidthManager] ⏳ Bandwidth limit hit via ${source}! Pausing download operations for ${sec}s (~${hrs} hrs). Auto-resuming at ${resumeTimeStr}`);

      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.clearPause();
      }, sec * 1000);

      this.emit('paused', {
        waitSeconds: sec,
        resumeAt: new Date(this.pausedUntil).toISOString(),
        source,
        reason: this.reason,
      });
    }
  }

  /**
   * Manually or automatically clears the bandwidth pause.
   */
  clearPause() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const wasPaused = this.pausedUntil > 0;
    this.pausedUntil = 0;
    this.reason = null;

    if (wasPaused) {
      console.log(`[BandwidthManager] 🟢 Bandwidth limit wait period expired. Resuming all operations.`);
      this.emit('resumed');
    }
  }

  /**
   * Asynchronously waits until any active bandwidth pause expires.
   */
  async waitUntilResumed() {
    while (this.isPaused()) {
      const rem = this.getRemainingSeconds();
      const sleepTime = Math.min(10000, rem * 1000);
      await new Promise((r) => setTimeout(r, Math.max(1000, sleepTime)));
    }
  }

  getStatus() {
    return {
      paused: this.isPaused(),
      remainingSeconds: this.getRemainingSeconds(),
      resumeAt: this.isPaused() ? new Date(this.pausedUntil).toISOString() : null,
      reason: this.reason,
    };
  }
}

// Singleton instance
module.exports = new BandwidthManager();
