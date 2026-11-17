/**
 * SR number: program a Shimmer3 or Shimmer3R's board identity (DEV-1493).
 *
 * The SR number — `SR47-8-1`, board id, revision, special revision — lives in
 * the first three bytes of the board's EEPROM identity page, and the firmware
 * keys its hardware behaviour on it: which sensors are fitted, which pressure
 * chip, whether ExG is there. Consensys's factory build programs it from
 * Manage Devices → "Program Exp. Board ID" (`DialogExpansionBoardIdSelection`),
 * over a dock only. This panel is that dialog for this page, over every link
 * the page speaks:
 *
 * - a board list in Consensys's form, `ECG/EMG/Resp (SR47)`, narrowed to the
 *   boards the connected platform is built on (`sdk.listShimmerSrBoards`),
 *   plus "Other SR number…" for a board newer than the list;
 * - a revision and a special revision;
 * - a confirmation naming the old and the new number, as Consensys asks;
 * - the write and its read-back, which the SDK does in one call
 *   (`writeSrBoard` on the radio client, `writeExpansionBoard` on the dock
 *   client), and which throws when the page does not read back as written;
 * - the last number programmed is REMEMBERED on this computer and preselected
 *   next time, so a production run of one board is pick-once, program-many.
 *
 * The sensor keeps what it decided from the old board at boot until it
 * restarts, so a successful write ends with the restart offered: over
 * Bluetooth by arming the firmware's one-shot restart-on-disconnect and
 * dropping the link, over USB by power-cycling by hand.
 *
 * Like the other panels it builds its own markup inside the host element and
 * owns the `disabled` state of every control in it. It reads no page globals:
 * the client, the board the page read at connect and the hardware id come in
 * as getters.
 *
 * Nothing here touches `document` at import time.
 *
 *   import { createSrNumberPanel } from "./common/sr-number-panel.js";
 */

import { el } from "./ui-chrome.js";
/* The whole namespace, not destructured names: a vendored bundle from before
   SR programming then degrades to a message instead of failing the import and
   taking the page with it. */
import * as sdk from "../vendor/shimmer-web-sdk.esm.js";

/** localStorage key for the last SR number programmed from this page. */
export const LAST_SR_STORAGE_KEY = "shimmerCaptureLastSrBoard";

/** The select's value for "a code not in the list". */
const OTHER = "other";

/** Links that carry the Bluetooth command set, and with it SET_FEATURE's restart. */
const BLUETOOTH_LINKS = new Set(["ble", "rfcomm", "btclassic", "bt", "spp"]);

/** The SDK names this panel needs; any missing means a stale vendored bundle. */
const SDK_FUNCTIONS = [
  "listShimmerSrBoards",
  "formatShimmerSrBoardName",
  "formatShimmerSrCode",
  "assertShimmerSrBoardWritable",
  "isSameShimmerSrBoard",
  "isShimmerSrBoardValid",
];

/**
 * Mount the SR number panel inside `host`.
 *
 * @param {HTMLElement} host an empty container; its contents are replaced
 * @param {object} opts
 * @param {() => object|null} opts.client the connected client, or null
 * @param {() => string|null} [opts.mode] which link the client is on; decides
 *   only whether the restart can be asked for over the link
 * @param {() => number|null} [opts.identifiedHardwareVersion] the hardware id
 *   the sensor REPORTED (3 Shimmer3, 10 Shimmer3R), never a defaulted one:
 *   it decides which boards are offered, and an unknown sensor is offered the
 *   Shimmer3 list, which holds the Shimmer3R's boards too
 * @param {() => object|null} [opts.board] the SR identity the page read at
 *   connect, `{boardId, boardRev, specialRev}`, or null for a blank page
 * @param {(what: string, fn: () => Promise<unknown>) => Promise<unknown>} [opts.withLink]
 *   runs one device operation with the page's busy flag held. It may resolve
 *   undefined without running `fn` (the link is busy, or gone), and rejects
 *   when `fn` does. Defaults to running `fn` directly.
 * @param {(board: object) => void} [opts.onProgrammed] the read-back board,
 *   after a successful write
 * @param {() => Promise<void>|void} [opts.disconnect] the page's own teardown,
 *   for the restart; defaults to `client.disconnect()`
 * @param {{log: Function, warn: Function, error: Function}} [opts.log]
 * @param {(message: string, kind?: string) => void} [opts.toast]
 * @param {(text: string) => boolean} [opts.confirm] defaults to `window.confirm`
 * @param {Storage|null} [opts.storage] defaults to `window.localStorage`
 */
export function createSrNumberPanel(host, opts = {}) {
  const getClient = asGetter(opts.client);
  const getMode = asGetter(opts.mode);
  const getHardware = asGetter(opts.identifiedHardwareVersion);
  const getBoard = asGetter(opts.board);
  const withLink = opts.withLink ?? ((_what, fn) => fn());
  const log = opts.log ?? { log() {}, warn() {}, error() {} };
  const toast = opts.toast ?? (() => {});
  const ask = opts.confirm ?? ((text) => window.confirm(text));
  const storage =
    opts.storage === undefined ? safeLocalStorage() : opts.storage;

  const missing = SDK_FUNCTIONS.filter(
    (name) => typeof sdk[name] !== "function",
  );
  if (missing.length) {
    host.replaceChildren(
      el(
        "div",
        { class: "banner err" },
        `This page is running an SDK bundle that cannot program SR numbers (missing ${missing.join(", ")}). Re-vendor the SDK.`,
      ),
    );
    log.error(
      `SR programming unavailable: the vendored SDK has no ${missing.join(", ")}`,
    );
    return inertPanel();
  }

  /** The floor the host page sets: can the link take a write right now? */
  let enabled = false;
  /** A write or a restart is in flight from this panel. */
  let working = false;
  /**
   * The client the form was last filled for, so a new sensor refills it.
   * Undefined until the first paint, so that one fills the form too.
   */
  let filledFor;
  /**
   * The sensor's number when the form was filled, as `SR47-8-1` or "". The
   * page reads the board a few round trips into the connect, after the first
   * paint, so an untouched form is filled again once it arrives.
   */
  let filledBoard = "";
  /** The user has changed the form since it was last filled. */
  let touched = false;
  /** Bluetooth only: the firmware NACKed the restart feature once. */
  let restartRefused = false;

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  const stat = (role, label) =>
    el(
      "div",
      {},
      el("span", { class: "stat-label" }, label),
      el("span", { class: "stat-value", dataset: { srRole: role } }, "–"),
    );
  const statsStrip = el(
    "div",
    { class: "stats" },
    stat("current", "On the sensor"),
    stat("last", "Last programmed here"),
  );
  const setStat = (role, text) => {
    const node = statsStrip.querySelector(`[data-sr-role="${role}"]`);
    if (node) node.textContent = text ?? "–";
  };

  const selBoard = el("select", {
    dataset: { srRole: "board" },
    onchange: edited,
  });
  const inOther = el("input", {
    type: "number",
    min: "1",
    max: "254",
    step: "1",
    inputmode: "numeric",
    placeholder: "1–254",
    dataset: { srRole: "other" },
    oninput: edited,
  });
  const inRev = el("input", {
    type: "number",
    min: "0",
    max: "255",
    step: "1",
    inputmode: "numeric",
    dataset: { srRole: "rev" },
    oninput: edited,
  });
  const inSpecial = el("input", {
    type: "number",
    min: "0",
    max: "255",
    step: "1",
    inputmode: "numeric",
    dataset: { srRole: "special" },
    oninput: edited,
  });
  const otherField = el(
    "div",
    { class: "field", hidden: true },
    el("label", {}, "SR number", inOther),
    el(
      "div",
      { class: "field-hint" },
      "A board id this page has no name for. The firmware only knows the boards it was built for.",
    ),
  );

  const preview = el("div", {
    class: "field-hint",
    dataset: { srRole: "preview" },
  });
  const problem = el("div", {
    class: "brand-error",
    dataset: { srRole: "problem" },
  });

  const btnProgram = el(
    "button",
    { type: "button", class: "primary", dataset: { srRole: "program" } },
    "Program SR number",
  );
  const btnFromSensor = el(
    "button",
    {
      type: "button",
      class: "secondary",
      dataset: { srRole: "fromSensor" },
      title: "Fill the form with the number the sensor reports now.",
    },
    "Use the sensor's number",
  );

  const result = el("div", {
    class: "banner",
    dataset: { srRole: "result" },
    hidden: true,
  });

  const restartText = el("div", { dataset: { srRole: "restartText" } });
  const btnRestart = el(
    "button",
    { type: "button", class: "primary", dataset: { srRole: "restart" } },
    "Restart now",
  );
  const restartCard = el(
    "div",
    { class: "card", dataset: { srRole: "restart-banner" }, hidden: true },
    el("div", { class: "card-title" }, "Restart the sensor"),
    restartText,
    el("div", { class: "row" }, btnRestart),
  );

  host.replaceChildren(
    statsStrip,
    el(
      "div",
      { class: "row" },
      el("div", { class: "field" }, el("label", {}, "Board", selBoard)),
      otherField,
      el("div", { class: "field" }, el("label", {}, "Revision", inRev)),
      el(
        "div",
        { class: "field" },
        el("label", {}, "Special revision", inSpecial),
      ),
    ),
    preview,
    problem,
    el("div", { class: "row" }, btnProgram, btnFromSensor),
    result,
    restartCard,
  );

  // -------------------------------------------------------------------------
  // Remembered number
  // -------------------------------------------------------------------------

  function loadLast() {
    try {
      const raw = storage?.getItem(LAST_SR_STORAGE_KEY);
      if (!raw) return null;
      const b = JSON.parse(raw);
      sdk.assertShimmerSrBoardWritable(b);
      return {
        boardId: b.boardId,
        boardRev: b.boardRev,
        specialRev: b.specialRev,
      };
    } catch {
      return null;
    }
  }

  function saveLast(board) {
    try {
      storage?.setItem(
        LAST_SR_STORAGE_KEY,
        JSON.stringify({
          boardId: board.boardId,
          boardRev: board.boardRev,
          specialRev: board.specialRev,
        }),
      );
    } catch {
      /* Private window or blocked storage: the write still happened, and
         the form keeps its values for this session. */
    }
  }

  // -------------------------------------------------------------------------
  // Form
  // -------------------------------------------------------------------------

  /** `ECG/EMG/Resp (SR47-8-1)`, or `SR232-8-1` for an unnamed code. */
  function describe(board) {
    const code = sdk.formatShimmerSrCode(board);
    const name = sdk.SHIMMER_SR_BOARD_NAMES?.[board.boardId];
    return name ? `${name} (${code})` : code;
  }

  function choices() {
    return sdk.listShimmerSrBoards(getHardware());
  }

  /** Rebuild the board list for the connected platform, keeping the selection. */
  function fillBoardList() {
    const keep = selBoard.value;
    const list = choices();
    selBoard.replaceChildren(
      el("option", { value: "" }, "Choose a board…"),
      ...list.map((c) => el("option", { value: String(c.boardId) }, c.label)),
      el("option", { value: OTHER }, "Other SR number…"),
    );
    if ([...selBoard.options].some((o) => o.value === keep))
      selBoard.value = keep;
  }

  /** Put `board` into the form, as a list entry when it is one. */
  function setForm(board) {
    fillBoardList();
    if (!board) {
      selBoard.value = "";
      inOther.value = "";
      inRev.value = "";
      inSpecial.value = "";
      return;
    }
    const listed = choices().some((c) => c.boardId === board.boardId);
    selBoard.value = listed ? String(board.boardId) : OTHER;
    inOther.value = listed ? "" : String(board.boardId);
    inRev.value = String(board.boardRev);
    inSpecial.value = String(board.specialRev);
  }

  /**
   * The board the form describes, or a reason it does not describe one.
   * @returns {{board: object|null, problem: string|null}}
   */
  function readForm() {
    const pick = selBoard.value;
    if (!pick) return { board: null, problem: "Choose a board." };
    const boardId = pick === OTHER ? intOf(inOther.value) : Number(pick);
    if (boardId == null)
      return { board: null, problem: "Enter the SR number, 1–254." };
    const boardRev = intOf(inRev.value);
    if (boardRev == null)
      return { board: null, problem: "Enter the revision, 0–255." };
    const specialRev = intOf(inSpecial.value);
    if (specialRev == null) {
      return { board: null, problem: "Enter the special revision, 0–255." };
    }
    const board = { boardId, boardRev, specialRev };
    try {
      sdk.assertShimmerSrBoardWritable(board);
    } catch (err) {
      return { board: null, problem: err?.message ?? String(err) };
    }
    return { board, problem: null };
  }

  /** A caution about `board` worth reading before writing it, or null. */
  function cautionFor(board) {
    if (!choices().some((c) => c.boardId === board.boardId)) {
      const hw = getHardware();
      const platform =
        hw === 10 ? "a Shimmer3R" : hw === 3 ? "a Shimmer3" : "this sensor";
      return `SR${board.boardId} is not a board ${platform} is built on. The firmware will not recognise its sensors.`;
    }
    const current = getBoard();
    if (
      sdk.isShimmerSrBoardValid(current) &&
      current.boardId !== board.boardId
    ) {
      return `This changes the board type, not just its revision: the sensor reports ${describe(current)} now.`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  /** A control the user changed: the form is theirs now, not the sensor's. */
  function edited() {
    touched = true;
    sync();
  }

  function sync() {
    const client = getClient();
    const reported = client ? validOrNull(getBoard()) : null;
    const reportedKey = reported ? sdk.formatShimmerSrCode(reported) : "";
    if (client !== filledFor || (!touched && reportedKey !== filledBoard)) {
      /* A new sensor, or the same one reconnected, or its number has arrived
         and nobody has typed since: fill the form afresh. The remembered
         number wins over the sensor's own, because the point of remembering
         it is a run of sensors that all get the same one. */
      if (client !== filledFor) {
        restartRefused = false;
        touched = false;
        if (!client) {
          result.hidden = true;
          restartCard.hidden = true;
        }
      }
      filledFor = client;
      filledBoard = reportedKey;
      setForm(client ? (loadLast() ?? reported) : loadLast());
    } else {
      fillBoardList();
    }

    otherField.hidden = selBoard.value !== OTHER;

    const current = client ? getBoard() : null;
    setStat(
      "current",
      !client
        ? "–"
        : sdk.isShimmerSrBoardValid(current)
          ? describe(current)
          : "not programmed",
    );
    const last = loadLast();
    setStat("last", last ? describe(last) : "nothing yet");

    const { board, problem: why } = readForm();
    problem.textContent = client && why && selBoard.value ? why : "";
    if (board) {
      const caution = cautionFor(board);
      preview.textContent =
        `Will program ${describe(board)}.` +
        (sdk.isSameShimmerSrBoard(board, current)
          ? " The sensor already reports this number."
          : "") +
        (caution ? ` ${caution}` : "");
    } else {
      preview.textContent = "";
    }

    const live = enabled && !!client && !working;
    for (const c of [selBoard, inOther, inRev, inSpecial]) c.disabled = !live;
    btnProgram.disabled = !live || !board;
    btnFromSensor.disabled = !live || !sdk.isShimmerSrBoardValid(current);
    btnRestart.disabled = !enabled || !client || working;
  }

  function showResult(kind, text) {
    result.className = `banner ${kind}`;
    result.textContent = text;
    result.hidden = false;
  }

  function canRestartOverLink() {
    const client = getClient();
    return (
      !restartRefused &&
      BLUETOOTH_LINKS.has(getMode() ?? "") &&
      typeof client?.setRebootOnDisconnect === "function"
    );
  }

  function paintRestart() {
    const auto = canRestartOverLink();
    btnRestart.hidden = !auto;
    restartText.textContent = auto
      ? "The sensor still runs as its old board: the firmware chooses its sensors when it starts. Restart now arms a one-shot restart and drops the link, and the sensor restarts as it goes."
      : "The sensor still runs as its old board: the firmware chooses its sensors when it starts. Power-cycle it by hand: disconnect this page, then undock and re-dock it (a Shimmer3R can also be held off with its button and switched on again). Reconnect to check the new number.";
    restartCard.hidden = false;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Confirm, write, read back, remember.
   * @returns {Promise<object|null>} the read-back board, or null
   */
  async function program() {
    const client = getClient();
    if (!client) {
      toast("Connect a sensor first", "warn");
      return null;
    }
    const { board, problem: why } = readForm();
    if (!board) {
      toast(why ?? "Choose a board", "warn");
      return null;
    }
    const write =
      typeof client.writeSrBoard === "function"
        ? (b) => client.writeSrBoard(b)
        : typeof client.writeExpansionBoard === "function"
          ? (b) => client.writeExpansionBoard(b)
          : null;
    if (!write) {
      toast(
        "This link's client cannot program an SR number. Re-vendor the SDK.",
        "err",
      );
      return null;
    }

    const current = getBoard();
    const caution = cautionFor(board);
    const ok = ask(
      `Overwrite this sensor's SR number?\n\n` +
        `Now: ${sdk.isShimmerSrBoardValid(current) ? describe(current) : "not programmed"}\n` +
        `New: ${describe(board)}\n\n` +
        (caution ? `${caution}\n\n` : "") +
        `The firmware decides which sensors are fitted from this number. A wrong one can stop the sensor working until it is programmed again.`,
    );
    if (!ok) return null;

    working = true;
    sync();
    const code = sdk.formatShimmerSrCode(board);
    try {
      const readBack = await withLink(`program the SR number (${code})`, () =>
        write(board),
      );
      if (!readBack) {
        /* The page refused to start it (busy, or the link went): it has
           already said so. */
        return null;
      }
      saveLast(readBack);
      log.log(`SR number programmed and read back: ${describe(readBack)}`);
      showResult(
        "ok",
        `Programmed and read back: ${describe(readBack)}. Remembered on this computer for the next sensor.`,
      );
      opts.onProgrammed?.(readBack);
      paintRestart();
      return readBack;
    } catch (err) {
      showResult(
        "err",
        `The SR number was not programmed: ${err?.message ?? err}`,
      );
      return null;
    } finally {
      working = false;
      sync();
    }
  }

  /** Arm the firmware's restart-on-disconnect, then drop the link. */
  async function restart() {
    const client = getClient();
    if (!client) return false;
    if (!canRestartOverLink()) {
      paintRestart();
      return false;
    }
    working = true;
    sync();
    try {
      const armed = await withLink("arm the sensor's restart", async () => {
        await client.setRebootOnDisconnect(true);
        return true;
      });
      if (!armed) return false;
    } catch (err) {
      restartRefused = true;
      log.warn(
        `the sensor would not arm a restart (${err?.message ?? err}); power-cycle it by hand`,
      );
      paintRestart();
      return false;
    } finally {
      working = false;
      sync();
    }
    log.log(
      "restart armed — disconnecting so the sensor restarts as its new board",
    );
    try {
      await (opts.disconnect ? opts.disconnect() : client.disconnect());
    } catch (err) {
      log.warn(`disconnect reported an error: ${err?.message ?? err}`);
    }
    restartCard.hidden = true;
    return true;
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  btnProgram.addEventListener("click", () => {
    program().catch(() => {});
  });
  btnFromSensor.addEventListener("click", () => {
    setForm(validOrNull(getBoard()));
    touched = true;
    sync();
  });
  btnRestart.addEventListener("click", () => {
    restart().catch(() => {});
  });

  sync();

  return {
    program,
    restart,
    /** The board the form describes now, or null. */
    selection: () => readForm().board,
    /** Put a board into the form, as a page or a test would. */
    setSelection: (board) => {
      setForm(board);
      sync();
    },
    lastProgrammed: loadLast,
    /** Repaint from the getters (the connected sensor, its board). */
    refresh: sync,
    /**
     * The floor the host page sets: whether the link can take a write right
     * now. The panel still refuses a second write of its own.
     */
    setEnabled(next) {
      enabled = !!next;
      sync();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asGetter(value) {
  return typeof value === "function" ? value : () => value ?? null;
}

function intOf(text) {
  const s = String(text ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

function validOrNull(board) {
  return sdk.isShimmerSrBoardValid?.(board) ? board : null;
}

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The API shape with every operation refusing, for a stale SDK bundle. */
function inertPanel() {
  return {
    program: async () => null,
    restart: async () => false,
    selection: () => null,
    setSelection() {},
    lastProgrammed: () => null,
    refresh() {},
    setEnabled() {},
  };
}
