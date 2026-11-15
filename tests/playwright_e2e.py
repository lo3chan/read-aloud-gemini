import base64
import json
import os
import shutil
import tempfile
from playwright.sync_api import sync_playwright

EXT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def check_manifest():
    manifest_path = os.path.join(EXT_DIR, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    bg_scripts = manifest.get("background", {}).get("scripts", [])
    assert isinstance(bg_scripts, list) and len(bg_scripts) > 0, "manifest.json background.scripts must be non-empty"
    assert "background.js" not in bg_scripts, "background.scripts must not load background.js (importScripts fails in Firefox)"
    for rel in bg_scripts:
        assert os.path.isfile(os.path.join(EXT_DIR, rel)), f"Missing background script: {rel}"


def run_e2e():
    check_manifest()

    user_data_dir = tempfile.mkdtemp(prefix="ra-pw-")
    page_errors = []
    console_errors = []

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                user_data_dir,
                headless=True,
                channel="chromium",
                args=[
                    f"--disable-extensions-except={EXT_DIR}",
                    f"--load-extension={EXT_DIR}",
                ],
            )

            sw = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=10000)
            ext_id = sw.url.split("/")[2]
            print("Loaded extension ID:", ext_id)

            simulate_429 = {"active": False}
            pcm_samples = {"count": 2400}

            def attach_listeners(page):
                page.on("pageerror", lambda err: page_errors.append(f"PAGEERROR {page.url}: {err}"))
                def on_console(msg):
                    if msg.type == "error":
                        if simulate_429["active"] and "429" in msg.text:
                            return
                        console_errors.append(f"CONSOLE {page.url}: {msg.text}")
                page.on("console", on_console)

            context.on("page", attach_listeners)

            cloud_requests = []
            gemini_requests = []
            portal_requests = []

            def handle_gemini_api(route):
                if simulate_429["active"]:
                    route.fulfill(
                        status=429,
                        content_type="application/json",
                        body=json.dumps({"error": {"code": 429, "message": "Quota exceeded"}}),
                    )
                    return
                body = json.loads(route.request.post_data or "{}")
                gemini_requests.append({"url": route.request.url, "body": body})
                pcm_b64 = base64.b64encode(b"\x00\x00" * pcm_samples["count"]).decode("ascii")
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "candidates": [{
                            "content": {
                                "parts": [{
                                    "inlineData": {
                                        "mimeType": "audio/L16;codec=pcm;rate=24000",
                                        "data": pcm_b64,
                                    }
                                }]
                            }
                        }]
                    }),
                )

            def handle_cloud_tts(route):
                body = json.loads(route.request.post_data or "{}")
                cloud_requests.append({"url": route.request.url, "body": body})
                wav_b64 = base64.b64encode(b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\xc0\x5d\x00\x00\x80\xbb\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00").decode("ascii")
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"audioContent": wav_b64}),
                )

            def handle_portal(route):
                body = json.loads(route.request.post_data or "{}")
                portal_requests.append({"url": route.request.url, "body": body})
                wav_b64 = base64.b64encode(b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\xc0\x5d\x00\x00\x80\xbb\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00").decode("ascii")
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"audioContent": wav_b64}),
                )

            context.route("https://generativelanguage.googleapis.com/**", handle_gemini_api)
            context.route("https://texttospeech.googleapis.com/**", handle_cloud_tts)
            context.route("https://cxl-services.appspot.com/**", handle_portal)

            # 1. Fresh-install check: popup.html must not throw stateInfo is undefined
            popup_page = context.new_page()
            attach_listeners(popup_page)
            popup_page.goto(f"chrome-extension://{ext_id}/popup.html")
            popup_page.wait_for_load_state("domcontentloaded")
            popup_page.wait_for_timeout(600)
            popup_status = popup_page.locator("#status").inner_text() if popup_page.locator("#status").count() else ""
            assert "stateInfo" not in popup_status and "undefined" not in popup_status, f"Popup error on fresh install: {popup_status}"
            assert popup_page.locator("#popup-rate").is_visible(), "Popup speed slider missing"
            assert popup_page.locator("#popup-volume").is_visible(), "Popup volume slider missing"
            popup_page.close()

            # 2. Fresh-install check: options.html has 30 base Gemini voices + inline settings
            opt_page = context.new_page()
            attach_listeners(opt_page)
            opt_page.goto(f"chrome-extension://{ext_id}/options.html")
            opt_page.wait_for_load_state("domcontentloaded")
            opt_page.wait_for_timeout(500)
            initial_voices = opt_page.locator("#voices").inner_text()
            assert "Gemini Achernar" in initial_voices, f"Base voice Gemini Achernar missing: {initial_voices}"
            assert "Gemini Kore" in initial_voices
            assert opt_page.locator("#gemini-backend").input_value() == "gemini-api"
            assert opt_page.locator("#gemini-model").input_value() == "gemini-3.8-flash-lite-tts"
            assert opt_page.locator("#gemini-lang").input_value() == "en-gb"
            assert "Scottish" in opt_page.locator("#gemini-prompt").input_value()

            # Clicking Test before configuring API key must NOT throw destructured parameter error
            opt_page.locator("#voices").select_option("Gemini Achernar")
            opt_page.locator("#test-voice").click()
            opt_page.wait_for_timeout(800)
            opt_status = opt_page.locator("#status").inner_text() if opt_page.locator("#status").count() else ""
            assert "destructured" not in opt_status and "undefined" not in opt_status, f"Options Test failed with: {opt_status}"

            # Configure API key & instructions directly inside Options!
            opt_page.locator("#gemini-api-key").fill("AIza-options-inline-key")
            opt_page.locator("#gemini-api-key").dispatch_event("change")
            opt_page.wait_for_timeout(300)

            # Verify version indicator & Check for Updates button
            assert "Version 2.25." in opt_page.locator("#ext-version").inner_text()
            context.route("https://raw.githubusercontent.com/**", lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "addons": {
                        "read-aloud-gemini@local": {
                            "updates": [{"version": "9.9.9", "update_link": "https://example.com/read-aloud-gemini@local.xpi"}]
                        }
                    }
                })
            ))
            opt_page.locator("#check-updates-btn").click()
            opt_page.wait_for_timeout(400)
            assert "Update v9.9.9 available" in opt_page.locator("#update-status").inner_text()

            # 3. custom-voices.html (Diagnostics & Advanced): verify synced settings + test all 3 backends
            page = context.new_page()
            attach_listeners(page)
            page.goto(f"chrome-extension://{ext_id}/custom-voices.html")
            page.wait_for_load_state("domcontentloaded")
            page.wait_for_timeout(300)
            assert page.locator("#gemini-api-key").input_value() == "AIza-options-inline-key"

            # Test Gemini API
            page.locator("#test-voice-select").select_option("Achernar")
            page.locator("#gemini-test-btn").click()
            page.wait_for_selector("#gemini-success:visible", timeout=5000)
            assert len(gemini_requests) == 1
            assert page.locator("#test-audio-player").get_attribute("src").startswith("blob:")

            # Test Cloud TTS v1beta1
            page.locator("#gemini-backend").select_option("cloud-tts")
            page.locator("#gemini-test-btn").click()
            page.wait_for_timeout(400)
            assert len(cloud_requests) == 1
            assert cloud_requests[0]["body"]["voice"]["modelName"] == "gemini-3.8-flash-lite-tts"
            assert cloud_requests[0]["body"]["voice"]["name"] == "Achernar"
            assert cloud_requests[0]["body"]["input"]["prompt"] == "Speak with a natural, warm Scottish accent."

            # Test Portal backend
            page.locator("#gemini-backend").select_option("portal")
            page.evaluate("() => new Promise(r => chrome.storage.local.set({gcpToken: 'portal-test-token'}, r))")
            page.wait_for_timeout(200)
            assert "Authorized" in page.locator("#portal-token-status").inner_text()
            page.locator("#gemini-test-btn").click()
            page.wait_for_timeout(400)
            assert len(portal_requests) == 1
            assert "token=portal-test-token" in portal_requests[0]["url"]

            # Test custom backend with compact MP3 synthesis
            custom_requests = []
            def handle_custom_tts(route):
                body = json.loads(route.request.post_data or "{}")
                custom_requests.append({"url": route.request.url, "body": body})
                mp3_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x44" * 10
                route.fulfill(
                    status=200,
                    content_type="audio/mpeg",
                    body=mp3_bytes,
                )
            context.route("https://mock-custom-tts.example.com/**", handle_custom_tts)

            page.locator("#gemini-backend").select_option("custom")
            page.locator("#gemini-custom-url").fill("https://mock-custom-tts.example.com/v1/audio/speech")
            page.locator("#gemini-save-btn").click()
            page.wait_for_timeout(200)
            page.locator("#gemini-test-btn").click()
            page.wait_for_timeout(400)
            assert len(custom_requests) == 1
            assert custom_requests[0]["body"]["response_format"] == "mp3"
            assert custom_requests[0]["body"]["model"] == "gemini-3.8-flash-lite-tts"

            # Test fast-start first chunking in Speech via player.html
            player_page = context.new_page()
            player_page.goto(f"chrome-extension://{ext_id}/player.html", wait_until="domcontentloaded")
            chunk_test = player_page.evaluate("""() => {
                const sampleText = "This is the first opening sentence of a very long article that exceeds two hundred and twenty characters in total length so that the reader can experience immediate and ultra fast audio playback response without waiting for a large chunk to finish synthesizing.";
                const sp = new Speech([sampleText], {voice: {voiceName: "Gemini Achernar"}});
                const info = sp.getInfo();
                return {
                    firstLen: info.texts[0].length,
                    totalChunks: info.texts.length
                };
            }""")
            assert chunk_test["totalChunks"] > 1, "Long text should be broken into multiple chunks"
            assert chunk_test["firstLen"] <= 200, f"Fast-start first chunk must be <= 200 chars, got {chunk_test['firstLen']}"
            player_page.close()

            # Test 429 error telemetry & clear
            page.locator("#gemini-backend").select_option("gemini-api")
            simulate_429["active"] = True
            page.locator("#gemini-test-btn").click()
            page.wait_for_selector("#gemini-error:visible", timeout=5000)
            assert "429: Quota exceeded" in page.locator("#gemini-error").inner_text()
            page.wait_for_timeout(300)
            assert page.locator("#stat-total").inner_text() == "5"
            page.locator("#telemetry-clear-btn").click()
            page.wait_for_timeout(200)
            assert page.locator("#stat-total").inner_text() == "0"

            # Test Authorize Portal button in custom-voices.html and options.html
            context.route("https://cloud.google.com/**", lambda route: route.fulfill(
                status=200, content_type="text/html", body="<html><body>Cloud TTS Mock</body></html>"
            ))
            page.locator("#gemini-backend").select_option("portal")
            with context.expect_page(timeout=10000) as new_page_info:
                page.locator("#portal-auth-btn").click()
            portal_tab = new_page_info.value
            portal_tab.wait_for_load_state("domcontentloaded", timeout=10000)
            assert "cloud.google.com/text-to-speech" in portal_tab.url
            portal_tab.close()

            page.goto(f"chrome-extension://{ext_id}/options.html", wait_until="domcontentloaded")
            page.locator("#gemini-backend").select_option("portal")
            with context.expect_page(timeout=10000) as opt_new_page_info:
                page.locator("#portal-auth-btn").click()
            opt_portal_tab = opt_new_page_info.value
            opt_portal_tab.wait_for_load_state("domcontentloaded", timeout=10000)
            assert "cloud.google.com/text-to-speech" in opt_portal_tab.url
            opt_portal_tab.close()

            # Test Options #test-voice transitions LOADING -> PLAYING (spinner hidden) -> STOPPED, plus cache hit & offscreen player path
            simulate_429["active"] = False
            pcm_samples["count"] = 48000
            page.locator("#gemini-backend").select_option("gemini-api")
            page.locator("#gemini-backend").dispatch_event("change")
            page.wait_for_timeout(200)

            page.locator("#test-voice").click()
            page.wait_for_function("""() => {
                const btn = document.querySelector('#test-voice');
                const label = btn && btn.querySelector('[data-i18n]');
                const sp = btn && btn.querySelector('.spinner');
                return label && label.textContent.trim() === 'Stop' && sp && getComputedStyle(sp).display === 'none';
            }""", timeout=5000)
            assert not page.locator("#status").is_visible(), f"Unexpected Options error banner: {page.locator('#status').inner_text()}"

            # Click Stop and verify clean reset
            page.locator("#test-voice").click()
            page.wait_for_function("""() => {
                const btn = document.querySelector('#test-voice');
                const label = btn && btn.querySelector('[data-i18n]');
                const sp = btn && btn.querySelector('.spinner');
                return label && label.textContent.trim() === 'Test' && sp && getComputedStyle(sp).display === 'none';
            }""", timeout=5000)

            # Second click should hit cached audio and still leave LOADING cleanly
            page.locator("#test-voice").click()
            page.wait_for_function("""() => {
                const btn = document.querySelector('#test-voice');
                const label = btn && btn.querySelector('[data-i18n]');
                const sp = btn && btn.querySelector('.spinner');
                return label && label.textContent.trim() === 'Stop' && sp && getComputedStyle(sp).display === 'none';
            }""", timeout=5000)
            page.locator("#test-voice").click()
            page.wait_for_function("""() => {
                const btn = document.querySelector('#test-voice');
                const label = btn && btn.querySelector('[data-i18n]');
                return label && label.textContent.trim() === 'Test';
            }""", timeout=5000)

            # Also verify MV3 offscreen playback path via background playText (must not crash on brapi.storage undefined)
            bg_state = page.evaluate("""async () => {
                await bgPageInvoke("playText", ["Testing background offscreen audio playback cleanly.", {lang: "en"}]);
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline) {
                    const st = await bgPageInvoke("getPlaybackState");
                    if (st && st.state === "PLAYING") {
                        await bgPageInvoke("stop");
                        return st.state;
                    }
                    if (st && st.playbackError) {
                        throw new Error(JSON.stringify(st.playbackError));
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                const last = await bgPageInvoke("getPlaybackState");
                await bgPageInvoke("stop");
                return last ? last.state : null;
            }""")
            assert bg_state == "PLAYING", f"Background playText did not reach PLAYING (state={bg_state})"

            assert not page_errors, f"Uncaught page errors: {page_errors}"
            assert not console_errors, f"Console errors: {console_errors}"
            print("ALL REFINED PLAYWRIGHT E2E TESTS PASSED!")
            context.close()
    finally:
        shutil.rmtree(user_data_dir, ignore_errors=True)


if __name__ == "__main__":
    run_e2e()
