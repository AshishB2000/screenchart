// Shared cross-file globals for the hub renderer. The hub is many classic
// <script> files sharing ONE global scope (no modules) — every symbol defined
// in one hub file and consumed in another is declared here so each file
// type-checks standalone. Vendor globals (Chart.js, Leaflet, pdfmake, pptxgenjs,
// docx) and the preload bridge (window.hub) are typed loosely on purpose.

export {}; // make this a module so `declare global` works

// ── Shared shapes ───────────────────────────────────────────────────────────

/** makeDropdown() options (see customDropdown.js header comment). */
interface DropdownOpts {
  className?: string;
  listClassName?: string;
  ariaLabel?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
}

/** The custom-dropdown widget API returned by makeDropdown(). */
interface DropdownApi {
  el: HTMLElement;
  setOptions(items: Array<{ value: any; label?: any }> | null | undefined, value?: any): DropdownApi;
  getValue(): string;
  open(): void;
  close(): void;
  value: any; // string in practice; setter coerces null/undefined to ''
  disabled: boolean;
  hidden: boolean;
  placeholder: string;
}

declare global {
  // ── Preload bridge (preload/hubPreload.js) ────────────────────────────────
  // Methods mirror the contextBridge surface 1:1. Payloads/results are typed
  // loosely (any) — ponytail: big IPC envelopes, tighten per-method as needed.
  interface Window {
    hub: {
      takeScreenshot(): void;
      getKeyStatus(): Promise<any>;
      saveKey(provider: string, key: string): Promise<any>;
      saveLocalEndpoint(endpoint: string): Promise<any>;
      clearKey(provider: string): Promise<any>;
      validateKey(provider: string, key: string, endpoint?: string): Promise<any>;
      getModels(provider: string): Promise<any>;
      saveModel(provider: string, model: string): Promise<any>;
      activateProvider(provider: string): Promise<any>;
      setExecutionMode(mode: string): Promise<any>;
      setMemoryModel(fields: any): Promise<any>;
      setGlobalRules(text: string): Promise<any>;
      setNotifications(fields: any): Promise<any>;
      bootstrapNotifications(): Promise<any>;
      deleteData(scope: string): Promise<any>;
      saveByokProvider(provider: string, fields: any): Promise<any>;
      activateByokProvider(provider: string): Promise<any>;
      testByokProvider(provider: string): Promise<any>;
      revealByokKey(provider: string): Promise<any>;
      detectLocalClis(): Promise<any>;
      detectOneCli(id: string): Promise<any>;
      setLocalCli(id: string): Promise<any>;
      testLocalCli(id: string): Promise<any>;
      listCliModels(id: string): Promise<any>;
      saveCliModel(id: string, model: string): Promise<any>;
      listModels(target: any, force?: boolean): Promise<any>;
      onKeyChanged(cb: () => void): void;
      onOpenSettings(cb: (cat?: string) => void): void;
      openExternal(url: string): void;
      openSystemSettings(): Promise<any>;
      onShowPermission(cb: () => void): void;
      loadGeo(level: string): Promise<any>;
      getHotkeyLabel(): Promise<any>;
      saveHotkey(accelerator: string): Promise<any>;
      onHotkeyState(cb: (data: any) => void): void;
      openInputMonitoringSettings(): void;
      onNewEntry(cb: (data: any) => void): void;
      onEntryResult(cb: (data: any) => void): void;
      retry(entryId: string): void;
      followup(entryId: string, text: string): void;
      onFollowupResult(cb: (data: any) => void): void;
      onHistory(cb: (data: any) => void): void;
      loadThread(entryId: string): Promise<any>;
      deleteThread(entryId: string): Promise<any>;
      copyText(text: string): void;
      copyImage(dataUrl: string): void;
      saveImage(src: string, defaultName?: string): Promise<any>;
      savePdf(base64: string, defaultName: string): Promise<any>;
      savePptx(base64: string, defaultName: string): Promise<any>;
      saveDocx(base64: string, defaultName: string): Promise<any>;
      captureRegion(rect: { x: number; y: number; width: number; height: number }): Promise<any>;
      captureReport(html: string, width: number): Promise<any>;
      getThemePreference(): Promise<any>;
      setThemePreference(preference: string): Promise<any>;
      onThemeApply(cb: (data: any) => void): void;
      saveChartOverrides(entryId: string, key: string, overrides: any): Promise<any>;
      providerLogos: Record<string, { path: string; color: string; title: string }>;
      agentLogos: Record<string, string>;
      appVersion: string;
    };

    // ── Vendor libraries loaded via <script> tags in index.html ────────────
    Chart: any; // ponytail: Chart.js UMD global, typing the full API isn't worth it
    ChartBoxPlot: any; // ponytail: @sgratzl/chartjs-chart-boxplot UMD global
    pdfMake: any; // ponytail: pdfmake UMD global
    PptxGenJS: any; // ponytail: pptxgenjs UMD global (constructor)
    docx: any; // ponytail: docx IIFE global
    // Baked GeoJSON payloads (assets/geo/*.js, generated by scripts/download-geo.js).
    __GEO_WORLD__: any; // ponytail: GeoJSON FeatureCollection
    __GEO_US_STATES__: any; // ponytail: GeoJSON FeatureCollection
    // customDropdown.js attaches its factory to window.
    makeDropdown: (opts?: DropdownOpts) => DropdownApi;
    // Safari/legacy-prefixed AudioContext probed by playCompletionSound() in hub.js.
    webkitAudioContext?: typeof AudioContext;
  }

  /** Leaflet UMD global (leaflet.js script tag). */
  const L: any; // ponytail: Leaflet API, typing it fully isn't worth it

  // HTMLElement carries the dropdown API after makeDropdown() (root._dd = api).
  interface HTMLElement {
    _dd?: DropdownApi;
  }

  // These three are defined INSIDE an IIFE and exposed via window./global.
  // assignment (not as top-level declarations), so — unlike the rest of the
  // renderer's shared symbols — script-global sharing doesn't reach them and
  // they need an ambient declaration here. Callers use the bare name.
  function makeDropdown(opts?: DropdownOpts): DropdownApi; // customDropdown.js
  function normalizeName(n: string | null | undefined): string; // geoMatch.js
  function matchGeoItem(geoItems: any[], featProps: any): any | undefined; // geoMatch.js

  // PRE-EXISTING BUG (present in the original hub.js): called in the stpTestPerm
  // click handler but defined nowhere, so it throws at runtime. Declared here to
  // preserve that exact behavior through the migration; fix separately.
  function showPermissionPanel(): void;
}

// NOTE: hub-INTERNAL symbols (execBtn, entries, buildChart, makeDropdown, the
// cm* menu refs, exec* state, the per-file render helpers, …) are intentionally
// NOT declared here. The renderer is a set of classic global-scope <script>s in
// one shared scope, so TypeScript already shares every top-level const/let/
// function across the sibling files in this program — declaring them here too
// would just double-declare them (TS2451). Only genuinely EXTERNAL globals
// belong above: the preload bridge (window.hub), vendor UMD libs loaded via
// <script> (Chart/L/pdfMake/…), and the baked geo payloads.
