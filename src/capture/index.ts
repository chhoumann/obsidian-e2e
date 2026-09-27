/**
 * `obsidian-e2e/capture`: small, composable screenshot/recording primitives for
 * a live Obsidian window over CDP. Not a scenario framework - drive the UI with
 * whatever you like between calls; `client.call()`/`evaluate()` are the escape
 * hatches for anything not covered here.
 */
export { CdpClient } from "../runner/android/cdp";
export {
  DEFAULT_CAPTURE_SCALE,
  DEFAULT_CDP_PORT,
  DEFAULT_XVFB_SCREEN,
  captureLaunchCommand,
  captureShellExports,
  prepareCaptureProfile,
  resolveCaptureProfile,
  runCaptureInstance,
} from "./launch";
export type { CaptureLaunchCommand, CaptureLaunchOptions, CaptureProfile } from "./launch";
export {
  LINUX_SECRET_WARNING_CSS,
  captureScreenshot,
  connectCapture,
  evaluate,
  injectCss,
  pngSize,
  prepareCapture,
  typeText,
} from "./page";
export type {
  ConnectOptions,
  ImageInfo,
  PrepareOptions,
  PreparedState,
  ScreenshotOptions,
  ScreenshotTarget,
  TypeOptions,
} from "./page";
export { buildConcatList, startRecording, withRecording } from "./record";
export type { RecordOptions, Recording, RecordingResult } from "./record";
export { contactSheet, probeMedia, videoToGif } from "./media";
export type { ContactSheetOptions, GifOptions, MediaInfo } from "./media";
export { runCaptureCli } from "./cli";
