
(function() {
  const queryString = getQueryString()
  const domReadyPromise = domReady()
  const playerCheckIn$ = new rxjs.Subject()

  registerMessageListener("options", {
    playerCheckIn() {
      playerCheckIn$.next()
    }
  })


  //i18n
  domReadyPromise
    .then(setI18nText)



  //close button
  domReadyPromise
    .then(() => {
      if (queryString.referer) {
        $("button.close").show()
          .click(function() {
            history.back();
          })
      }
    })



  //account button
  domReadyPromise
    .then(() => {
      $("#account-button")
        .click(function() {
          getAuthToken({interactive: true})
            .then(token => brapi.tabs.create({url: config.webAppUrl + "/premium-voices.html?t=" + token}))
            .catch(handleError)
          return false;
        })
      $("#logout-button")
        .click(function() {
          clearAuthToken()
          return false;
        })
    })

  rxjs.combineLatest([
      observeSetting("authToken").pipe(
        rxjs.switchMap(token => token ? getAccountInfo(token) : Promise.resolve(null))
      ),
      domReadyPromise
    ])
    .subscribe(([account]) => showAccountInfo(account))



  //hotkey
  domReadyPromise
    .then(() => {
      $("#hotkeys-link").click(function() {
        brapi.tabs.create({url: getHotkeySettingsUrl()});
      });
    })



  domReadyPromise.then(() => {
    initSettingInfoPopup("rate-info-button", "rate-warning", "rate", "options_rate_information")
  })

  //voice
  domReadyPromise
    .then(() => {
      $("#voices")
        .change(function() {
          var voiceName = $(this).val();
          if (voiceName == "@custom") brapi.tabs.create({url: "custom-voices.html"});
          else updateSettings({voiceName})
        });
    })

  const voicesPopulatedObservable = rxjs.combineLatest([
    voices$,
    observeSetting("languages"),
    brapi.i18n.getAcceptLanguages().catch(err => {console.error(err); return []}),
    domReadyPromise
  ]).pipe(
      rxjs.tap(([voices, languages, acceptLangs]) => populateVoices(voices, {languages}, acceptLangs)),
      rxjs.share()
    )

  rxjs.combineLatest([observeSetting("voiceName"), voicesPopulatedObservable])
    .subscribe(([voiceName]) => {
      $("#voices").val(voiceName || "")
    })

  domReadyPromise.then(() => {
    const voiceInfoBtn = document.getElementById("voice-info-button");
    const voiceInfo = document.getElementById("voice-info");
    if (voiceInfoBtn) voiceInfoBtn.hidden = true;
    if (voiceInfo) voiceInfo.hidden = true;
  })



  //rate
  const rateSliderPromise = domReadyPromise
    .then(() => {
      const slider = createSlider($("#rate").get(0), {
          onChange(value) {
            const rate = Number(Math.pow($("#rate").data("pow"), value).toFixed(3))
            const v = $("#voices").val() || ""
            const patch = { rate }
            if (v) patch["rate" + v] = rate
            updateSettings(patch)
          }
        })
      $("#rate-edit-button")
        .click(function() {
          $("#rate, #rate-input-div").toggle();
        });
      $("#rate-input")
        .change(function() {
          var val = $(this).val().trim();
          if (isNaN(val)) $(this).val(1);
          else if (val < .1) $(this).val(.1);
          else if (val > 10) $(this).val(10);
          else $("#rate-edit-button").hide();
          updateSetting("rate" + $("#voices").val(), Number($(this).val()))
        });
      return slider
    })

  const rateObservable = observeSetting("voiceName")
    .pipe(
      rxjs.switchMap(voiceName => observeSetting("rate" + (voiceName || ""))),
      rxjs.share()
    )

  rxjs.combineLatest([rateObservable, rateSliderPromise])
    .subscribe(([rate, slider]) => {
      slider.setValue(Math.log(rate || defaults.rate) / Math.log($("#rate").data("pow")))
      $("#rate-input").val(rate || defaults.rate)
    })

  rxjs.combineLatest([observeSetting("voiceName"), rateObservable, domReadyPromise])
    .subscribe(([voiceName, rate]) => {
      document.getElementById("rate-info-button").hidden = !((!voiceName || isNativeVoice({voiceName})) && rate > 2)
      document.getElementById("rate-warning").hidden = true
      document.getElementById("rate-info-button").setAttribute("aria-expanded", "false")
    })



  //volume
  const volumeSliderPromise = domReadyPromise
    .then(() => {
      return createSlider($("#volume").get(0), {
          onChange(value) {
            updateSettings({volume: value})
          }
        })
    })

  rxjs.combineLatest([observeSetting("volume"), volumeSliderPromise])
    .subscribe(([volume, slider]) => slider.setValue(volume || defaults.volume))



  //showHighlighting
  domReadyPromise
    .then(() => {
      $("#show-highlighting")
        .change(function() {
          updateSettings({showHighlighting: $(this).val()})
        })
    })

  rxjs.combineLatest([observeSetting("showHighlighting"), domReadyPromise])
    .subscribe(([showHighlighting]) => $("#show-highlighting").val(showHighlighting || defaults.showHighlighting))



  //audioPlayback
  Promise.all([brapi.storage.local.get(["useEmbeddedPlayer"]), domReadyPromise])
    .then(([settings]) => {
      $("#audio-playback")
        .change(function() {
          updateSettings({useEmbeddedPlayer: JSON.parse($(this).val())})
          brapi.runtime.sendMessage({dest: "player", method: "close"})
            .catch(err => "OK")
        })
      $(".audio-playback-visible").toggle(settings.useEmbeddedPlayer ? true : false)
    })

  rxjs.combineLatest([observeSetting("useEmbeddedPlayer"), domReadyPromise])
    .subscribe(([useEmbeddedPlayer]) => {
      $("#audio-playback").val(useEmbeddedPlayer ? "true" : "false")
    })



  //voiceTest
  const demoSpeech = {
    get() {
      return Promise.resolve({
        text: "Movies, oh my gosh, I just absolutely love them. They're like time machines taking you to different worlds."
      })
    }
  }
  const voiceTestSubject = new rxjs.Subject()
  rxjs.defer(() => domReadyPromise).pipe(
    rxjs.exhaustMap(() =>
      voiceTestSubject.pipe(
        rxjs.switchScan(({state}) =>
          rxjs.iif(
            () => state == "STOPPED",
            //play
            rxjs.defer(() => {
              return voices$.pipe(rxjs.take(1))
            }).pipe(
              rxjs.exhaustMap(voices => {
                const voiceName = $("#voices").val()
                const voice = voiceName && findVoiceByName(voices, voiceName)
                const {lang} = parseLang(voice && getFirstLanguage(voice) || "en-US")
                return rxjs.defer(() => demoSpeech.get(lang)).pipe(
                  rxjs.exhaustMap(({text}) => bgPageInvoke("playText", [text, {lang}]))
                )
              }),
              rxjs.exhaustMap(() =>
                rxjs.timer(100, 500).pipe(
                  rxjs.exhaustMap(() => bgPageInvoke("getPlaybackState")),
                  rxjs.filter(Boolean),
                  rxjs.takeWhile(({state}) => state != "STOPPED", true)
                )
              )
            ),
            //stop
            rxjs.defer(() => bgPageInvoke("stop")).pipe(
              rxjs.map(() => ({state: "STOPPED"}))
            )
          ),
          {state: "STOPPED"}
        ),
        rxjs.startWith({state: "STOPPED"})
      )
    )
  ).subscribe({
    next({state, playbackError}) {
      $("#test-voice .spinner").toggle(state == "LOADING")
      $("#test-voice [data-i18n]").text(
        brapi.i18n.getMessage(state == "STOPPED" ? "options_test_button" : "options_stop_button")
      )
      if (state == "STOPPED" && playbackError) handleError(playbackError)
      else $("#status").parent().hide()
    },
    error: handleError
  })



  //buttons
  domReadyPromise
    .then(() => {
      $("#test-voice").click(() => voiceTestSubject.next())
      $("#open-diagnostics").click(() => brapi.tabs.create({url: "custom-voices.html"}))
      $("#reset")
        .click(function() {
          clearSettings()
        });
    })

  // Gemini TTS inline settings in Options
  rxjs.combineLatest([
    observeSetting("geminiCreds"),
    observeSetting("gcpToken"),
    domReadyPromise
  ]).subscribe(([rawCreds, gcpToken]) => {
    const defaults = geminiTtsEngine.defaultConfig;
    const cfg = Object.assign({}, defaults, rawCreds || {});
    $("#gemini-backend").val(cfg.backend || defaults.backend);
    $("#gemini-api-key").val(cfg.apiKey || "");
    const modelVal = cfg.model || defaults.model;
    if ($(`#gemini-model option[value="${modelVal}"]`).length === 0) {
      $("<option>").val(modelVal).text(modelVal).appendTo("#gemini-model");
    }
    $("#gemini-model").val(modelVal);

    const langVal = (cfg.languageCode || defaults.languageCode).toLowerCase();
    if ($(`#gemini-lang option[value="${langVal}"]`).length === 0) {
      $("<option>").val(langVal).text(langVal).appendTo("#gemini-lang");
    }
    $("#gemini-lang").val(langVal);
    $("#gemini-prompt").val(cfg.prompt != null ? cfg.prompt : defaults.prompt);
    const isPortal = (cfg.backend || defaults.backend) === "portal";
    $("#gemini-key-label, #gemini-key-control").toggle(!isPortal);
    $("#portal-auth-label, #portal-auth-control").toggle(isPortal);
    $("#portal-token-status").text(gcpToken ? "Authorized" : "Not authorized");
  });

  domReadyPromise.then(() => {
    async function saveGeminiOptions() {
      const existing = (await getSetting("geminiCreds")) || {};
      const next = Object.assign({}, geminiTtsEngine.defaultConfig, existing, {
        backend: $("#gemini-backend").val(),
        apiKey: $("#gemini-api-key").val().trim(),
        model: $("#gemini-model").val().trim() || geminiTtsEngine.defaultConfig.model,
        languageCode: $("#gemini-lang").val().trim() || "en-gb",
        prompt: $("#gemini-prompt").val()
      });
      await updateSettings({geminiCreds: next});
    }

    $("#gemini-backend, #gemini-api-key, #gemini-model, #gemini-lang, #gemini-prompt")
      .on("change", saveGeminiOptions);

    $("#portal-auth-btn").click(() => {
      brapi.permissions.request(config.wavenetPerms)
        .then(async (granted) => {
          if (!granted) {
            handleError(new Error("Host permission for Google Cloud TTS portal was denied."));
            return;
          }
          const s = await getSettings(["geminiConfig"]);
          await updateSettings({
            geminiConfig: Object.assign({}, s.geminiConfig || {}, { backend: "portal" })
          });
          await bgPageInvoke("authWavenet");
        })
        .catch(handleError);
    });

    const manifest = brapi.runtime.getManifest();
    const currentVersion = (manifest && manifest.version) || "0.0.0";
    $("#ext-version").text("Version " + currentVersion);

    function compareVersions(a, b) {
      const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
      const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    }

    $("#check-updates-btn").click(async () => {
      const $btn = $("#check-updates-btn");
      const $status = $("#update-status");
      $btn.prop("disabled", true);
      $status.text("Checking...");
      try {
        const res = await fetch("https://raw.githubusercontent.com/lo3chan/read-aloud-gemini/main/updates.json", {
          cache: "no-store"
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const addonId = (manifest.browser_specific_settings && manifest.browser_specific_settings.gecko && manifest.browser_specific_settings.gecko.id) || "read-aloud-gemini@local";
        const updates = (data.addons && data.addons[addonId] && data.addons[addonId].updates) || [];
        const latest = updates.slice().sort((x, y) => compareVersions(y.version, x.version))[0];
        if (!latest || compareVersions(latest.version, currentVersion) <= 0) {
          $status.text("Up to date (v" + currentVersion + ")");
        } else {
          $status.empty()
            .append(document.createTextNode("Update v" + latest.version + " available: "))
            .append($("<a>").attr("href", latest.update_link).attr("target", "_blank").text("Install Update"));
        }
      } catch (err) {
        $status.text("Update check failed: " + err.message);
      } finally {
        $btn.prop("disabled", false);
      }
    });
  })



  //status
  domReadyPromise
    .then(() => {
      $("#status").parent().hide()
    })

  settingsChange$
    .subscribe(changes => {
      showConfirmation()
      // Playback state, reader preferences, and voice discovery also write to
      // storage. Only changes to speech settings should interrupt playback.
      if (Object.keys(changes).some(key =>
        (["voiceName", "pitch", "volume", "wordReplacements", "preferredVoices"].includes(key)
          || key.startsWith("rate"))
        && JSON.stringify(changes[key].oldValue) != JSON.stringify(changes[key].newValue)
      )) {
        bgPageInvoke("stop").catch(err => "OK")
      }
    })





  function populateVoices(allVoices, settings, acceptLangs) {
    $("#voices").empty()
    $("<option>")
      .val("")
      .text("Auto select")
      .appendTo("#voices")

    //get voices filtered by selected languages
    var selectedLangs = immediate(() => {
      if (settings.languages) return settings.languages.split(',')
      if (settings.languages == '') return null
      const accept = new Set(acceptLangs.map(x => x.split('-',1)[0]))
      const langs = Object.keys(groupVoicesByLang(allVoices)).filter(x => accept.has(x))
      return langs.length ? langs : null
    })
    var voices = !selectedLangs ? allVoices : allVoices.filter(
      function(voice) {
        const voiceLanguages = getVoiceLanguages(voice)
        return !voiceLanguages
          || voiceLanguages.map(parseLang).some(({ lang }) => selectedLangs.includes(lang))
          || isGeminiTts(voice)
      });

    voices.sort(voiceSorter);

    const geminiGroup = $("<optgroup>")
      .attr("label", "Gemini TTS")
      .appendTo($("#voices"));
    voices.forEach(function(voice) {
      $("<option>")
        .val(voice.voiceName)
        .text(voice.voiceName)
        .appendTo(geminiGroup);
    });

    $("<optgroup>").appendTo($("#voices"));
    var additional = $("<optgroup>")
      .attr("label", brapi.i18n.getMessage("options_voicegroup_additional") || "Settings")
      .appendTo($("#voices"));
    $("<option>")
      .val("@languages")
      .text(brapi.i18n.getMessage("options_add_more_languages") || "Add more languages...")
      .appendTo(additional)
    $("<option>")
      .val("@custom")
      .text("Configure Gemini TTS & Diagnostics...")
      .appendTo(additional)
  }

  function voiceSorter(a, b) {
    return a.voiceName.localeCompare(b.voiceName);
  }



  function showConfirmation() {
    $(".green-check").finish().show().delay(500).fadeOut();
  }

  function handleError(err) {
    if (/^{/.test(err.message)) {
      var errInfo = JSON.parse(err.message);
      $("#status").html(formatError(errInfo)).parent().show();
      $("#status a").click(function() {
        switch ($(this).attr("href")) {
          case "#sign-in":
            getAuthToken({interactive: true})
              .then(function(token) {
                if (token) {
                  $("#test-voice").click();
                  getAccountInfo(token).then(showAccountInfo);
                }
              })
              .catch(function(err) {
                $("#status").text(err.message).parent().show();
              })
            break;
          case "#auth-wavenet":
            brapi.permissions.request(config.wavenetPerms)
              .then(function(granted) {
                if (granted) return bgPageInvoke("authWavenet");
              })
              .catch(handleError);
            break;
        }
      })
    }
    else if (isOpera() && /locked fullscreen/.test(err.message)) {
      $("#status").html("Click <a href='#open-player-tab'>here</a> to start read aloud.").parent().show()
      $("#status a").click(async function() {
        try {
          playerCheckIn$.pipe(rxjs.take(1)).subscribe(() => $("#test-voice").click())
          const tab = await brapi.tabs.create({
            url: "player.html?opener=options&autoclose=long",
            index: 0,
            active: false,
          })
          try {
            await brapi.tabs.update(tab.id, {pinned: true})
          } catch (err) {
            console.error(err)
          }
        } catch (err) {
          handleError(err)
        }
      })
    }
    else {
      $("#status").text(err.message).parent().show();
    }
  }

  function showAccountInfo(account) {
    if (account) {
      $("#account-email").text(account.email);
      $("#account-info").show();
    }
    else {
      $("#account-info").hide();
    }
  }



  function createSlider(elem, {onChange, onSlideChange}) {
    var min = $(elem).data("min") || 0;
    var max = $(elem).data("max") || 1;
    var step = 1 / ($(elem).data("steps") || 20);
    var $bg = $(elem).empty().toggleClass("slider", true);
    var $bar = $("<div class='bar'>").appendTo(elem);
    var $track = $("<div class='track'>").appendTo(elem);
    var $knob = $("<div class='knob'>").appendTo($track);

    $bg.click(function(e) {
      var pos = calcPosition(e);
      setPosition(pos);
      onChange(min + pos*(max-min));
    })
    $knob.click(function() {
      return false;
    })
    $knob.on("mousedown touchstart", function() {
      onSlideStart(function(e) {
        var pos = calcPosition(e);
        setPosition(pos);
        if (onSlideChange) onSlideChange(min + pos*(max-min));
      },
      function(e) {
        var pos = calcPosition(e);
        setPosition(pos);
        onChange(min + pos*(max-min));
      })
      return false;
    })
    return {
      setValue(value) {
        setPosition((Math.min(value, max)-min) / (max-min))
      }
    }

    function setPosition(pos) {
      var percent = (100 * pos) + "%";
      $knob.css("left", percent);
      $bar.css("width", percent);
    }
    function calcPosition(e) {
      var rect = $track.get(0).getBoundingClientRect();
      var position = (e.clientX - rect.left) / rect.width;
      position = Math.min(1, Math.max(position, 0));
      return step * Math.round(position / step);
    }
  }

  function onSlideStart(onSlideMove, onSlideStop) {
    $(document).on("mousemove", onSlideMove);
    $(document).on("mouseup mouseleave", onStop);
    $(document).on("touchmove", onTouchMove);
    $(document).on("touchend touchcancel", onTouchEnd);

    function onTouchMove(e) {
      e.clientX = e.originalEvent.changedTouches[0].clientX;
      e.clientY = e.originalEvent.changedTouches[0].clientY;
      onSlideMove(e);
      return false;
    }
    function onTouchEnd(e) {
      e.clientX = e.originalEvent.changedTouches[0].clientX;
      e.clientY = e.originalEvent.changedTouches[0].clientY;
      onStop(e);
      return false;
    }
    function onStop(e) {
      $(document).off("mousemove", onSlideMove);
      $(document).off("mouseup mouseleave", onStop);
      $(document).off("touchmove", onTouchMove);
      $(document).off("touchend touchcancel", onTouchEnd);
      if (onSlideStop) onSlideStop(e);
      return false;
    }
  }
})();

function initSettingInfoPopup(buttonId, popupId, anchorId, labelKey) {
  const button = document.getElementById(buttonId)
  const popup = document.getElementById(popupId)
  const label = brapi.i18n.getMessage(labelKey)
  button.setAttribute("aria-label", label)
  button.title = label
  const close = () => {
    popup.hidden = true
    button.setAttribute("aria-expanded", "false")
  }
  button.addEventListener("click", () => {
    if (!popup.hidden) return close()
    // A fixed, viewport-bounded overlay must not affect extension auto-sizing.
    const anchorElement = document.getElementById(anchorId)
    const anchor = (anchorElement.getClientRects().length ? anchorElement : button).getBoundingClientRect()
    const width = Math.min(320, window.innerWidth - 32)
    popup.style.width = `${width}px`
    popup.style.left = `${Math.max(16, Math.min(anchor.right - width, window.innerWidth - width - 16))}px`
    popup.style.top = "16px"
    popup.hidden = false
    const height = popup.getBoundingClientRect().height
    popup.style.top = `${Math.max(16, Math.min(anchor.bottom + 8, window.innerHeight - height - 16))}px`
    button.setAttribute("aria-expanded", "true")
  })
  document.addEventListener("click", event => {
    if (!button.contains(event.target) && !popup.contains(event.target)) close()
  })
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !popup.hidden) {
      close()
      button.focus()
      event.preventDefault()
    }
  })
  document.addEventListener("focusin", event => {
    if (!button.contains(event.target) && !popup.contains(event.target)) close()
  })
  window.addEventListener("resize", close)
  window.addEventListener("scroll", close)
  document.getElementById("voices").addEventListener("change", close)
}
