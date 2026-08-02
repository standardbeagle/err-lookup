/**
 * Provider peak-pricing window.
 *
 * The GLM Coding Plan bills off-peak usage at 50% of the standard credit rate;
 * peak is Mon–Fri 14:00–18:00 Singapore time (UTC+8), i.e. 06:00–10:00 UTC.
 * Work deferred out of that window costs half as many credits for the same
 * output, so a long unattended scan should wait rather than spend double.
 */
export interface PeakWindow {
  /** First UTC hour of the window (inclusive). */
  startUtcHour: number;
  /** Last UTC hour of the window (exclusive). */
  endUtcHour: number;
  /** Peak applies Monday–Friday only; weekends are entirely off-peak. */
  weekdaysOnly: boolean;
}

export const GLM_PEAK: PeakWindow = { startUtcHour: 6, endUtcHour: 10, weekdaysOnly: true };

export function isPeak(now: Date, w: PeakWindow = GLM_PEAK): boolean {
  if (w.weekdaysOnly) {
    const day = now.getUTCDay(); // 0 Sun … 6 Sat
    if (day === 0 || day === 6) return false;
  }
  const hour = now.getUTCHours();
  return hour >= w.startUtcHour && hour < w.endUtcHour;
}

/**
 * Milliseconds until the current peak window ends, or 0 when off-peak.
 * Computed to the exact hour boundary so a paused run resumes the moment the
 * cheaper rate applies rather than at the next poll.
 */
export function msUntilOffPeak(now: Date, w: PeakWindow = GLM_PEAK): number {
  if (!isPeak(now, w)) return 0;
  const end = new Date(now);
  end.setUTCHours(w.endUtcHour, 0, 0, 0);
  return Math.max(0, end.getTime() - now.getTime());
}
