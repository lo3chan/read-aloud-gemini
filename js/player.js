
const isEmbedded = top != self
var queryString = new URLSearchParams(location.search)
var activeDoc;
var playbackError = null;
var playbackCompleted = false;
var lastUrlPromise = Promise.resolve(null)

maintainPlaybackWakeLock(async () => {
  const doc = activeDoc
  return !!doc && await doc.getState() == "PLAYING" && doc == activeDoc
})


const idleSubject = new rxjs.BehaviorSubject(true)

if (queryString.has("autoclose")) {
  idleSubject.pipe(
    rxjs.switchMap(isIdle =>
      rxjs.iif(
        () => isIdle,
        rxjs.timer(queryString.get("autoclose") == "long" ? 15*60*1000 : 5*60*1000),
        rxjs.EMPTY
      )
    )
  ).subscribe(closePlayer)
}


var messageHandlers = {
  playText: playText,
  playTab: playTab,
  stop: stop,
  pause: pause,
  resume: resume,
  getPlaybackState: getPlaybackState,
  forward: forward,
  rewind: rewind,
  seek: seek,
  close: closePlayer,
  shouldPlaySilence: shouldPlaySilence.bind({}),
  getLastUrl: () => lastUrlPromise,
}

registerMessageListener("player", messageHandlers)

if (queryString.has("opener")) {
  brapi.runtime.sendMessage({dest: queryString.get("opener"), method: "playerCheckIn"})
    .catch(console.error)
} else {
  bgPageInvoke("playerCheckIn")
    .catch(console.error)
}

document.addEventListener("DOMContentLoaded", initialize)



async function initialize() {
  setI18nText()

  $("#hidethistab-link")
    .toggle(canUseEmbeddedPlayer() && !(await getSettings()).useEmbeddedPlayer)
    .click(function() {
      $("#dialog-backdrop, #hidethistab-dialog").show()
    })

  $("#hidethistab-dialog .btn, #hidethistab-dialog .close")
    .click(function(event) {
      $("#dialog-backdrop, #hidethistab-dialog").hide()
      if ($(event.target).is(".btn-ok")) {
        updateSettings({useEmbeddedPlayer: true})
          .then(() => window.close())
          .catch(console.error)
      }
    })
}

function playText(text, opts) {
  opts = opts || {}
  playbackError = null
  if (!activeDoc) {
    openDoc(new SimpleSource(text.split(/(?:\r?\n){2,}/), {lang: opts.lang}), function(err) {
      if (err) playbackError = err
    })
  }
  const doc = activeDoc
  return activeDoc.play()
    .catch(function(err) {
      if (doc == activeDoc) {
        handleError(err);
        closeDoc();
      }
      throw err;
    })
}

function playTab() {
  playbackError = null
  if (!activeDoc) {
    openDoc(new TabSource(), function(err) {
      if (err) playbackError = err
    })
  }
  const doc = activeDoc
  return activeDoc.play()
    .catch(function(err) {
      if (doc == activeDoc) {
        handleError(err);
        closeDoc();
      }
      throw err;
    })
}

function stop() {
  playbackCompleted = false
  if (activeDoc) {
    activeDoc.stop();
    closeDoc();
  }
  return true;
}

function pause() {
  if (activeDoc) return activeDoc.pause();
  else return Promise.resolve();
}

function resume() {
  if (activeDoc) return activeDoc.play()
  else return Promise.resolve()
}

function getPlaybackState() {
  if (activeDoc) {
    return Promise.all([activeDoc.getState(), activeDoc.getActiveSpeech()])
      .then(function(results) {
        return {
          state: results[0],
          speechInfo: results[1] && results[1].getInfo(),
          playbackError: errorToJson(playbackError),
        }
      })
      .finally(() => {
        playbackError = null
      })
  }
  else {
    return {
      state: "STOPPED",
      playbackCompleted,
      playbackError: errorToJson(playbackError),
    }
  }
}

function openDoc(source, onEnd) {
  playbackCompleted = false
  const doc = new Doc(source, function(err) {
    if (activeDoc !== doc) return
    playbackCompleted = !err
    handleError(err);
    closeDoc();
    if (typeof onEnd == "function") onEnd(err);
  })
  activeDoc = doc
  idleSubject.next(false)
  lastUrlPromise = Promise.resolve(source.getUri())
}

function closeDoc() {
  if (activeDoc) {
    activeDoc.close();
    activeDoc = null;
    idleSubject.next(true)
  }
}

function forward() {
  if (activeDoc) return activeDoc.forward();
  else return Promise.reject(new Error("Can't forward, not active"));
}

function rewind() {
  if (activeDoc) return activeDoc.rewind();
  else return Promise.reject(new Error("Can't rewind, not active"));
}

function seek(n) {
  if (activeDoc) return activeDoc.seek(n);
  else return Promise.reject(new Error("Can't seek, not active"));
}

function closePlayer() {
  if (top == self) window.close()
  else location.href = "about:blank"
}

function handleError(err) {
  if (err) {
    var code = /^{/.test(err.message) ? JSON.parse(err.message).code : err.message;
    if (code == "error_payment_required") clearSettings(["voiceName"]);
    reportError(err);
  }
}

function reportError(err) {
  if (err && err.stack) {
    var details = err.stack;
    if (!details.startsWith(err.name)) details = err.name + ": " + err.message + "\n" + details;
    console.error(details)
  }
}

function playAudio(urlPromise, options, playbackState$) {
  if (brapi.offscreen || isFirefox()) {
    return playAudioOffscreen(urlPromise, options, playbackState$)
  }
  else {
    return playAudioHere(requestAudioPlaybackPermission().then(() => urlPromise), options, playbackState$)
  }
}

var audioPlaybackPermissionPromise = null
function requestAudioPlaybackPermission() {
  if (audioPlaybackPermissionPromise) return audioPlaybackPermissionPromise
  audioPlaybackPermissionPromise = (async function() {
    try {
      await promiseTimeout(
        500,
        "Audio autoplay timed out",
        new Audio(brapi.runtime.getURL("sound/silence.mp3")).play()
      )
      return
    } catch (err) {
      // Autoplay blocked or timed out: prompt user on player tab
    }
    const thisTab = await brapi.tabs.getCurrent()
    if (!thisTab) {
      try {
        $("#dialog-backdrop, #audio-playback-permission-dialog").show()
        await new Promise(f => $("#audio-playback-permission-button").one("click", f))
        await new Audio(brapi.runtime.getURL("sound/silence.mp3")).play()
      } finally {
        $("#dialog-backdrop, #audio-playback-permission-dialog").hide()
      }
      return
    }
    const prevTab = await brapi.tabs.query(thisTab.windowId != null ? {windowId: thisTab.windowId, active: true} : {active: true})
      .then(tabs => tabs[0])
      .catch(() => null)
    try {
      if (!thisTab.active) await brapi.tabs.update(thisTab.id, {active: true}).catch(() => {})
      $("#dialog-backdrop, #audio-playback-permission-dialog").show()
      await new Promise(f => $("#audio-playback-permission-button").one("click", f))
      await new Audio(brapi.runtime.getURL("sound/silence.mp3")).play()
    } finally {
      $("#dialog-backdrop, #audio-playback-permission-dialog").hide()
      if (prevTab && prevTab.id !== thisTab.id) {
        await brapi.tabs.update(prevTab.id, {active: true}).catch(() => {})
      }
    }
  })().catch(err => {
    audioPlaybackPermissionPromise = null
    throw err
  })
  return audioPlaybackPermissionPromise
}

// Commands are ordered even when RxJS cancels a pending asynchronous start.
// Session IDs make late cleanup and events harmless to subsequent playback.
var offscreenCommandQueue = Promise.resolve()
var offscreenEventHandlers = new Map()
messageHandlers.offscreenPlaybackEvent = (event, id) => {
  const handler = offscreenEventHandlers.get(id)
  if (handler) handler(event, id)
}
function queueOffscreenCommand(command) {
  const result = offscreenCommandQueue.then(command)
  offscreenCommandQueue = result.catch(() => {})
  return result
}

function playAudioOffscreen(urlPromise, options, playbackState$) {
  return new rxjs.Observable(observer => {
    const id = crypto.randomUUID()
    let disposed = false
    let revision = 0
    let subscription
    const toError = err => err instanceof Error
      ? err
      : Object.assign(new Error((err && (err.message || err.name)) || String(err || "Audio playback error")), err && typeof err == "object" ? err : null)
    const eventHandler = (event, sessionId) => {
      if (sessionId != id || disposed) return
      if (event.type == "error") observer.error(toError(event.error))
      else {
        observer.next(event)
        if (event.type == "end") observer.complete()
      }
    }
    offscreenEventHandlers.set(id, eventHandler)

    Promise.resolve(urlPromise).then(url => {
      if (disposed) return
      subscription = playbackState$.pipe(rxjs.distinctUntilChanged()).subscribe({
        next(state) {
          const request = ++revision
          queueOffscreenCommand(async () => {
            if (disposed || request != revision) return
            if (state != "resumed") {
              await sendToOffscreen({method: "pause", args: [id]}).catch(() => {})
              return
            }
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                await offscreenTimeout(() => bgPageInvoke("ensureOffscreen"), 45000)
                if (disposed || request != revision) return
                // Idempotent for this session: resume existing audio, or start
                // again if Chrome discarded the document while it was paused.
                const result = await sendToOffscreen({method: "play", args: [url, options, id]})
                if (result !== true) throw new Error("Offscreen document inaccessible")
                return
              } catch (err) {
                if (disposed || request != revision) return
                if (attempt || err.offscreenApplicationError) throw err
              }
            }
          }).catch(err => {
            if (!disposed && request == revision) observer.error(err)
          })
        },
        error: err => observer.error(err)
      })
    }, err => observer.error(err))

    return () => {
      disposed = true
      revision++
      if (subscription) subscription.unsubscribe()
      offscreenEventHandlers.delete(id)
      queueOffscreenCommand(() => sendToOffscreen({method: "stop", args: [id]})).catch(() => {})
    }
  })
}

async function offscreenTimeout(operation, timeout = 5000) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => timer = setTimeout(() => reject(new Error("Offscreen operation timed out")), timeout))
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function sendToOffscreen(message) {
  const result = await offscreenTimeout(() => brapi.runtime.sendMessage({...message, dest: "offscreen"}))
  if (result && result.error) {
    const err = new Error(result.error.message || String(result.error))
    err.offscreenApplicationError = true
    throw err
  }
  return result
}

async function shouldPlaySilence(providerId) {
  const should = await getPlaybackState().then(x => x.state == "PLAYING")
  const now = Date.now()
  if (providerId == this.providerId) {
    this.nextExpectedCheckIn = now + (now - this.lastCheckIn)
    this.lastCheckIn = now
    return should
  }
  else {
    if (now < this.nextExpectedCheckIn) {
      return false
    }
    else {
      this.providerId = providerId
      this.lastCheckIn = now
      return should
    }
  }
}
