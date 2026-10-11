/**
 * Bluetooth module update: offer the one IF820 firmware this site carries to
 * a Shimmer3R whose module is older, and run it over BLE (DEV-1164).
 *
 * Deliberately narrow. The site holds exactly one image, described by
 * `firmware/if820/manifest.json`; there is no version picker and no file
 * picker, so a customer can only ever move a module forward to the release
 * we chose. Bench work with other images (downgrades, Infineon test builds)
 * stays on WsOtaUpgrade.
 *
 * How the update reaches the module: the Shimmer3R's MCU cannot reflash it,
 * so the page talks to the module's own OTA service over the BLE connection
 * the sensor is already on (`Shimmer3RClient.updateBtModuleFirmware`). That
 * service is only reachable over BLE, so on a Classic Bluetooth or USB link
 * the panel offers to reconnect over BLE instead — one device-picker click.
 *
 * What happens at the end: once the module has verified the image it resets
 * onto it, and the link drops. Shimmer3R firmware with DEV-1164 then reboots
 * its MCU once the module is back, which re-reads the module version (it is
 * only read at boot); the panel reconnects to the same BluetoothDevice without
 * a picker, and the page's normal post-connect read confirms the new version.
 * Older firmware needs a power-cycle first, which the panel says when the
 * sensor does not come back or still reports the old version. Nothing arms
 * reboot-on-disconnect: rebooting the MCU on the post-VERIFY drop cuts the
 * module's power mid image switch and leaves it on the old image.
 *
 * An update that is interrupted before the module verifies the image leaves
 * the old firmware running, so a failure is never a dead sensor; the prompt
 * simply comes back on the next connect.
 *
 * Nothing here touches `document` at import time.
 *
 *   import { createBtModuleUpdate } from "./common/bt-module-update.js";
 */

import { el } from "./ui-chrome.js";
/* The whole namespace, so a vendored bundle that predates the OTA exports
   degrades to a panel that never offers anything, instead of an import error
   that takes the page down. */
import * as sdk from "../vendor/shimmer-web-sdk.esm.js";

/** Where the one bundled image is described. Relative to the page. */
export const BT_MODULE_MANIFEST_URL = "firmware/if820/manifest.json";

/** After VERIFY the module resets on its own; give it this long to drop the
 * link before the page drops it itself. */
const DROP_WAIT_MS = 15000;
/** Then let the module switch images and the MCU reboot and set it up again
 * before the first reconnect. Chrome bench run, 2026-10-11: the MCU rebooted
 * ~5 s after the drop and finished setting up the module ~18 s after it; a
 * reconnect at 8 s reached the module mid-setup and was dropped. */
const BOOT_WAIT_MS = 20000;
/**
 * How long to keep reconnecting until the sensor reports the new version.
 * On the bench (Chrome, 2026-10-11) the module was back and advertising before
 * the MCU had rebooted onto it, so the first reconnect reached a sensor whose
 * MCU could not answer yet, and the MCU's reboot then dropped that link: one
 * successful connect is not the end of it. Firmware without DEV-1164 never
 * reboots by itself, and then this runs out and the panel asks for a
 * power-cycle.
 */
const RECONNECT_BUDGET_MS = 90000;
const RECONNECT_GAP_MS = 4000;
/** The progress bar's split: the transfer takes this much, the restart the
 * rest, paced against the restart's usual length on the bench (~30-45 s). */
const TRANSFER_SHARE = 75;
const EXPECTED_RESTART_MS = 45000;
/** After a reconnect, how long the page's identity read may take to land. */
const VERSION_WAIT_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asGetter(value, fallback = null) {
  if (typeof value === "function") return value;
  return () => value ?? fallback;
}

/**
 * Load and sanity-check the manifest. Resolves null when the site carries no
 * image (404) so a deployment without one simply never prompts.
 *
 * @param {string} url
 * @returns {Promise<{version: string, file: string, bytes: number, crc32: number, url: string}|null>}
 */
export async function loadBtModuleManifest(url = BT_MODULE_MANIFEST_URL) {
  const res = await fetch(url, { cache: "no-cache" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`manifest ${url}: HTTP ${res.status}`);
  const m = await res.json();
  const crc =
    typeof m.crc32 === "string" ? Number.parseInt(m.crc32, 16) : m.crc32;
  if (
    typeof m.version !== "string" ||
    !/^\d+(\.\d+){3}$/.test(m.version) ||
    typeof m.file !== "string" ||
    !Number.isInteger(m.bytes) ||
    !Number.isInteger(crc)
  ) {
    throw new Error(`manifest ${url} is missing version, file, bytes or crc32`);
  }
  return {
    ...m,
    crc32: crc >>> 0,
    url: new URL(m.file, new URL(url, location.href)).href,
  };
}

/**
 * Mount the panel inside `host`. It stays empty (and so invisible) until
 * {@link check} finds an older IF820.
 *
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {() => object|null} opts.client getter for the connected client
 * @param {() => string|null} opts.mode getter: `"ble"`, `"rfcomm"` or `"usb"`
 * @param {{log: Function, warn: Function, error: Function}} opts.log
 * @param {(message: string, kind?: string) => void} [opts.toast]
 * @param {() => string|null} opts.linkHeldReason the page's reason the link
 *   cannot be given to an update right now (streaming, another panel busy),
 *   or null
 * @param {(busy: boolean) => void} opts.onBusyChange raises the page's busy
 *   flag for the whole update, reconnect included
 * @param {() => Promise<boolean>} opts.switchToBle disconnect the current
 *   (non-BLE) link and connect over BLE with the device picker
 * @param {(device: BluetoothDevice|null) => Promise<boolean>} opts.reconnectBle
 *   connect over BLE to `device` without a picker (null on the mock link,
 *   which has no BluetoothDevice and reconnects its own way)
 * @param {() => Promise<void>} opts.disconnect close the live link
 * @param {string} [opts.manifestUrl]
 */
export function createBtModuleUpdate(host, opts) {
  const getClient = asGetter(opts.client);
  const getMode = asGetter(opts.mode);
  const log = opts.log ?? console;
  const toast = opts.toast ?? (() => {});
  const manifestUrl = opts.manifestUrl ?? BT_MODULE_MANIFEST_URL;
  const supported =
    typeof sdk.isIf820UpdateAvailable === "function" &&
    typeof sdk.crc32 === "function";

  /** @type {Awaited<ReturnType<typeof loadBtModuleManifest>>|undefined} */
  let manifest;
  let manifestError = null;
  /** The image, fetched once and CRC-checked against the manifest. */
  let imageCache = null;
  /**
   * idle | available | updating | restarting | done | failed
   * `restarting` survives the disconnect the update itself causes.
   */
  let phase = "idle";
  let current = null;
  let enabled = true;
  let busy = false;
  let abort = null;
  let progress = { currentBytes: 0, totalBytes: 0 };
  /** When the module's restart began, for the second half of the bar. */
  let restartStartedAt = 0;
  let restartTicker = null;
  let statusText = "";
  let failure = "";
  /** The BluetoothDevice the update ran on, for the picker-less reconnect. */
  let device = null;
  /** The whole image is sent, so a drop from here on is most likely the
   * module restarting on it rather than a failure. */
  let transferDone = false;
  /**
   * No chunk has landed yet in the current attempt. The SDK starts at large
   * writes, and on a link that stalls on them it drops and re-opens the link
   * itself before carrying on smaller - a disconnect that is part of the
   * update, not the end of it.
   */
  let linkMayDrop = false;
  /**
   * Link drops seen during the update, and how many of them the SDK caused by
   * re-opening a stalled link. The module's own restart after VERIFY is the
   * drop beyond those.
   */
  let drops = 0;
  let retryDrops = 0;
  let dropWaiters = [];
  /** Stop listening for drops on the update's BluetoothDevice. */
  let unlistenDevice = null;
  /** The module version the sensor last reported while restarting. */
  let lastSeenVersion = null;

  function noteDrop() {
    drops++;
    const ready = dropWaiters.filter((w) => drops > w.after);
    dropWaiters = dropWaiters.filter((w) => drops <= w.after);
    for (const w of ready) w.resolve();
  }

  /** Resolves on the drop that follows every one the SDK caused itself. */
  function moduleRestartDrop() {
    return new Promise((resolve) => {
      if (drops > retryDrops) resolve();
      else dropWaiters.push({ after: retryDrops, resolve });
    });
  }

  function setBusy(on) {
    if (busy === on) return;
    busy = on;
    opts.onBusyChange?.(on);
  }

  async function ensureManifest() {
    if (manifest !== undefined) return manifest;
    try {
      manifest = await loadBtModuleManifest(manifestUrl);
    } catch (e) {
      manifest = null;
      manifestError = e?.message ?? String(e);
      log.warn?.(`Bluetooth module update unavailable: ${manifestError}`);
    }
    return manifest;
  }

  async function loadImage() {
    if (imageCache) return imageCache;
    const res = await fetch(manifest.url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`firmware image: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const crc = sdk.crc32(bytes) >>> 0;
    if (bytes.length !== manifest.bytes || crc !== manifest.crc32) {
      throw new Error(
        `firmware image does not match its manifest (${bytes.length} bytes, ` +
          `crc32 0x${crc.toString(16).padStart(8, "0")}) — not sent`,
      );
    }
    imageCache = bytes;
    return bytes;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * One bar for the whole job, so the restart and reconnect that follow the
   * transfer are visibly progress too, not a full bar that seems stuck:
   * the transfer fills the first {@link TRANSFER_SHARE} percent, the restart
   * the rest, by elapsed time against {@link EXPECTED_RESTART_MS} - easing
   * towards 99 % rather than stopping if it runs long. 100 % only once the
   * new version is confirmed.
   */
  function overallPercent() {
    if (phase === "done") return 100;
    if (phase === "restarting") {
      const t = (Date.now() - restartStartedAt) / EXPECTED_RESTART_MS;
      const eased = t <= 1 ? 0.85 * t : 0.85 + 0.14 * (1 - Math.exp(-(t - 1)));
      return Math.min(
        99,
        Math.floor(TRANSFER_SHARE + (100 - TRANSFER_SHARE) * eased),
      );
    }
    if (!progress.totalBytes) return 0;
    return Math.floor(
      (TRANSFER_SHARE * progress.currentBytes) / progress.totalBytes,
    );
  }

  /** The × on a finished update's banner. Dismissing only clears the
   * message: a module still on an older version is offered the update again
   * the next time the sensor connects. */
  function dismissButton() {
    return el(
      "button",
      {
        type: "button",
        class: "bt-update-dismiss",
        title: "Dismiss",
        "aria-label": "Dismiss",
        onclick: () => {
          phase = "idle";
          failure = "";
          render();
        },
      },
      "×",
    );
  }

  function render() {
    host.replaceChildren();
    if (phase === "idle") return;
    const target = manifest?.version;
    const from = current?.version;

    if (phase === "available") {
      const onBle = getMode() === "ble";
      const held = opts.linkHeldReason?.() ?? null;
      const button = onBle
        ? el(
            "button",
            {
              type: "button",
              class: "primary",
              disabled: !enabled || !!held || null,
              title: held ?? null,
              onclick: () => void runUpdate(),
            },
            "Update Bluetooth firmware",
          )
        : el(
            "button",
            {
              type: "button",
              disabled: !enabled || !!held || null,
              title: held ?? null,
              onclick: () => void switchLink(),
            },
            "Reconnect over BLE to update",
          );
      host.append(
        el(
          "div",
          { class: "banner info bt-update" },
          el(
            "div",
            {},
            el("strong", {}, "A Bluetooth firmware update is available"),
            ` — v${target} (this sensor has v${from}).`,
          ),
          el(
            "div",
            { class: "muted" },
            onBle
              ? "Usually 10–40 seconds. Keep the sensor close and charged; it restarts at the end and this page reconnects to it."
              : "The Bluetooth module can only be updated over BLE. Reconnecting opens the device picker once.",
          ),
          held ? el("div", { class: "muted" }, held) : null,
          el("div", { class: "row" }, button),
        ),
      );
      return;
    }

    if (phase === "updating" || phase === "restarting") {
      const pct = overallPercent();
      host.append(
        el(
          "div",
          { class: "banner warn bt-update" },
          el(
            "div",
            {},
            el("strong", {}, "Updating the Bluetooth module"),
            ` to v${target} — do not close this page or switch the sensor off.`,
          ),
          el("progress", {
            class: "sd-progress",
            max: "100",
            value: String(pct),
          }),
          el("div", { class: "muted", id: "btUpdateStatus" }, statusText),
          phase === "updating"
            ? el(
                "div",
                { class: "row" },
                el(
                  "button",
                  { type: "button", onclick: () => abort?.abort() },
                  "Cancel",
                ),
              )
            : null,
        ),
      );
      return;
    }

    if (phase === "done") {
      host.append(
        el(
          "div",
          { class: "banner ok bt-update" },
          `Bluetooth module updated to v${current?.version ?? target}.`,
          dismissButton(),
        ),
      );
      return;
    }

    if (phase === "failed") {
      host.append(
        el(
          "div",
          { class: "banner err bt-update" },
          el(
            "div",
            {},
            el("strong", {}, "Bluetooth module update failed: "),
            failure,
          ),
          el(
            "div",
            { class: "muted" },
            "The module keeps its previous firmware until an update completes, so the sensor still works. Reconnect over BLE to try again.",
          ),
          dismissButton(),
        ),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function switchLink() {
    log.log?.("Bluetooth module update: reconnecting over BLE");
    await opts.switchToBle();
  }

  async function runUpdate() {
    const client = getClient();
    if (!client || phase !== "available" || busy) return;
    if (getMode() !== "ble") return;
    const held = opts.linkHeldReason?.();
    if (held) {
      toast(held, "warn");
      return;
    }
    if (typeof client.updateBtModuleFirmware !== "function") {
      toast("This SDK bundle cannot update the Bluetooth module", "err");
      return;
    }

    phase = "updating";
    progress = { currentBytes: 0, totalBytes: manifest.bytes };
    statusText = "Downloading the firmware image…";
    failure = "";
    transferDone = false;
    linkMayDrop = true;
    lastSeenVersion = null;
    drops = 0;
    retryDrops = 0;
    dropWaiters = [];
    device = client.device ?? null;
    /* Watched on the device itself: once the page has torn its session down
       after the first drop, it hears no later ones, and the module's restart
       is exactly the drop this has to see. The mock link has no device, and
       is counted through onDisconnected instead. */
    if (typeof device?.addEventListener === "function") {
      const onGattDrop = () => noteDrop();
      device.addEventListener("gattserverdisconnected", onGattDrop);
      unlistenDevice = () =>
        device?.removeEventListener("gattserverdisconnected", onGattDrop);
    }
    abort = new AbortController();
    setBusy(true);
    render();

    const started = performance.now();
    try {
      const image = await loadImage();
      log.log?.(
        `Bluetooth module update: v${current?.version} → v${manifest.version} ` +
          `(${manifest.file}, ${image.length} bytes)`,
      );
      const result = await client.updateBtModuleFirmware(image, {
        signal: abort.signal,
        onStatus: (m) => {
          statusText = m;
          log.log?.(`Bluetooth module update: ${m}`);
          render();
        },
        onLog: (m) => log.log?.(`[if820 ota] ${m}`),
        onRetry: ({ fromChunkSize, toChunkSize, reconnecting }) => {
          log.warn?.(
            `Bluetooth module update: ${fromChunkSize}-byte writes ` +
              `${reconnecting ? "stalled the link" : "were refused"}; ` +
              `continuing with ${toChunkSize}-byte writes` +
              (reconnecting ? " after reconnecting" : ""),
          );
          linkMayDrop = true;
          /* The SDK drops and re-opens the link on the device itself, which
             the device listener counts as a drop. The mock re-opens a
             scripted device the page never sees, so there is nothing to
             discount there. */
          if (reconnecting && unlistenDevice) retryDrops++;
        },
        onProgress: (p) => {
          progress = p;
          if (p.currentBytes > 0) linkMayDrop = false;
          transferDone = p.totalBytes > 0 && p.currentBytes >= p.totalBytes;
          const bar = host.querySelector("progress");
          if (bar) bar.value = overallPercent();
        },
      });
      log.log?.(
        `Bluetooth module accepted the image in ` +
          `${((performance.now() - started) / 1000).toFixed(1)} s ` +
          `(${result.chunkSize}-byte chunks, crc32 0x${result.crc32.toString(16)})`,
      );
    } catch (e) {
      abort = null;
      unlistenDevice?.();
      unlistenDevice = null;
      device = null;
      const cancelled = e?.name === "AbortError";
      failure = cancelled ? "cancelled" : (e?.message ?? String(e));
      log[cancelled ? "warn" : "error"]?.(
        `Bluetooth module update ${cancelled ? "cancelled" : "failed"}: ${failure}`,
      );
      phase = cancelled ? "available" : "failed";
      setBusy(false);
      render();
      return;
    }

    abort = null;
    phase = "restarting";
    restartStartedAt = Date.now();
    restartTicker = setInterval(() => {
      const bar = host.querySelector("progress");
      if (bar && phase === "restarting") bar.value = overallPercent();
    }, 500);
    statusText = "The module is restarting on the new firmware…";
    render();
    await restartAndReconnect();
  }

  async function restartAndReconnect() {
    /* The module resets itself after VERIFY, which drops the link. If it is
       somehow still up after a generous wait, drop it from this side so the
       reconnect below starts from a clean link. */
    const timedOut = await Promise.race([
      moduleRestartDrop().then(() => false),
      sleep(DROP_WAIT_MS).then(() => true),
    ]);
    unlistenDevice?.();
    unlistenDevice = null;
    if (timedOut && getClient()) {
      log.warn?.(
        "the module did not drop the link after the update; disconnecting",
      );
      await opts.disconnect();
    }
    await sleep(BOOT_WAIT_MS);

    const deadline = Date.now() + RECONNECT_BUDGET_MS;
    for (let i = 1; phase === "restarting" && Date.now() < deadline; i++) {
      statusText = `Reconnecting to the sensor (attempt ${i})…`;
      render();
      /* The page's afterConnect runs inside this and calls check(), which
         moves the phase on to done once the new version is reported. `device`
         is the sensor the update ran on; the page reconnects to it without
         the picker. */
      if (await opts.reconnectBle(device)) {
        /* check() is not awaited by the page, so give it time to land. */
        for (
          let w = 0;
          w < VERSION_WAIT_MS / 100 && phase === "restarting";
          w++
        ) {
          await sleep(100);
        }
        if (phase !== "restarting") break;
        /* Connected, but the new version was not read: the MCU had not
           rebooted onto the module yet (it may not answer at all, or still
           report the old version), or the link dropped mid-read. Let go and
           ask again shortly. */
        if (getClient()) await opts.disconnect();
        statusText = lastSeenVersion
          ? `The sensor still reports v${lastSeenVersion}; waiting for it to restart…`
          : "Waiting for the sensor to finish restarting…";
        render();
      }
      await sleep(RECONNECT_GAP_MS);
    }
    if (phase === "restarting") {
      failure = lastSeenVersion
        ? `the module accepted the update, but the sensor still reports v${lastSeenVersion}. ` +
          "Switch it off and on: it reads the module version only when it starts. " +
          "If it still reports the old version after that, run the update again."
        : "the sensor did not come back after the update. Switch it off and on, then reconnect over BLE — the new version shows once it has restarted.";
      phase = "failed";
      render();
    }
    clearInterval(restartTicker);
    restartTicker = null;
    device = null;
    setBusy(false);
  }

  // -------------------------------------------------------------------------
  // Page hooks
  // -------------------------------------------------------------------------

  /**
   * Decide what to show for a freshly read module version. Called from the
   * page's post-connect identity read, including the reconnect after an
   * update, which is how a finished update is confirmed.
   *
   * @param {object|null} btModule `readBtModuleVersion()`'s result
   */
  async function check(btModule) {
    current = btModule ?? null;
    if (!supported) return;
    const m = await ensureManifest();

    if (phase === "restarting") {
      /* Only the new version ends the wait. An old one, or none, is a sensor
         that has not rebooted onto the module yet; restartAndReconnect keeps
         asking until its budget runs out. */
      if (m && current?.family === "cyw20820" && current.version) {
        if (sdk.compareIf820Versions(current.version, m.version) >= 0) {
          phase = "done";
          /* Hand the link back now: the page's post-connect reads that follow
             this one (the calibration dump among them) refuse while the
             update holds it. */
          device = null;
          setBusy(false);
          log.log?.(`Bluetooth module now reports v${current.version}`);
          toast(`Bluetooth module updated to v${current.version}`, "ok");
          render();
          return;
        }
        lastSeenVersion = current.version;
        log.log?.(
          `the sensor still reports Bluetooth module v${current.version}; waiting for it to restart`,
        );
      }
      return;
    }

    if (busy) return;
    phase =
      m && sdk.isIf820UpdateAvailable(current, m.version)
        ? "available"
        : "idle";
    if (phase === "available") {
      log.log?.(
        `Bluetooth module firmware v${m.version} is available (sensor has v${current.version})`,
      );
    }
    render();
  }

  /** The link went away. An update's own restart is expected and kept. */
  function onDisconnected() {
    // Counted here only when the device itself is not being watched.
    if (busy && !unlistenDevice) noteDrop();
    if (phase === "restarting") return;
    if (phase === "updating") {
      /* The SDK call rejects on its own when the link drops; this just
         stops a stale "available" from being shown meanwhile. */
      return;
    }
    if (phase !== "failed" && phase !== "done") phase = "idle";
    current = null;
    render();
  }

  return {
    check,
    onDisconnected,
    /** Page-level floor (connected, not streaming, no other panel busy). */
    setEnabled(on) {
      enabled = !!on;
      if (phase === "available") render();
    },
    get busy() {
      return busy;
    },
    get phase() {
      return phase;
    },
    /** True when a link drop now is part of an update: the module restarting
     * on the image it has just been sent, or the SDK re-opening a link that
     * stalled on large writes. */
    get restartExpected() {
      return (
        phase === "restarting" ||
        (phase === "updating" && (transferDone || linkMayDrop))
      );
    },
    get manifestError() {
      return manifestError;
    },
  };
}
