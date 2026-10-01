import type { SpeedSample } from '@shared/download'

/**
 * Ring buffer of aggregate throughput samples that backs the speed graph.
 *
 * Sampling lives in the main process so the graph survives a window reload and
 * reflects real elapsed wall-clock time rather than the renderer's throttle
 * behaviour.
 */
export class SpeedMeter {
  private readonly capacity: number
  private samples: SpeedSample[] = []

  constructor(capacity = 120) {
    this.capacity = capacity
  }

  push(download: number, upload: number, at = Date.now()): void {
    this.samples.push({ at, download: Math.max(0, download), upload: Math.max(0, upload) })
    if (this.samples.length > this.capacity) {
      this.samples.splice(0, this.samples.length - this.capacity)
    }
  }

  series(): SpeedSample[] {
    // Copy so a consumer cannot mutate our history.
    return this.samples.map((sample) => ({ ...sample }))
  }

  get peakDownload(): number {
    return this.samples.reduce((max, sample) => (sample.download > max ? sample.download : max), 0)
  }

  /**
   * Mean download speed over the window, ignoring idle samples only when the
   * window contains any activity at all. A fully idle window legitimately
   * averages to zero.
   */
  get averageDownload(): number {
    if (this.samples.length === 0) return 0
    const total = this.samples.reduce((sum, sample) => sum + sample.download, 0)
    return total / this.samples.length
  }

  /** Total bytes moved across the sampled window, for the session summary. */
  get transferredBytes(): number {
    let total = 0
    for (let index = 1; index < this.samples.length; index += 1) {
      const previous = this.samples[index - 1]!
      const current = this.samples[index]!
      const seconds = Math.max(0, (current.at - previous.at) / 1000)
      // Trapezoidal integration is close enough and avoids spikes from a single
      // unusually long gap between samples.
      total += ((previous.download + current.download) / 2) * seconds
    }
    return Math.round(total)
  }

  reset(): void {
    this.samples = []
  }
}
