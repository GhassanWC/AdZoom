/**
 * InteractionProvider — abstraction over the source of real input events.
 *
 * The recording engine consumes events through this interface and never knows
 * whether they came from the browser tab (today) or an OS-wide hook (future
 * Electron build). Adding the Electron provider is a drop-in: implement this
 * interface, swap the factory call in the engine. No other code changes.
 *
 * Per the redesign brief, this abstraction is invariant 5 of the hybrid
 * pipeline — see C:\Users\gassa\.claude\plans\the-current-ai-video-vivid-catmull.md.
 */

import type { Interaction } from "./types";

export interface InteractionProviderCapabilities {
  /** True if the provider streams continuous mouse path samples. */
  mousePath: boolean;
  /** True if individual key events (typing bursts) are observable. */
  keyEvents: boolean;
  /** True if focus changes are observable. */
  focusEvents: boolean;
  /** True for OS-level providers that see input outside the Framevo tab. */
  crossWindow: boolean;
}

export interface InteractionProvider {
  /** "tab" for the browser provider, "system" for the future Electron one. */
  readonly scope: "tab" | "system";
  /** Static description of what this provider can observe. */
  readonly capabilities: InteractionProviderCapabilities;
  /**
   * Begin capturing. `startedAt` is the wall-clock origin (performance.now())
   * the provider should subtract from every event timestamp so the resulting
   * `Interaction.t` is seconds-since-record-start.
   */
  start(startedAt: number): void;
  /** Non-destructive snapshot of events captured so far. Safe to call during recording. */
  events(): Interaction[];
  /** Pause without discarding; resume() picks up where it left off. */
  pause(): void;
  resume(): void;
  /** Stop and return the final event list. The provider is unusable after. */
  stop(): Promise<Interaction[]>;
}
