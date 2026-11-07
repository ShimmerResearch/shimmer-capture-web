/**
 * The Shimmer3R's audio recording (DEV-99): whether this firmware records from
 * the microphone while logging to SD, what the configuration asks it to keep,
 * whether it is recording now, and the recorder's own status on request.
 *
 * What is recorded is configuration byte 233, Audio Recording on the
 * Configuration tab: off, the fingerprint only, the fingerprint and raw audio,
 * or raw audio only. The files go in `audio/` beside each data file, and the
 * SD card tab lists and downloads them with their sessions. Raw audio records
 * speech, so the page asks before it writes a mode that keeps it.
 *
 * The recording and fault flags come in the status the sensor pushes whenever
 * either changes, so this card follows them without polling.
 *
 * The card is hidden unless the connected sensor said it records audio: no
 * release does yet, and a card that could only ever say "not supported" would
 * be noise on every other sensor.
 *
 *   import { createAudioPanel } from "./common/audio-panel.js";
 *   const audio = createAudioPanel($("audioPanel"), { onReadStatus });
 *   audio.setSupport("yes");
 *   audio.setStatus(status); // from getStatus or a push
 */

import * as sdk from "../vendor/shimmer-web-sdk.esm.js";
import { el } from "./ui-chrome.js";

/**
 * @typedef {object} AudioPanelOptions
 * @property {() => Promise<object|null>} [onReadStatus] asks the device for
 *   its audio status; resolves to the SDK's `AudioStatus`
 */

/**
 * Build the card inside `host`.
 *
 * @param {HTMLElement} host
 * @param {AudioPanelOptions} [opts]
 */
export function createAudioPanel(host, opts = {}) {
  /** Whether the firmware records audio, and whether the link is free to ask. */
  let supported = false;
  let linkFree = false;

  const supportLine = el("div", { class: "muted", text: "Not connected." });
  const configLine = el("div", { class: "field-hint", id: "audioConfigLine" });
  const stateLine = el("div", { class: "field-hint", id: "audioStateLine" });
  const statusLine = el("div", {
    class: "field-hint mono",
    id: "audioStatusLine",
  });

  const btnStatus = el(
    "button",
    {
      type: "button",
      id: "btnAudioStatus",
      disabled: true,
      onclick: readStatus,
      title:
        "Ask the sensor for its audio recorder's state, first fault and this session's counters",
    },
    "Read audio status",
  );

  const card = el(
    "div",
    { class: "card", id: "audioCard", hidden: true },
    el("div", { class: "card-title" }, "Audio recording"),
    supportLine,
    configLine,
    stateLine,
    el("div", { class: "row" }, btnStatus),
    statusLine,
    el(
      "div",
      { class: "field-hint", style: "margin-top: 8px" },
      "The sensor records only while it logs to SD, into audio/ beside each data file: " +
        "a .WAV of the raw 16 kHz audio and an .AFP of its fingerprint. " +
        "The fingerprint stores landmark hashes, not sound. Raw audio records speech: " +
        "everyone near the sensor needs to know it is recording.",
    ),
  );
  host.append(card);

  function paintButton() {
    btnStatus.disabled = !(supported && linkFree);
  }

  /**
   * @param {"none"|"yes"|"no"|"usb"} state whether the firmware records
   *   audio, as the sensor answered at connect
   */
  function setSupport(state) {
    supportLine.textContent =
      {
        none: "Not connected.",
        yes: "This firmware records audio while it logs to SD.",
        no: "This firmware does not record audio.",
        usb: "Over USB the page cannot ask whether this firmware records audio. Connect over Bluetooth.",
      }[state] ?? "";
    supported = state === "yes";
    card.hidden = !supported;
    if (!supported) {
      configLine.textContent = "";
      stateLine.textContent = "";
      statusLine.textContent = "";
    }
    paintButton();
  }

  /** What the configuration in the form asks for: byte 233, or null without one. */
  function setConfig(byte233) {
    if (byte233 == null || !supported) {
      configLine.textContent = "";
      return;
    }
    const mode = sdk.audioModeOf(byte233);
    configLine.textContent =
      mode === sdk.AUDIO_MODE.OFF
        ? "The configuration records no audio."
        : `The configuration records ${modeWords(mode)} while logging.`;
  }

  /**
   * The recording and fault flags from a status the sensor stated: a read,
   * or a push. Null clears them.
   */
  function setStatus(status) {
    if (!supported || !status || typeof status.audioRecording !== "boolean") {
      stateLine.textContent = "";
      return;
    }
    const parts = [status.audioRecording ? "Recording now." : "Not recording."];
    if (status.audioFault) {
      parts.push(
        "This session's audio failed or was degraded: read the audio status for the fault.",
      );
    }
    stateLine.textContent = parts.join(" ");
    stateLine.classList.toggle("preview-warn", !!status.audioFault);
  }

  function setEnabled(canAsk) {
    linkFree = canAsk;
    paintButton();
  }

  async function readStatus() {
    if (!opts.onReadStatus) return;
    const st = await opts.onReadStatus();
    if (st) showStatus(st);
  }

  function showStatus(st) {
    const parts = [
      `Mode ${st.mode} (${sdk.describeAudioMode(st.mode)})`,
      sdk.describeAudioState(st.state),
      `fault: ${sdk.describeAudioFault(st.fault)}`,
      `${st.seconds} s recorded`,
    ];
    if (st.silenceSamples)
      parts.push(`${st.silenceSamples} samples of silence`);
    if (st.writeErrors) parts.push(`${st.writeErrors} write error(s)`);
    if (st.escapeDrains) parts.push(`${st.escapeDrains} catch-up write(s)`);
    if (st.mode === 1 || st.mode === 2) {
      parts.push(
        `${st.fingerprintChunks} fingerprint chunk(s)` +
          (st.fingerprintChunksSkipped
            ? `, ${st.fingerprintChunksSkipped} skipped`
            : ""),
      );
    }
    parts.push(`ADF errors ${st.adfErrors} (saturation ${st.adfSaturation})`);
    statusLine.textContent = parts.join(" · ");
  }

  return { setSupport, setConfig, setStatus, setEnabled, showStatus };
}

/** What a mode keeps, as a phrase. */
function modeWords(mode) {
  switch (mode) {
    case sdk.AUDIO_MODE.FINGERPRINT:
      return "the audio fingerprint only (no sound is stored)";
    case sdk.AUDIO_MODE.FINGERPRINT_RAW:
      return "the audio fingerprint and raw audio";
    case sdk.AUDIO_MODE.RAW:
      return "raw audio";
    default:
      return `mode ${mode}`;
  }
}
