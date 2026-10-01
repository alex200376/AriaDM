import { describe, expect, it } from 'vitest'

import { SpeedMeter } from '../../src/main/downloads/speed-meter'

describe('SpeedMeter', () => {
  it('records samples with their timestamp', () => {
    const meter = new SpeedMeter(10)
    meter.push(1000, 0, 1_000)
    meter.push(2000, 500, 2_000)

    expect(meter.series()).toEqual([
      { at: 1_000, download: 1000, upload: 0 },
      { at: 2_000, download: 2000, upload: 500 }
    ])
  })

  it('clamps negative rates to zero rather than plotting nonsense', () => {
    const meter = new SpeedMeter(10)
    meter.push(-5, -5, 1_000)
    expect(meter.series()[0]).toEqual({ at: 1_000, download: 0, upload: 0 })
  })

  it('keeps only the newest samples once full', () => {
    const meter = new SpeedMeter(2)
    meter.push(1, 0, 1)
    meter.push(2, 0, 2)
    meter.push(3, 0, 3)
    expect(meter.series().map((sample) => sample.download)).toEqual([2, 3])
  })

  it('hands out copies so a consumer cannot corrupt the history', () => {
    const meter = new SpeedMeter(2)
    meter.push(100, 0, 1)
    const series = meter.series()
    series[0]!.download = 99_999
    expect(meter.series()[0]!.download).toBe(100)
  })

  it('reports peak and average download rate', () => {
    const meter = new SpeedMeter(10)
    meter.push(1000, 0, 1_000)
    meter.push(3000, 0, 2_000)
    expect(meter.peakDownload).toBe(3000)
    expect(meter.averageDownload).toBe(2000)
  })

  it('integrates transferred bytes over real elapsed time', () => {
    const meter = new SpeedMeter(10)
    // Two samples one second apart, both 1000 B/s: 1000 bytes moved.
    meter.push(1000, 0, 1_000)
    meter.push(1000, 0, 2_000)
    expect(meter.transferredBytes).toBe(1000)
  })

  it('is empty and zeroed before any sample', () => {
    const meter = new SpeedMeter(10)
    expect(meter.series()).toEqual([])
    expect(meter.peakDownload).toBe(0)
    expect(meter.averageDownload).toBe(0)
    expect(meter.transferredBytes).toBe(0)
  })

  it('drops history on reset', () => {
    const meter = new SpeedMeter(10)
    meter.push(1000, 0, 1_000)
    meter.reset()
    expect(meter.series()).toEqual([])
  })
})
