$(function() {
  populateTestVoices();
  loadConfig();
  loadTelemetry();

  observeSetting("geminiTelemetry").subscribe(() => loadTelemetry());
  observeSetting("gcpToken").subscribe(token => updatePortalStatus(token));

  $("#gemini-backend").change(updateBackendUi);

  $("#portal-auth-btn").click(function() {
    $(".status").hide();
    brapi.permissions.request(config.wavenetPerms)
      .then(async function(granted) {
        if (granted) {
          await bgPageInvoke("authWavenet");
          showSuccess("Opened Cloud TTS portal. Click 'Speak It' there to capture your token.");
        } else {
          showError("Permission denied for Cloud TTS portal authorization.");
        }
      })
      .catch(function(err) {
        showError("Portal authorization failed: " + err.message);
      });
  });

  $("#toggle-key-btn").click(function() {
    const input = $("#gemini-api-key");
    const isPwd = input.attr("type") === "password";
    input.attr("type", isPwd ? "text" : "password");
    $(this).text(isPwd ? "Hide" : "Show");
  });

  $(".model-preset").click(function() {
    $("#gemini-model").val($(this).data("model"));
  });

  $("#gemini-save-btn").click(saveConfig);
  $("#gemini-test-btn").click(testConfig);
  $("#gemini-clear-cache-btn").click(function() {
    geminiTtsEngine.clearCache();
    showSuccess("In-memory audio cache cleared.");
  });
  $("#gemini-reset-btn").click(resetDefaults);

  $("#telemetry-filter").change(loadTelemetry);
  $("#telemetry-refresh-btn").click(loadTelemetry);
  $("#telemetry-copy-btn").click(copyDiagnosticsJson);
  $("#telemetry-clear-btn").click(async function() {
    await geminiTtsEngine.clearTelemetry();
    loadTelemetry();
  });
});

function populateTestVoices() {
  const select = $("#test-voice-select");
  select.empty();
  for (const voice of geminiTtsEngine.prebuiltVoices) {
    $("<option>").val(voice).text(voice).appendTo(select);
  }
  select.val("Achernar");
}

function applyConfigToForm(raw) {
  const defaults = geminiTtsEngine.defaultConfig;
  const cfg = Object.assign({}, defaults, raw || {});
  $("#gemini-backend").val(cfg.backend || defaults.backend);
  $("#gemini-api-key").val(cfg.apiKey || "");
  $("#gemini-model").val(cfg.model || defaults.model);
  $("#gemini-lang").val(cfg.languageCode || defaults.languageCode);
  $("#gemini-encoding").val(cfg.audioEncoding || defaults.audioEncoding);
  $("#gemini-default-prompt").val(cfg.prompt != null ? cfg.prompt : defaults.prompt);
  $("#gemini-chunk-size").val(cfg.chunkSize ?? defaults.chunkSize);
  updateBackendUi();

  const badge = $("#active-backend-badge");
  if (cfg.backend === "portal") {
    badge.removeClass("badge-secondary").addClass("badge-primary").text("Cloud Portal Proxy");
  } else if (cfg.backend === "google-translate") {
    badge.removeClass("badge-secondary").addClass("badge-primary").text("Google Translate");
  } else if (cfg.backend === "phonon-webgpu") {
    badge.removeClass("badge-secondary").addClass("badge-primary").text("Phonon 31M (WebGPU)");
  } else if (cfg.backend === "edge-tts") {
    badge.removeClass("badge-secondary").addClass("badge-primary").text("Edge Neural TTS");
  } else if (cfg.apiKey) {
    badge.removeClass("badge-secondary").addClass("badge-primary")
      .text(cfg.backend === "cloud-tts" ? "Cloud TTS v1beta1" : "Gemini API");
  } else {
    badge.removeClass("badge-primary").addClass("badge-secondary").text("Not configured");
  }
}

function updateBackendUi() {
  const backend = $("#gemini-backend").val();
  const isPortal = backend === "portal";
  const isKeyless = backend === "google-translate" || backend === "phonon-webgpu" || backend === "edge-tts";
  $("#api-key-group").toggle(!isPortal && !isKeyless);
  $("#portal-auth-group").toggle(isPortal);
  $("#api-key-hint").text("");
}

function updatePortalStatus(token) {
  const el = $("#portal-token-status");
  if (token) {
    el.removeClass("text-muted text-danger").addClass("text-success")
      .text("Authorized (" + token.slice(0, 8) + "...)");
  } else {
    el.removeClass("text-success").addClass("text-muted")
      .text("Not authorized yet — click Authorize Portal");
  }
}

async function loadConfig() {
  const {geminiCreds} = await getSettings(["geminiCreds"]);
  applyConfigToForm(geminiCreds);
}

function readFormConfig() {
  return {
    backend: $("#gemini-backend").val(),
    apiKey: $("#gemini-api-key").val().trim(),
    model: $("#gemini-model").val().trim() || geminiTtsEngine.defaultConfig.model,
    languageCode: $("#gemini-lang").val().trim() || "en-gb",
    audioEncoding: $("#gemini-encoding").val() || "MP3",
    prompt: $("#gemini-default-prompt").val(),
    chunkSize: Number($("#gemini-chunk-size").val()) || 750
  };
}

async function saveConfig() {
  $(".status").hide();
  try {
    const geminiCreds = readFormConfig();
    if (geminiCreds.backend !== "portal" && geminiCreds.backend !== "google-translate" && geminiCreds.backend !== "phonon-webgpu" && geminiCreds.backend !== "edge-tts" && !geminiCreds.apiKey) {
      await clearSettings(["geminiCreds"]);
      applyConfigToForm(null);
      showSuccess("Gemini TTS disabled (API key cleared).");
      return;
    }
    await updateSettings({geminiCreds});
    applyConfigToForm(geminiCreds);
    showSuccess("Gemini TTS settings saved.");
  } catch (err) {
    showError(err.message);
  }
}

async function testConfig() {
  $(".status").hide();
  $("#gemini-progress").show();
  try {
    const geminiCreds = readFormConfig();
    const sampleText = $("#gemini-test-text").val().trim();
    const voiceName = $("#test-voice-select").val() || "Achernar";
    const result = await geminiTtsEngine.test(geminiCreds, sampleText, voiceName);
    await updateSettings({geminiCreds});
    applyConfigToForm(geminiCreds);

    const player = document.getElementById("test-audio-player");
    player.src = result.url;
    player.style.display = "block";
    player.play().catch(() => {});

    $("#gemini-progress").hide();
    showSuccess(`Test succeeded (${result.durationMs}ms, ${formatBytes(result.audioBytes)}, ${result.mimeType}). Settings saved.`);
    loadTelemetry();
  } catch (err) {
    $("#gemini-progress").hide();
    showError("Test failed: " + err.message);
    loadTelemetry();
  }
}

async function resetDefaults() {
  $(".status").hide();
  const {geminiCreds} = await getSettings(["geminiCreds"]);
  const next = Object.assign({}, geminiTtsEngine.defaultConfig, {
    apiKey: geminiCreds && geminiCreds.apiKey ? geminiCreds.apiKey : ""
  });
  applyConfigToForm(next);
  showSuccess("Form reset to defaults. Click Save Settings to persist.");
}

async function loadTelemetry() {
  const entries = await geminiTtsEngine.getTelemetry();
  const filter = $("#telemetry-filter").val() || "all";

  const total = entries.length;
  const networkCalls = entries.filter(e => e.status === "ok" || e.status === "error");
  const successes = entries.filter(e => e.status === "ok");
  const cacheHits = entries.filter(e => e.status === "cache_hit");
  const avgLatency = successes.length
    ? Math.round(successes.reduce((sum, e) => sum + (e.durationMs || 0), 0) / successes.length) + " ms"
    : "-";
  const successRate = networkCalls.length
    ? Math.round((successes.length / networkCalls.length) * 100) + "%"
    : "-";

  $("#stat-total").text(total);
  $("#stat-success").text(successRate);
  $("#stat-latency").text(avgLatency);
  $("#stat-cache").text(cacheHits.length);

  const filtered = filter === "all" ? entries : entries.filter(e => e.status === filter);
  const tbody = $("#telemetry-tbody");
  tbody.empty();

  if (!filtered.length) {
    $("<tr><td colspan='7' class='text-center text-muted'>No telemetry events recorded yet.</td></tr>").appendTo(tbody);
    return;
  }

  for (const entry of filtered) {
    const badgeClass = entry.status === "ok"
      ? "badge-success"
      : entry.status === "cache_hit"
        ? "badge-info"
        : "badge-danger";
    const timeStr = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "-";
    const details = entry.error
      ? `<span class="text-danger">${escapeHtml(entry.error)}</span>`
      : `${escapeHtml(entry.textPreview || "")}${entry.textLength > 80 ? "..." : ""} (${entry.textLength || 0} chars)`;

    const tr = $("<tr>");
    $("<td>").text(timeStr).appendTo(tr);
    $("<td>").html(`<span class="badge ${badgeClass}">${escapeHtml(entry.status)}</span>`).appendTo(tr);
    $("<td>").text(entry.backend || "-").appendTo(tr);
    $("<td>").text(`${entry.voice || "-"} / ${entry.model || "-"}`).appendTo(tr);
    $("<td>").text(entry.durationMs != null ? `${entry.durationMs}ms` : "-").appendTo(tr);
    $("<td>").text(entry.audioBytes ? formatBytes(entry.audioBytes) : "-").appendTo(tr);
    $("<td>").html(details).appendTo(tr);
    tbody.append(tr);
  }
}

async function copyDiagnosticsJson() {
  const {geminiCreds} = await getSettings(["geminiCreds"]);
  const telemetry = await geminiTtsEngine.getTelemetry();
  const redactedCreds = geminiCreds
    ? Object.assign({}, geminiCreds, {apiKey: geminiCreds.apiKey ? "***REDACTED***" : ""})
    : null;
  const payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    config: redactedCreds,
    telemetry
  }, null, 2);
  await navigator.clipboard.writeText(payload);
  showSuccess("Diagnostics JSON copied to clipboard (API key redacted).");
}

function showSuccess(msg) {
  $("#gemini-error").hide();
  $("#gemini-success").text(msg).show();
}

function showError(msg) {
  $("#gemini-success").hide();
  $("#gemini-error").text(msg).show();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  return (bytes / 1024).toFixed(1) + " KB";
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
