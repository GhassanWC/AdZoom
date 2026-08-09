/**
 * Auto-update.
 *
 * The infrastructure ships in every build; whether it ever CONTACTS anything is
 * decided entirely by `FRAMEVO_UPDATE_FEED_URL` (baked at package time or set
 * in the environment). Unset ⇒ the updater never starts, nothing is fetched,
 * and the app is fully offline-capable — which is the point of a local-first
 * editor.
 *
 * Windows uses Squirrel (the format `@electron-forge/maker-squirrel` produces),
 * macOS uses the same `autoUpdater` against a Squirrel.Mac feed, so one code
 * path covers both once a mac build is added. Updates are NEVER installed
 * mid-session: `autoUpdater` stages them and Squirrel applies them on quit, so
 * an in-flight export can't be interrupted by an update.
 */
import { app, autoUpdater, dialog } from "electron";
import { logger, reportError } from "./logger";

/** Check on launch, then every 6 hours — quiet enough for a desktop editor. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdaterOptions {
  /** Base feed URL. Absent/empty ⇒ auto-update stays completely off. */
  feedUrl?: string;
  version: string;
}

export function initAutoUpdate({ feedUrl, version }: UpdaterOptions): boolean {
  if (!feedUrl) {
    logger.info("auto-update disabled (no FRAMEVO_UPDATE_FEED_URL)");
    return false;
  }
  if (!app.isPackaged) {
    logger.info("auto-update skipped (development build)");
    return false;
  }
  if (process.platform === "linux") {
    // Squirrel has no Linux implementation; distributions handle updates.
    logger.info("auto-update not supported on this platform");
    return false;
  }

  let url: string;
  try {
    const parsed = new URL(feedUrl);
    if (parsed.protocol !== "https:") throw new Error("update feed must be https");
    // Squirrel.Windows takes a directory URL; Squirrel.Mac takes a JSON feed
    // that is conventionally per-platform/version.
    url =
      process.platform === "darwin"
        ? `${parsed.toString().replace(/\/+$/, "")}/darwin/${process.arch}/RELEASES.json?version=${version}`
        : parsed.toString();
  } catch (err) {
    logger.warn("auto-update disabled — invalid feed URL", { error: (err as Error).message });
    return false;
  }

  try {
    autoUpdater.setFeedURL({ url, serverType: process.platform === "darwin" ? "json" : "default" });
  } catch (err) {
    reportError(err, { phase: "updater-config" });
    return false;
  }

  autoUpdater.on("error", (err) => {
    // A failing update check must never interrupt editing — log and move on.
    logger.warn("update check failed", { error: err.message });
  });
  autoUpdater.on("update-available", () => logger.info("update available — downloading"));
  autoUpdater.on("update-not-available", () => logger.debug("no update available"));
  autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
    logger.info("update staged", { releaseName });
    void dialog
      .showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 1,
        cancelId: 1,
        title: "Update ready",
        message: `Framevo ${releaseName ?? ""} is ready to install.`.trim(),
        detail: "The update installs when you restart. Any export in progress will finish first.",
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  const check = () => {
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      logger.warn("update check threw", { error: (err as Error).message });
    }
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS).unref?.();
  logger.info("auto-update enabled");
  return true;
}
