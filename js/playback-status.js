// Estimate remaining speaking time normalized to 1.0x base speed, scaling immediately with playback rate.
function createPlaybackEstimate() {
  const DEFAULT_BASE_CPS = 15; // ~180 WPM at 1.0x
  let previous, baseline, baseElapsed = 0, measuredBaseCps = null
  return {update(state, speech, now, rate) {
    if (!speech || state === 'STOPPED') {
      previous = baseline = null
      baseElapsed = 0
      measuredBaseCps = null
      return null
    }
    const activeRate = Math.max(0.25, Number(rate || speech.rate || 1) || 1)
    const texts = speech.texts || []
    const index = Math.max(0, speech.position?.index || 0)
    const total = texts.reduce((sum, text) => sum + text.length, 0)
    const read = texts.slice(0, index).reduce((sum, text) => sum + text.length, 0)
    const key = `${speech.statusId}:${speech.navigationRevision}`
    if (!previous || previous.key !== key || read < previous.read || total !== previous.total) {
      baseline = null
      baseElapsed = 0
      measuredBaseCps = null
    } else {
      if (state === 'PLAYING' && previous.state === 'PLAYING' && now - previous.now < 2000) {
        baseElapsed += ((now - previous.now) / 1000) * activeRate
      }
      if (read > previous.read) {
        if (!baseline) baseline = {read, baseElapsed}
        else if (baseElapsed - baseline.baseElapsed >= 5) {
          const cps = (read - baseline.read) / (baseElapsed - baseline.baseElapsed)
          if (cps > 0) measuredBaseCps = cps
        }
      }
    }
    previous = {key, read, total, now, state}
    const baseCps = measuredBaseCps || DEFAULT_BASE_CPS
    const seconds = total > read ? (total - read) / (baseCps * activeRate) : 0
    return {percent: total ? Math.min(100, Math.floor(100 * read / total)) : 0, seconds}
  }}
}
