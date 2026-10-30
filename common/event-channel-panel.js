/**
 * The sensor's event channel (DEV-971): the user button's presses and
 * releases, and the TTL input's edges, each with its own time.
 *
 * A Shimmer3R whose firmware has the event channel records them in an event
 * file beside every SD data file, and sends them live to a host that opts in
 * for the connection. This card shows both: the live records as they arrive,
 * and an event file opened from disk (`events/<experiment>/<session>/<NNN>`,
 * copied off the card). Which inputs are recorded is configuration byte 232,
 * on the Configuration tab; the card says what the device is set to.
 *
 * The device's own "event log" is NOT this: that name belongs to the page's
 * log drawer. Here it is the event channel, and its records.
 *
 *   import { createEventChannelPanel } from "./common/event-channel-panel.js";
 *   const events = createEventChannelPanel($("eventPanel"), { onReadStatus, downloadBlob });
 *   client.onEventRecord = (rec) => events.push(rec);
 */

import * as sdk from "../vendor/shimmer-web-sdk.esm.js";
import { el } from "./ui-chrome.js";

/** Rows kept in the table; older ones scroll away (the CSV keeps them all). */
const MAX_ROWS = 200;

/**
 * @typedef {object} EventChannelPanelOptions
 * @property {() => Promise<object|null>} [onReadStatus] asks the device for
 *   its event channel status; resolves to the SDK's `EventChannelStatus`
 * @property {(name: string, blob: Blob) => void} [downloadBlob]
 * @property {(msg: string) => void} [log]
 */

/**
 * Build the card inside `host`.
 *
 * @param {HTMLElement} host
 * @param {EventChannelPanelOptions} [opts]
 */
export function createEventChannelPanel(host, opts = {}) {
  /** Every record shown since the last clear, live or from a file, for the CSV. */
  let all = [];
  let source = "live";
  /** The link's last sequence number, to see records the link lost. */
  let lastSeq = null;
  let linkGaps = 0;
  let counts = { button: 0, ttl: 0, dropped: 0 };
  let fileHeader = null;
  /** Whether the firmware sends records live, and whether the link is free to ask. */
  let supported = false;
  let linkFree = false;

  const supportLine = el("div", { class: "muted", text: "Not connected." });
  const configLine = el("div", { class: "field-hint" });
  const statusLine = el("div", { class: "field-hint mono" });
  const fileLine = el("div", { class: "field-hint" });

  const btnStatus = el(
    "button",
    {
      type: "button",
      id: "btnEventStatus",
      disabled: true,
      onclick: readStatus,
    },
    "Read status",
  );
  const fileInput = el("input", {
    type: "file",
    id: "eventFileInput",
    hidden: true,
    onchange: () => openFile(fileInput.files?.[0]),
  });
  const btnOpen = el(
    "button",
    { type: "button", id: "btnEventOpen", onclick: () => fileInput.click() },
    "Open event file…",
  );
  const btnCsv = el(
    "button",
    { type: "button", id: "btnEventCsv", disabled: true, onclick: saveCsv },
    "Save as CSV",
  );
  const btnClear = el(
    "button",
    { type: "button", id: "btnEventClear", onclick: () => clear() },
    "Clear",
  );

  const kv = el("div", { class: "kv" });
  const cell = (label) => {
    const v = el("div", { class: "mono", text: "0" });
    kv.append(el("div", { class: "muted", text: label }), v);
    return v;
  };
  const nButton = cell("Button edges");
  const nTtl = cell("TTL edges");
  const nLost = cell("Lost");

  const tbody = el("tbody");
  const table = el(
    "table",
    { class: "records", id: "eventTable" },
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        ["Time", "Event", "Seq", "Button", "TTL", "Flags"].map((h) =>
          el("th", { text: h }),
        ),
      ),
    ),
    tbody,
  );

  host.append(
    el(
      "div",
      { class: "card", id: "eventCard" },
      el("div", { class: "card-title" }, "Button and TTL events"),
      supportLine,
      configLine,
      el(
        "div",
        { class: "row" },
        btnStatus,
        btnOpen,
        btnCsv,
        btnClear,
        fileInput,
      ),
      statusLine,
      fileLine,
      kv,
      el(
        "div",
        {
          class: "table-wrap",
          style: { maxHeight: "240px", overflowY: "auto" },
        },
        table,
      ),
    ),
  );

  // ---------------------------------------------------------------------------

  /**
   * Say whether this connection takes the records live.
   *
   * @param {"none"|"yes"|"no"|"usb"} state
   */
  function setSupport(state) {
    supportLine.textContent =
      {
        none: "Not connected.",
        yes: "This firmware has the event channel: records arrive here live, logging or not.",
        no: "This firmware has no event channel. Event files can still be opened.",
        usb: "Over USB the sensor cannot send records live. Event files can still be opened.",
      }[state] ?? "";
    supported = state === "yes";
    btnStatus.disabled = !(supported && linkFree);
    if (!supported) statusLine.textContent = "";
  }

  /**
   * Show what configuration byte 232 records, from the image the
   * Configuration tab holds.
   *
   * @param {number|null} byte232 null when the image has no such byte
   */
  function setConfig(byte232) {
    if (byte232 == null) {
      configLine.textContent = "";
      return;
    }
    const s = sdk.decodeButtonLogMode(byte232);
    const parts = [];
    parts.push(sdk.recordsButtonPresses(byte232) ? "button presses" : null);
    parts.push(s.ttlInput ? "the TTL input" : null);
    const inputs = parts.filter(Boolean);
    configLine.textContent = inputs.length
      ? `The configuration records ${inputs.join(" and ")}.`
      : "The configuration records neither input: set Button Mode 4 or 5, or Record TTL Input, on the Configuration tab.";
  }

  /** @param {boolean} canAsk whether the link is free for the status command */
  function setEnabled(canAsk) {
    linkFree = canAsk;
    btnStatus.disabled = !(supported && linkFree);
  }

  async function readStatus() {
    if (!opts.onReadStatus) return;
    const st = await opts.onReadStatus();
    if (st) showStatus(st);
  }

  /** @param {object} st the SDK's EventChannelStatus */
  function showStatus(st) {
    const yes = (b) => (b ? "yes" : "no");
    statusLine.textContent =
      `Inputs on: ${inputsText(st.inputsEnabled)} · stream ${yes(st.streaming)} · ` +
      `file ${st.fileError ? "STOPPED BY AN ERROR" : st.fileOpen ? "open" : "closed"} · ` +
      `TTL ${st.ttlThrottled ? "throttled" : st.ttlArmed ? "armed" : "not armed"} · ` +
      `now: button ${st.state & 1 ? "down" : "up"}, TTL ${st.state & 2 ? "high" : "low"} · ` +
      `lost this session ${st.sessionDropped}, by the link ${st.linkLost}`;
  }

  function inputsText(mask) {
    const on = [];
    if (mask & 1) on.push("button");
    if (mask & 2) on.push("TTL");
    return on.length ? on.join(" + ") : "none";
  }

  /**
   * One record, live from the sensor.
   *
   * @param {object} rec the SDK's EventRecord
   */
  function push(rec) {
    if (source !== "live") clear();
    // The link numbers its own records from 0 at the opt-in: a gap is records
    // its queue had no room for (the event file still has them).
    if (
      lastSeq !== null &&
      rec.seq !== ((lastSeq + 1) & 0xffff) &&
      rec.seq !== 0
    ) {
      linkGaps += (rec.seq - lastSeq - 1 + 0x10000) & 0xffff;
    }
    lastSeq = rec.seq;
    addRow(rec, 0n);
    paintCounts();
  }

  function addRow(rec, rtcOffsetTicks) {
    const unixMs = sdk.eventTicksToUnixMs(rec.ticks, rtcOffsetTicks);
    all.push({ rec, unixMs });
    if (rec.type === sdk.EVENT_RECORD_TYPE.EDGE) {
      if (rec.channel === sdk.EVENT_CHANNEL.BUTTON) counts.button++;
      else if (rec.channel === sdk.EVENT_CHANNEL.TTL) counts.ttl++;
    }
    counts.dropped = Math.max(counts.dropped, rec.dropped);
    btnCsv.disabled = false;

    const tr = el(
      "tr",
      { "data-event-type": String(rec.type) },
      el("td", { class: "mono", text: formatTime(unixMs) }),
      el("td", { text: sdk.describeEventRecord(rec) }),
      el("td", { class: "mono", text: String(rec.seq) }),
      el("td", { text: rec.buttonDown ? "down" : "up" }),
      el("td", { text: rec.ttlHigh ? "high" : "low" }),
      el("td", { class: "mono", text: flagsText(rec.flags) }),
    );
    tbody.prepend(tr);
    while (tbody.rows.length > MAX_ROWS) tbody.lastElementChild?.remove();
  }

  function paintCounts() {
    nButton.textContent = String(counts.button);
    nTtl.textContent = String(counts.ttl);
    const lost = counts.dropped + linkGaps;
    nLost.textContent = lost
      ? `${lost} (${counts.dropped} at the sensor, ${linkGaps} by the link)`
      : "0";
  }

  /** @param {File|undefined} file */
  async function openFile(file) {
    fileInput.value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadFile(bytes, file.name);
  }

  /**
   * Show an event file's records in place of the live ones.
   *
   * @param {Uint8Array} bytes
   * @param {string} name
   * @returns {boolean} whether it decoded
   */
  function loadFile(bytes, name) {
    let file;
    try {
      file = sdk.parseEventFile(bytes);
    } catch (err) {
      fileLine.textContent = `${name}: ${err?.message ?? err}`;
      opts.log?.(`event file ${name} not read: ${err?.message ?? err}`);
      return false;
    }
    clear();
    source = "file";
    fileHeader = file.header;
    const h = file.header;
    const fw = `${h.firmwareVersion.major}.${String(h.firmwareVersion.minor).padStart(2, "0")}.${String(
      h.firmwareVersion.internal,
    ).padStart(3, "0")}`;
    fileLine.textContent =
      `${name}: ${h.hardwareId === 10 ? "Shimmer3R" : h.hardwareId === 3 ? "Shimmer3" : `hardware ${h.hardwareId}`}, ` +
      `firmware ${fw}, opened ${formatTime(sdk.eventTicksToUnixMs(h.fileOpenTicks, h.rtcOffsetTicks))} ` +
      `(${h.openReason === 2 ? "split" : "session start"}), records ${inputsText(h.inputs)}; ` +
      `${file.records.length} records` +
      (file.complete ? "" : " — no final record, so the file was cut short") +
      (file.trailingBytes
        ? `, ${file.trailingBytes} stray bytes at the end`
        : "") +
      ".";
    for (const rec of file.records) addRow(rec, h.rtcOffsetTicks);
    paintCounts();
    opts.log?.(`event file ${name}: ${file.records.length} records`);
    return true;
  }

  function saveCsv() {
    if (!all.length || !opts.downloadBlob) return;
    const head = [
      "source",
      "seq",
      "type",
      "event",
      "channel",
      "button",
      "ttl",
      "flags",
      "ticks",
      "unix_ms",
      "time_utc",
      "dropped",
    ];
    const lines = [head.join(",")];
    for (const { rec, unixMs } of all) {
      lines.push(
        [
          source,
          rec.seq,
          rec.type,
          sdk.describeEventRecord(rec),
          rec.channel === 0xff ? "" : rec.channel,
          rec.buttonDown ? 1 : 0,
          rec.ttlHigh ? 1 : 0,
          `0x${rec.flags.toString(16).padStart(2, "0")}`,
          rec.ticks.toString(),
          unixMs.toFixed(3),
          new Date(unixMs).toISOString(),
          rec.dropped,
        ].join(","),
      );
    }
    const name = `events_${source}_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    opts.downloadBlob(
      name,
      new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" }),
    );
  }

  /** Empty the table and the counters; the next live record starts afresh. */
  function clear() {
    all = [];
    source = "live";
    lastSeq = null;
    linkGaps = 0;
    counts = { button: 0, ttl: 0, dropped: 0 };
    fileHeader = null;
    tbody.replaceChildren();
    fileLine.textContent = "";
    btnCsv.disabled = true;
    paintCounts();
  }

  /** A new connection: the link's sequence numbers start again. */
  function resetLink() {
    lastSeq = null;
  }

  return {
    setSupport,
    setConfig,
    setEnabled,
    showStatus,
    push,
    loadFile,
    clear,
    resetLink,
    /** Records shown, for tests. */
    get count() {
      return all.length;
    },
    get fileHeader() {
      return fileHeader;
    },
  };
}

/** Local time of day with milliseconds, and the date when it is not today. */
function formatTime(unixMs) {
  if (!Number.isFinite(unixMs)) return "–";
  const d = new Date(unixMs);
  const p2 = (n) => String(n).padStart(2, "0");
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, "0")}`;
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? time
    : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${time}`;
}

function flagsText(flags) {
  const out = [];
  if (flags & 0x01) out.push("timer");
  if (flags & 0x02) out.push("synth");
  if (flags & 0x04) out.push("late");
  if (flags & 0x80) out.push("final");
  return out.join(" ");
}
