/**
 * Connect / disconnect chrome shared by the webBLEDemos pages: capability
 * gating for the three connect buttons, the connect-failure diagnostics that
 * were worth more than the rest of the session when a link misbehaved, port
 * identity logging, platform advice and disconnect detection.
 *
 * Ported from the two pages that grew this logic independently:
 *   - the retired sd-download demo — setConnected (L370-387), connectVia
 *                                 (L470-550), connectFailureHints (L559-576),
 *                                 logPortIdentity (L600-624), the startup
 *                                 advice (L872-885)
 *   - the retired eeprom-branding demo — the three-button setConnected (L527-544),
 *                                 the classic-BT catch (L875-889), the SDK
 *                                 version probe (L1053-1063) and the
 *                                 transportAdvice loop (L1075-1078)
 *
 * The controller never constructs a client itself — the page supplies
 * factories — so the same code drives Shimmer3RClient, Shimmer3Client,
 * WiredShimmerClient and, later, Verisense.
 *
 * The link's look follows one design shared with the Verisense device
 * console (DEV-1520), so a user who knows one app reads the other:
 *   - every connect button carries the same weight at rest — none is styled
 *     as the preferred one, because a highlight that never moves reads as
 *     "connected over this link" when the sensor may be on another;
 *   - the button of the link actually in use is marked instead
 *     (`data-link-state`: "connecting", then "connected");
 *   - one pill says the state and the link in the same words in both apps:
 *     "disconnected", "connecting via BLE…", "connected via USB",
 *     "reconnecting via BLE…";
 *   - Disconnect reads "Cancel" while a connect is in progress, and is one.
 *
 * No DOM access at import time.
 *
 *   import { createConnectController } from "./common/connect-ui.js";
 */

/**
 * Human label per connect mode, used in the link pill, log lines and hint
 * text. `rfcomm` rather than `btclassic` because that is what the link
 * actually is (a Bluetooth serial port), and it distinguishes it from BLE at a
 * glance. Each label is the one on its connect button, so the pill's
 * "connected via USB" names the button that was pressed.
 */
const MODE_LABELS = Object.freeze({
  ble: "BLE",
  rfcomm: "Classic Bluetooth",
  usb: "USB",
});

/** Which `TransportNeed` each mode rides, for transportAdvice(). */
const MODE_NEEDS = Object.freeze({
  ble: "ble",
  rfcomm: "classicBluetooth",
  usb: "wiredSerial",
});

/**
 * The exact status string the SDK emits when the link drops. Matched as an
 * equality test, not a regex: "disconnect" appears in plenty of benign status
 * lines ("disconnecting…", "requested disconnect"), and treating one of those
 * as a real drop tears down a live session.
 */
export const SDK_DISCONNECT_STATUS = "Device disconnected";

/** Oldest vendored SDK whose BLE record reads are not truncated. */
const MIN_USEFUL_SDK = "0.1.12";

/** The message a cancelled connect rejects with, so the catch can tell it. */
const CANCELLED = "connect cancelled";

/**
 * Create the connect controller.
 *
 * @param {object} cfg
 * @param {object} cfg.els  buttons and status elements; all optional, so a
 *   page that offers only BLE just omits `usb`/`bt`
 * @param {HTMLButtonElement} [cfg.els.ble]     "Connect BLE"
 * @param {HTMLButtonElement} [cfg.els.usb]     "Connect USB / dock"
 * @param {HTMLButtonElement} [cfg.els.bt]      "Connect Classic Bluetooth"
 * @param {HTMLButtonElement} [cfg.els.disconnect] reads "Cancel" while a
 *   connect is in progress; the page routes that click to `cancelConnect()`
 * @param {HTMLElement} [cfg.els.pill]    connection pill (`.pill`): `.on`
 *   while connected, `.warn` while connecting or reconnecting, and its
 *   `data-link-state` says which
 * @param {HTMLElement} [cfg.els.info]    free-text status line
 * @param {HTMLElement} [cfg.els.banner]  `.banner` for platform advice
 * @param {{log: Function, warn?: Function, error?: Function}|Function} cfg.log
 *   a `createLog()` handle, or a bare `log(msg)` function
 * @param {object} cfg.sdkNs the whole vendored SDK namespace object — passed
 *   as a namespace, not destructured, so a bundle missing a newer export
 *   degrades to a warning instead of breaking the page's import
 * @param {object} cfg.makeClients factories keyed by mode. Each returns either
 *   a client, or `{client, transport}` when the page built the transport
 *   itself (the classic-BT path needs the transport for logPortIdentity)
 * @param {() => unknown} [cfg.makeClients.ble]
 * @param {() => unknown} [cfg.makeClients.bt]
 * @param {() => unknown} [cfg.makeClients.usb]
 * @param {(session: object) => unknown} [cfg.afterConnect] post-connect hook;
 *   its failure is logged and never tears down the connection it reports on
 * @param {(reason?: Error|string) => void} [cfg.onDisconnected]
 * @param {(label: string) => void} [cfg.onConnected] called once a connect
 *   the user started is live, with the link's label; not for one made while
 *   `setReconnecting` is set, since the reconnect reports its own outcome
 * @param {(msg: string) => boolean} [cfg.echoStatus] whether one SDK status
 *   line goes to the log; omitted, every line does. For a page's background
 *   reads, whose two lines a minute would bury the log. The disconnect line
 *   is echoed whatever this says, since it explains what happens next.
 * @param {boolean} [cfg.announceStartup=true] log the SDK version and the
 *   per-transport platform advice on creation
 * @returns {{
 *   connectVia: (mode: "ble"|"rfcomm"|"usb") => Promise<boolean>,
 *   cancelConnect: () => Promise<boolean>,
 *   disconnect: () => Promise<void>,
 *   readonly session: object|null,
 *   readonly connecting: boolean,
 *   setConnected: (on: boolean, label?: string) => void,
 *   setReconnecting: (label: string|null) => void,
 *   setLocked: (reason: string|null) => void,
 *   support: object,
 *   connectFailureHints: (mode: string, err: unknown) => string[],
 *   logPortIdentity: (transport: unknown) => void,
 * }}
 */
export function createConnectController(cfg) {
  const els = cfg.els ?? {};
  const sdkNs = cfg.sdkNs ?? {};
  const makeClients = cfg.makeClients ?? {};

  const logger =
    typeof cfg.log === "function" ? { log: cfg.log } : (cfg.log ?? {});
  const log = (msg) => logger.log?.(String(msg));
  const warn = (msg) => (logger.warn ?? logger.log)?.(String(msg));
  const error = (msg) => (logger.error ?? logger.log)?.(String(msg));

  /* Capability snapshot, hoisted above the first setConnected(false) below:
   * setConnected reads `support`, so taking the snapshot afterwards would
   * gate the buttons on `undefined` on the very first paint. */
  const support = sdkNs.describePlatformSupport?.() ?? {
    webSerial: typeof navigator?.serial?.requestPort === "function",
    webBluetooth: typeof navigator?.bluetooth?.requestDevice === "function",
    isAndroid: false,
    isIOS: false,
    serialBluetoothOnly: false,
  };

  /** @type {{client: unknown, mode: string, transport: unknown, label: string}|null} */
  let session = null;
  /**
   * Set while something else owns the link, such as the Bluetooth module
   * update: its transfer, the module's restart and the reconnects that follow
   * all drop and re-open the link themselves, and a connect or Disconnect
   * clicked meanwhile would race them. It holds the BUTTONS only; the owner's
   * own calls to connectVia still go through.
   * @type {string|null}
   */
  let lockReason = null;
  /** What setConnected last showed, so unlocking can restore it. */
  let shownConnected = false;
  /** @type {string|undefined} */
  let shownLabel;
  let connecting = false;
  /** The mode of the connect in progress, for its button and the pill. */
  let pendingMode = null;
  /** The client and transport of the connect in progress, for Cancel. */
  let pending = null;
  /** Rejects the connect in progress; set only while one runs. */
  let rejectPending = null;
  /**
   * The page's automatic reconnect, while one runs: the label of the link it
   * is bringing back. Between its tries the link is down, but the pill says
   * "reconnecting", not "disconnected", because the page has not given up.
   * @type {string|null}
   */
  let reconnectLabel = null;
  /** Guards the disconnect path against firing twice for one drop. */
  let disconnectReported = false;
  /** Detach the SDK disconnect subscription, when it returned one. */
  let detachDisconnect = null;

  // -------------------------------------------------------------------------
  // Button state
  // -------------------------------------------------------------------------

  /** The connect button for each mode, and whether this browser can use it. */
  const linkButtons = () => [
    { mode: "ble", el: els.ble, capable: !!support.webBluetooth },
    { mode: "rfcomm", el: els.bt, capable: !!support.webSerial },
    { mode: "usb", el: els.usb, capable: !!support.webSerial },
  ];

  /**
   * Why a button this browser cannot use is disabled, for its tooltip: the
   * SDK's own advice where it has some, else the missing API by name.
   */
  function incapableNote(mode) {
    const advice = sdkNs.transportAdvice?.(support, MODE_NEEDS[mode]);
    if (advice) return advice;
    return mode === "ble"
      ? "This browser has no Web Bluetooth. Use Chrome or Edge."
      : "This browser has no Web Serial. Use Chrome or Edge on a computer.";
  }

  /**
   * Apply the link state to the chrome: the buttons, which one is in use,
   * and the pill.
   *
   * Capability is a floor the connected-state cannot lift. Assigning
   * `disabled = on` alone re-enabled every button on each disconnect, so on a
   * browser with only some of these APIs — desktop Firefox has Web Serial but
   * no Web Bluetooth — one connect/disconnect cycle handed the user a button
   * that cannot work.
   *
   * The wired/dock button is the exception that proves the rule: it gates on
   * webSerial only, because on Android that is true while a wired port is
   * merely "unlikely" — advised about below, deliberately not disabled.
   */
  function render() {
    const on = shownConnected;
    const activeMode = on ? (session?.mode ?? null) : null;
    for (const { mode, el, capable } of linkButtons()) {
      if (!el) continue;
      el.disabled = on || connecting || !!lockReason || !capable;
      el.title = lockReason ?? (capable ? "" : incapableNote(mode));
      /* The link in use is the one button marked; at rest none is. */
      const linkState =
        activeMode === mode
          ? "connected"
          : connecting && pendingMode === mode
            ? "connecting"
            : null;
      if (linkState) {
        el.dataset.linkState = linkState;
        el.setAttribute("aria-current", "true");
      } else {
        delete el.dataset.linkState;
        el.removeAttribute("aria-current");
      }
    }
    if (els.disconnect) {
      /* A connect in progress can be stopped from the same place a live link
       * is: a BLE connect can stay pending for ever on Windows (DEV-845), and
       * the only other way out was to reload the page. Not while the link is
       * locked: the lock's owner is the one connecting. */
      const canCancel = connecting && !lockReason;
      els.disconnect.textContent = canCancel ? "Cancel" : "Disconnect";
      els.disconnect.disabled = canCancel ? false : !on || !!lockReason;
      els.disconnect.title =
        lockReason ?? (canCancel ? "Stop this connection attempt" : "");
    }
    if (els.pill) {
      let state = "disconnected";
      let text = "disconnected";
      if (on) {
        state = "connected";
        const label = shownLabel ?? session?.label;
        text = label ? `connected via ${label}` : "connected";
      } else if (reconnectLabel) {
        state = "reconnecting";
        text = `reconnecting via ${reconnectLabel}…`;
      } else if (connecting) {
        state = "connecting";
        text = `connecting via ${MODE_LABELS[pendingMode] ?? pendingMode}…`;
      }
      els.pill.textContent = text;
      els.pill.dataset.linkState = state;
      els.pill.classList.toggle("on", state === "connected");
      els.pill.classList.toggle(
        "warn",
        state === "connecting" || state === "reconnecting",
      );
    }
  }

  /**
   * Show the link as up or down.
   *
   * @param {boolean} on
   * @param {string} [label] the link named in the pill while connected;
   *   defaults to the session's
   */
  function setConnected(on, label) {
    shownConnected = !!on;
    shownLabel = label;
    render();
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Extra guidance for a failed connect.
   *
   * The Web Serial picker is drawn by the browser and cannot be filtered by
   * device name — the API only filters on USB VID/PID or Bluetooth service
   * class, and a port's name is not even readable via getInfo(). So when the
   * wrong entry is picked, the best we can do is explain the symptom
   * afterwards.
   *
   * @param {"ble"|"rfcomm"|"usb"|string} mode
   * @param {unknown} err
   * @returns {string[]}
   */
  function connectFailureHints(mode, err) {
    if (mode !== "rfcomm") return [];
    const message = String(err?.message ?? err ?? "");
    const hints = [];
    if (/timeout/i.test(message)) {
      /* A Shimmer3R pairs as two separate Bluetooth entries: "…-BT"
       * (classic, speaks this protocol) and "…-BLE" (GATT, does not). The
       * SPP service-class filter should keep the BLE one out of the picker,
       * but if it appears anyway, opening it succeeds and then nothing ever
       * answers — which looks exactly like this. */
      hints.push(
        'the port opened but the sensor never answered — if you picked a "…-BLE" entry, choose the "…-BT" one instead (or use Connect BLE)',
      );
    }
    hints.push(
      "also check the sensor is paired with this host, powered, in range, and not held open by another app (e.g. Consensys)",
    );
    return hints;
  }

  /**
   * What the picker really gave us.
   *
   * getInfo() reports the RFCOMM service class the port was matched on, which
   * is the one fact that tells you why a paired sensor did or did not appear:
   * if this is not 00001101-0000-1000-8000-00805f9b34fb then the sensor
   * exposes a non-standard service class, and SHIMMER3_SPP_SERIAL_OPTIONS is
   * filtering on the wrong UUID. Cheap to log every time and useless to guess
   * at afterwards.
   *
   * @param {unknown} transport a WebSerialTransport (anything else is a no-op)
   */
  function logPortIdentity(transport) {
    const port = transport?.port;
    if (!port?.getInfo) return;
    try {
      const info = port.getInfo();
      log(`port: ${JSON.stringify(info)}`);
      if (info.bluetoothServiceClassId) {
        const spp = sdkNs.SHIMMER3_SPP_UUID;
        const isSpp =
          !spp ||
          String(info.bluetoothServiceClassId).toLowerCase() ===
            String(spp).toLowerCase();
        const line =
          `service class ${info.bluetoothServiceClassId}` +
          (isSpp ? " (standard SPP)" : " — NOT standard SPP");
        if (isSpp) log(line);
        else error(line);
      } else {
        error(
          "port reports no Bluetooth service class — not an RFCOMM port (a wired serial port may have been picked)",
        );
      }
    } catch (e) {
      error(`port.getInfo() failed: ${e?.message ?? e}`);
    }
  }

  // -------------------------------------------------------------------------
  // Disconnect detection
  // -------------------------------------------------------------------------

  /**
   * Report a link that went away on its own (not a user disconnect).
   * Idempotent: one drop can reach us through both the SDK hook and the
   * status string, and it should tear the session down once.
   */
  function handleDropped(reason) {
    if (disconnectReported) return;
    disconnectReported = true;
    const why = reason?.message ?? reason ?? "link lost";
    error(`disconnected: ${why}`);
    teardown();
    cfg.onDisconnected?.(reason);
  }

  function teardown() {
    try {
      detachDisconnect?.();
    } catch {
      /* nothing to detach */
    }
    detachDisconnect = null;
    session = null;
    setConnected(false);
  }

  /**
   * Wire status and disconnect callbacks on a freshly built client.
   *
   * Two paths, because the SDK grew the client-level hook after these pages
   * were written:
   *  - `client.onDisconnect` where it exists (added in SDK 0.1.22) — either a
   *    settable callback property or a subscribe method returning an
   *    unsubscribe, so both shapes are accepted;
   *  - otherwise watch `onStatus` for the exact SDK_DISCONNECT_STATUS string.
   *
   * Either way the page's own `onStatus` — which a factory may have assigned
   * before returning the client — is wrapped, not replaced, so it still
   * fires.
   */
  function wireClient(client) {
    const pageStatus =
      typeof client.onStatus === "function" ? client.onStatus : null;

    let hasHook = false;
    /* Two shapes to tell apart, and `typeof === "function"` does not tell them
       apart: a callback slot that someone has already filled looks exactly
       like a subscribe method. Own-property is the honest test -- the SDK
       clients declare `onDisconnect` as an instance field (null until set),
       while a subscribe API would live on the prototype. Getting it backwards
       calls the existing handler with a callback as its `reason` and wires
       nothing, so a dropped link would go unnoticed. */
    const ownCallbackSlot = Object.prototype.hasOwnProperty.call(
      client,
      "onDisconnect",
    );
    if (!ownCallbackSlot && typeof client.onDisconnect === "function") {
      // Subscribe-method shape: onDisconnect(cb) -> unsubscribe.
      try {
        const off = client.onDisconnect((reason) => handleDropped(reason));
        detachDisconnect = typeof off === "function" ? off : null;
        hasHook = true;
      } catch {
        hasHook = false;
      }
    } else if ("onDisconnect" in client) {
      /* Callback-property shape, like onStatus. Anything already in the slot
         is kept and called first: it belongs to whoever built the client, and
         swallowing it would be a silent regression for them. */
      const existing =
        typeof client.onDisconnect === "function" ? client.onDisconnect : null;
      client.onDisconnect = (reason) => {
        if (existing) {
          try {
            existing.call(client, reason);
          } catch {
            /* their handler, their problem -- but not at the cost of ours */
          }
        }
        handleDropped(reason);
      };
      detachDisconnect = () => {
        client.onDisconnect = existing;
      };
      hasHook = true;
    }

    client.onStatus = (msg) => {
      if (
        String(msg) === SDK_DISCONNECT_STATUS ||
        cfg.echoStatus?.(String(msg)) !== false
      ) {
        log(msg);
      }
      pageStatus?.call(client, msg);
      if (!hasHook && String(msg) === SDK_DISCONNECT_STATUS) {
        handleDropped(new Error(SDK_DISCONNECT_STATUS));
      }
    };
  }

  // -------------------------------------------------------------------------
  // Connect / disconnect
  // -------------------------------------------------------------------------

  /**
   * Connect over `mode`, then hand the session to `afterConnect`.
   *
   * @param {"ble"|"rfcomm"|"usb"} mode
   * @returns {Promise<boolean>} true when a session is live
   */
  async function connectVia(mode) {
    if (session) {
      warn("already connected — disconnect first");
      return false;
    }
    if (connecting) {
      warn("a connect is already in progress — wait for it, or Cancel it");
      return false;
    }
    const factory = makeClients[mode === "rfcomm" ? "bt" : mode];
    if (!factory) {
      error(`no client factory for ${MODE_LABELS[mode] ?? mode}`);
      return false;
    }
    const linkName = MODE_LABELS[mode] ?? mode;

    /* Declared OUTSIDE the try so the catch can still reach it. If connect()
     * rejects after the port opened, WebSerialTransport leaves the COM port
     * open, and a port nothing references can never be closed — the next
     * attempt then fails with "port already open" until the page is
     * reloaded. */
    let client = null;
    let transport = null;
    connecting = true;
    pendingMode = mode;
    /* Cancel rejects this, so the page is released at once even when the
     * link underneath never answers the disconnect that Cancel also sends. */
    const cancelled = new Promise((_, reject) => {
      rejectPending = reject;
    });
    cancelled.catch(() => {});
    setConnected(false);
    try {
      const built = factory();
      // A factory may hand back the transport it built (the classic-BT path
      // needs it for logPortIdentity), or just the client.
      if (built && typeof built === "object" && "client" in built) {
        client = built.client;
        transport = built.transport ?? null;
      } else {
        client = built;
      }
      if (!client) throw new Error("client factory returned nothing");
      pending = { client, transport };

      disconnectReported = false;
      wireClient(client);
      log(`connecting over ${linkName}…`);
      const linkUp = client.connect();
      /* A connect overtaken by Cancel can still finish later; its link is
       * then nobody's, so it is closed rather than left open. */
      linkUp.then(
        () => {
          if (pending?.client !== client && session?.client !== client) {
            client.disconnect?.()?.catch?.(() => {});
          }
        },
        () => {},
      );
      await Promise.race([linkUp, cancelled]);

      connecting = false;
      pendingMode = null;
      pending = null;
      rejectPending = null;
      session = { client, mode, transport, label: linkName };
      setConnected(true, linkName);
      if (!reconnectLabel) cfg.onConnected?.(linkName);

      if (mode === "rfcomm" && transport) logPortIdentity(transport);

      /* Before anything else can fail: identifying what we connected to is
       * worth more than the rest of the session when a link misbehaves.
       * Diagnostic only, so a failure inside the hook is logged and never
       * allowed to tear down the connection it is reporting on. */
      try {
        await cfg.afterConnect?.(session);
      } catch (hookErr) {
        error(
          `post-connect diagnostics failed: ${hookErr?.message ?? hookErr}`,
        );
      }
      return true;
    } catch (e) {
      pending = null;
      rejectPending = null;
      /* Release the link before dropping the reference (see the comment on
       * `client` above). Set first, so the SDK's own disconnect status from
       * this cleanup is not taken for a dropped link. */
      disconnectReported = true;
      try {
        await client?.disconnect();
      } catch {
        /* already down */
      }
      if (String(e?.message ?? e) === CANCELLED) {
        warn(`connect over ${linkName} cancelled`);
      } else {
        error(`Connect failed over ${linkName}: ${e?.message ?? e}`);
        for (const hint of connectFailureHints(mode, e)) warn(hint);
      }
      connecting = false;
      pendingMode = null;
      teardown();
      return false;
    }
  }

  /**
   * Stop the connect in progress. The page wires Disconnect to this while
   * `connecting` is true, which is when that button reads "Cancel".
   *
   * The connect is rejected at once, so the page never waits on a link that
   * does not answer, and the link is released as well: a BLE connect stuck
   * pending only ends with `gatt.disconnect()` (DEV-845), which the
   * transport's own disconnect skips while the GATT server is not yet
   * connected.
   *
   * @returns {Promise<boolean>} false when no connect was in progress
   */
  async function cancelConnect() {
    if (!connecting || !rejectPending) return false;
    const { client, transport } = pending ?? {};
    /* The link this releases is going because the user asked: its drop must
     * not reach the page as one it should report, or reconnect. */
    disconnectReported = true;
    rejectPending(new Error(CANCELLED));
    rejectPending = null;
    try {
      const device = transport?.device ?? client?.device;
      device?.gatt?.disconnect?.();
    } catch {
      /* nothing to release */
    }
    return true;
  }

  /**
   * Close the live session. A user-initiated disconnect, so it does NOT call
   * `onDisconnected` — the page asked for this and already knows.
   */
  async function disconnect() {
    const live = session;
    // Set before awaiting: the SDK emits its disconnect status from inside
    // this call, and that must not be reported as a dropped link.
    disconnectReported = true;
    if (!live) {
      setConnected(false);
      return;
    }
    try {
      await live.client?.disconnect();
    } catch (e) {
      warn(`disconnect reported an error: ${e?.message ?? e}`);
    } finally {
      teardown();
      log("disconnected");
    }
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  setConnected(false);

  if (cfg.announceStartup !== false) {
    /* Log which SDK build this page actually runs — a stale vendored bundle
     * is otherwise indistinguishable from a firmware fault. Read off the
     * namespace object so an older bundle (no SDK_VERSION export) degrades
     * to a warning instead of breaking the import. */
    if (sdkNs.SDK_VERSION) {
      log(`vendored shimmer-web-sdk v${sdkNs.SDK_VERSION}`);
    } else {
      warn(
        `WARNING: vendored shimmer-web-sdk predates v${MIN_USEFUL_SDK} — BLE record reads will truncate; re-vendor the SDK bundle`,
      );
    }

    /* Capability and guidance both come from the SDK, so every consumer says
     * the same accurate thing about each link: it owns the awkward facts
     * (Android serves Web Serial for RFCOMM only; iOS cannot reach classic
     * Bluetooth at any layer) and returns null when a link simply works.
     *
     * The dock deliberately gets the middle "unlikely" state as advice rather
     * than a disable: on Android `serial` in navigator is true while wired
     * ports are still rolling out, and no feature detection separates the
     * two, so a hard disable would lock out the phones where it does land. */
    const offered = [
      els.ble && "ble",
      els.bt && "rfcomm",
      els.usb && "usb",
    ].filter(Boolean);
    let firstAdvice = null;
    for (const mode of offered) {
      const advice = sdkNs.transportAdvice?.(support, MODE_NEEDS[mode]);
      if (!advice) continue;
      const blocked =
        mode === "ble" ? !support.webBluetooth : !support.webSerial;
      if (blocked) error(`note: ${advice}`);
      else warn(`note: ${advice}`);
      if (blocked && !firstAdvice) firstAdvice = advice;
    }
    // A banner only for a link that cannot work at all — advice about a
    // merely unlikely link belongs in the log, not above the page.
    if (firstAdvice && els.banner) {
      els.banner.className = "banner err";
      els.banner.textContent = firstAdvice;
    }
  }

  return {
    connectVia,
    cancelConnect,
    disconnect,
    get session() {
      return session;
    },
    /** True while a connect is in progress, which is when Disconnect reads "Cancel". */
    get connecting() {
      return connecting;
    },
    setConnected,
    /**
     * Say an automatic reconnect is under way over the link `label` names,
     * or, with `null`, that it has ended. While set, a link that is down reads
     * "reconnecting via …" rather than "disconnected", and a connect it makes
     * does not call `onConnected`.
     */
    setReconnecting(label) {
      reconnectLabel = label || null;
      render();
    },
    /**
     * Hold every connect button and Disconnect while `reason` is set (shown
     * as their tooltip); `null` releases them to the connected state.
     */
    setLocked(reason) {
      lockReason = reason || null;
      render();
    },
    support,
    connectFailureHints,
    logPortIdentity,
  };
}
