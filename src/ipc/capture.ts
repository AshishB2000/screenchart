import { ipcMain, BrowserWindow } from 'electron';

// Snapshot a rectangular region of the hub window's rendered page to a PNG data URL.
// Used to export the Leaflet MAP (tiles + choropleth/bubble SVG overlay + legend) into
// reports: a map isn't a single <canvas>, so the renderer draws it on-screen and we
// capture the real pixels here. webContents.capturePage is native — no CORS/canvas
// tainting and no extra dependency, unlike leaflet-image / html2canvas.
export function register() {
  // ponytail: untrusted renderer payloads — any, validated field-by-field below.
  ipcMain.handle('hub:captureRegion', async (event, rect: any) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return null;
      const r = rect || {};
      const box = {
        x: Math.max(0, Math.round(r.x) || 0),
        y: Math.max(0, Math.round(r.y) || 0),
        width: Math.round(r.width) || 0,
        height: Math.round(r.height) || 0,
      };
      if (box.width <= 0 || box.height <= 0) return null;
      const img = await win.webContents.capturePage(box);
      if (!img || img.isEmpty()) return null;
      return img.toDataURL();
    } catch (e) {
      console.error('captureRegion failed', e);
      return null;
    }
  });

  // Render a self-contained HTML report (built in the renderer) to a PNG data URL
  // via a hidden, content-sized BrowserWindow + capturePage. An offscreen window
  // (vs. capturing a region of the hub) means the FULL one-pager is captured at any
  // height without being clipped by the hub window, and capturePage snapshots at the
  // display's scale factor (2x on retina) so text + chart stay crisp. No html2canvas
  // or any new dependency. The HTML is fully inline (CSS + logo SVG + chart as a
  // data: URL) and runs sandboxed with no node access.
  ipcMain.handle('hub:captureReport', async (_e, { html, width }: any = {}) => {
    if (typeof html !== 'string' || !html) return null;
    const w = Math.max(320, Math.min(1600, Math.round(width) || 640));
    let win: BrowserWindow | undefined;
    try {
      win = new BrowserWindow({
        width: w,
        height: 800,
        show: false,
        enableLargerThanScreen: true, // allow a content height taller than the screen
        backgroundColor: '#ffffff',
        // Cast: paintWhenInitiallyHidden is kept exactly where the JS original put
        // it (electron.d.ts doesn't list it under WebPreferences).
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          paintWhenInitiallyHidden: true, // render even though never shown
          backgroundThrottling: false,
        } as Electron.WebPreferences,
      });
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      // Wait for the chart image (and fonts) so nothing is captured half-painted.
      await win.webContents.executeJavaScript(`new Promise(function (res) {
        function go() { (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () { res(true); }); }
        var img = document.querySelector('img.report-chart');
        if (!img || img.complete) { go(); } else { img.onload = go; img.onerror = go; setTimeout(go, 3000); }
      })`).catch(() => {});
      // Size the window to the full content height so the footer is never clipped.
      const h = await win.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)').catch(() => 0);
      win.setContentSize(w, Math.max(1, Math.min(8000, h || 800)));
      // Two frames so the resize lays out and paints before the snapshot.
      await win.webContents.executeJavaScript('new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(true); }); }); })').catch(() => {});
      const img = await win.webContents.capturePage();
      return img && !img.isEmpty() ? img.toDataURL() : null;
    } catch (e) {
      console.error('captureReport failed', e);
      return null;
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }
  });
}
