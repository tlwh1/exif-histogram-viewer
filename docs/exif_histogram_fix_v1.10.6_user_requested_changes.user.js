// ==UserScript==
// @name         EXIF Hover Overlay + Smart Histogram Toggle
// @namespace    https://openai.com/
// @version      1.10.6
// @description  Hover images to show EXIF, FF equivalent, smart histogram panel, histogram-anchored GPS mini-map panel, remembered state, compact icon controls, themed tooltips, live image-change detection, modal-header-safe positioning, deferred reveal, smarter matte-aware histogram, weighted highlight risk, more reliable mini-map rendering, and compact camera-body labels, focal-length/equivalent fallback fixes, and Photoshop-style histogram rendering, with auto-fitted histogram canvas width, plus stable fixed top-inside EXIF overlay for fullscreen/modal images without drifting to the bottom, smarter width-aware EXIF wrapping, persistent GPS panel mode, GPS panel close button, and NAVER/Kakao/Google map links.
// @author       OpenAI
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/exifr/dist/full.umd.js
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    hoverDelayMs: 120,
    hideDelayMs: 160,

    minDisplayWidth: 120,
    minDisplayHeight: 90,

    overlayMargin: 8,
    tooltipGap: 10,
    controlsGap: 6,
    controlsInnerGap: 6,
    controlsInset: 8,
    controlsAvoidGap: 8,
    controlButtonSize: 34,
    histGap: 10,
    imageChangeDebounceMs: 90,

    fullscreenOverlayViewportRatio: 0.56,
    fullscreenOverlayAreaRatio: 0.34,
    fullscreenOverlayMaxTopShift: 52,

    overlayFitThreshold: 0.92,
    forceTooltipWidth: 300,
    forceTooltipHeight: 170,

    tooltipMinWidth: 220,
    tooltipMaxWidth: 620,

    histPanelWidth: 292,
    histCanvasWidth: 252,
    histCanvasHeight: 82,
    histogramSampleMaxDim: 320,
    histDisplayGamma: 0.46,
    histDisplayPercentile: 0.992,
    histDisplaySmoothingRadius: 1,

    gpsPanelWidth: 292,
    gpsGap: 10,
    gpsMapWidth: 270,
    gpsMapHeight: 148,
    gpsMapZoom: 14,

    // Internal border-aware histogram tuning
    autoIgnoreSolidBorders: true,
    borderDetectAnalysisMaxDim: 256,
    borderDetectMaxCropRatio: 0.18,
    borderDetectMinStripThickness: 6,
    borderDetectConfidenceThreshold: 0.82,
    borderDetectMaxFailures: 2,

    // Neutral gray matte/frame detection
    borderNeutralLumaMin: 18,
    borderNeutralLumaMax: 238,
    borderNeutralStdMax: 7,
    borderNeutralSatMax: 14,
    borderNeutralEdgeMax: 0.035,
    borderNeutralLineDriftMax: 10,

    showLoadingText: false,
    showNoExifText: false,
    loadingText: 'EXIF 읽는 중...',
    noExifText: 'EXIF 없음',

    zIndexBase: 2147483644,
  };

  const STORAGE_KEYS = {
    histogramEnabled: 'tm_exif_histogram_enabled_v2',
  };

  const processedImages = new WeakSet();
  const stateMap = new WeakMap();
  const resourceCache = new Map();
  const mapTileCache = new Map();

  let activeImage = null;
  let activeText = '';
  let activeTextMode = null; // 'overlay' | 'tooltip'
  let auxHover = false;
  let histogramEnabled = loadPersistedBool(STORAGE_KEYS.histogramEnabled, false);
  let tooltipStickyTimer = null;
  let activeGpsData = null;
  let gpsPanelOpen = false;

  const overlayEl = createDiv('tm-exif-overlay');
  const tooltipEl = createDiv('tm-exif-tooltip');
  const measureEl = createDiv('tm-exif-measure');
  const controlsEl = createControls();
  const histPanelEl = createHistogramPanel();
  const gpsPanelEl = createGpsPanel();

  document.documentElement.appendChild(overlayEl);
  document.documentElement.appendChild(tooltipEl);
  document.documentElement.appendChild(measureEl);
  document.documentElement.appendChild(controlsEl.root);
  document.documentElement.appendChild(histPanelEl.root);
  document.documentElement.appendChild(gpsPanelEl.root);

  injectStyles();
  init();

  function init() {
    bindExistingImages();
    observeNewImages();
    bindAuxHover(controlsEl.root);
    bindAuxHover(histPanelEl.root);
    bindAuxHover(gpsPanelEl.root);

    bindControlTooltip(controlsEl.gpsButton);
    bindControlTooltip(controlsEl.histButton);

    controlsEl.gpsButton.addEventListener('click', onToggleGpsClick, true);
    controlsEl.histButton.addEventListener('click', onToggleHistogramClick, true);
    gpsPanelEl.closeButton.addEventListener('click', onGpsPanelCloseClick, true);

    window.addEventListener('resize', repositionActiveUI, { passive: true });
    document.addEventListener('scroll', repositionActiveUI, { passive: true, capture: true });

    updateControlTexts();
  }

  function injectStyles() {
    GM_addStyle(`
      .tm-exif-overlay,
      .tm-exif-tooltip,
      .tm-exif-measure,
      .tm-exif-controls,
      .tm-exif-hist-panel {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", Arial, sans-serif;
        font-size: 13px;
        line-height: 1.35;
        box-sizing: border-box;
      }

      .tm-exif-overlay,
      .tm-exif-tooltip {
        position: fixed;
        left: 0;
        top: 0;
        padding: 7px 10px;
        border-radius: 8px;
        background: rgba(10, 10, 12, 0.78);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 8px 28px rgba(0,0,0,0.34);
        backdrop-filter: blur(5px);
        -webkit-backdrop-filter: blur(5px);
        z-index: ${CONFIG.zIndexBase + 1};
        opacity: 0;
        transform: translateY(-4px);
        transition: opacity 110ms ease, transform 110ms ease;
        pointer-events: none;
      }

      .tm-exif-overlay {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tm-exif-overlay.tm-multiline {
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .tm-exif-tooltip {
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .tm-exif-overlay.tm-visible,
      .tm-exif-tooltip.tm-visible {
        opacity: 1;
        transform: translateY(0);
      }

      .tm-exif-overlay.tm-muted,
      .tm-exif-tooltip.tm-muted {
        color: rgba(255,255,255,0.82);
      }

      .tm-exif-measure {
        position: fixed;
        left: -10000px;
        top: -10000px;
        visibility: hidden;
        opacity: 0;
        padding: 7px 10px;
        border: 1px solid transparent;
        white-space: nowrap;
        pointer-events: none;
        z-index: -1;
      }

      .tm-exif-controls {
        position: fixed;
        left: 0;
        top: 0;
        z-index: ${CONFIG.zIndexBase + 3};
        opacity: 0;
        transform: translateY(-4px);
        transition: opacity 110ms ease, transform 110ms ease;
        pointer-events: none;
      }

      .tm-exif-controls.tm-visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      .tm-exif-controls-row {
        display: flex;
        align-items: center;
        gap: ${CONFIG.controlsInnerGap}px;
      }

      .tm-hidden {
        display: none !important;
      }

      .tm-exif-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(10,10,12,0.86);
        color: #fff;
        border-radius: 999px;
        width: ${CONFIG.controlButtonSize}px;
        height: ${CONFIG.controlButtonSize}px;
        min-width: ${CONFIG.controlButtonSize}px;
        min-height: ${CONFIG.controlButtonSize}px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0,0,0,0.28);
        backdrop-filter: blur(5px);
        -webkit-backdrop-filter: blur(5px);
        transition: transform 90ms ease, background 90ms ease, border-color 90ms ease;
      }

      .tm-exif-btn:hover {
        transform: translateY(-1px);
      }

      .tm-exif-btn.tm-on {
        background: rgba(35, 120, 255, 0.92);
        border-color: rgba(255,255,255,0.22);
      }

      .tm-exif-btn svg {
        width: 18px;
        height: 18px;
        display: block;
        pointer-events: none;
      }

      .tm-exif-btn .tm-icon-stroke {
        stroke: currentColor;
        stroke-width: 1.9;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }

      .tm-exif-btn .tm-icon-fill {
        fill: currentColor;
      }

      .tm-exif-btn .tm-icon-slash {
        opacity: 0;
        transition: opacity 90ms ease;
      }

      .tm-exif-btn.tm-on .tm-icon-slash {
        opacity: 1;
      }

      .tm-exif-btn-tooltip {
        position: absolute;
        left: 50%;
        bottom: calc(100% + 8px);
        transform: translate(-50%, 4px);
        min-width: 180px;
        max-width: 280px;
        padding: 7px 9px;
        border-radius: 8px;
        background: rgba(10, 10, 12, 0.92);
        color: rgba(255,255,255,0.96);
        border: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 8px 24px rgba(0,0,0,0.28);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        font-size: 11px;
        line-height: 1.35;
        white-space: normal;
        text-align: center;
        pointer-events: none;
        opacity: 0;
        transition: opacity 110ms ease, transform 110ms ease;
      }

      .tm-exif-btn-tooltip::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 100%;
        width: 10px;
        height: 10px;
        background: rgba(10, 10, 12, 0.92);
        border-right: 1px solid rgba(255,255,255,0.12);
        border-bottom: 1px solid rgba(255,255,255,0.12);
        transform: translateX(-50%) rotate(45deg);
      }

      .tm-exif-btn-tooltip.tm-visible {
        opacity: 1;
        transform: translate(-50%, 0);
      }

      .tm-exif-gps-panel,
      .tm-exif-hist-panel {
        position: fixed;
        left: 0;
        top: 0;
        color: #fff;
        border: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 10px 30px rgba(0,0,0,0.36);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        opacity: 0;
        transform: translateY(-4px);
        transition: opacity 110ms ease, transform 110ms ease;
        pointer-events: none;
      }

      .tm-exif-gps-panel.tm-visible,
      .tm-exif-hist-panel.tm-visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      .tm-exif-gps-panel {
        width: ${CONFIG.histPanelWidth}px;
        box-sizing: border-box;
        padding: 10px 10px 10px;
        border-radius: 12px;
        background: rgba(10, 10, 12, 0.84);
        z-index: ${CONFIG.zIndexBase + 2};
      }

      .tm-exif-gps-head,
      .tm-exif-hist-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 7px;
        font-size: 12px;
      }

      .tm-exif-gps-title,
      .tm-exif-hist-title {
        font-weight: 600;
        letter-spacing: 0.01em;
      }

      .tm-exif-gps-meta,
      .tm-exif-hist-meta {
        color: rgba(255,255,255,0.78);
        font-size: 11px;
      }

      .tm-exif-gps-head-main {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .tm-exif-gps-head-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tm-exif-panel-close {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(10,10,12,0.86);
        color: rgba(255,255,255,0.92);
        border-radius: 999px;
        min-width: 28px;
        height: 28px;
        padding: 0 9px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0,0,0,0.24);
        backdrop-filter: blur(5px);
        -webkit-backdrop-filter: blur(5px);
        transition: transform 90ms ease, background 90ms ease, border-color 90ms ease;
        font-size: 11px;
        line-height: 1;
      }

      .tm-exif-panel-close:hover {
        transform: translateY(-1px);
        background: rgba(255,255,255,0.08);
      }

      .tm-exif-gps-body {
        display: grid;
        gap: 6px;
        width: 100%;
      }

      .tm-exif-gps-row {
        display: grid;
        grid-template-columns: 42px 1fr;
        gap: 8px;
        align-items: start;
        font-size: 12px;
      }

      .tm-exif-gps-label {
        color: rgba(255,255,255,0.62);
      }

      .tm-exif-gps-value {
        min-width: 0;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .tm-exif-gps-map-wrap {
        position: relative;
        width: 100%;
        height: ${CONFIG.gpsMapHeight}px;
        box-sizing: border-box;
        border-radius: 10px;
        overflow: hidden;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
      }

      .tm-exif-gps-map {
        display: block;
        width: 100%;
        height: ${CONFIG.gpsMapHeight}px;
      }

      .tm-exif-gps-map-attrib {
        position: absolute;
        right: 6px;
        bottom: 5px;
        padding: 2px 5px;
        border-radius: 999px;
        background: rgba(10,10,12,0.64);
        border: 1px solid rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.74);
        font-size: 10px;
        line-height: 1;
        letter-spacing: 0.01em;
        pointer-events: none;
      }

      .tm-exif-gps-links {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 4px;
      }

      .tm-exif-gps-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 28px;
        padding: 0 10px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.04);
        color: rgba(255,255,255,0.94);
        text-decoration: none;
        font-size: 11px;
        line-height: 1;
        box-shadow: 0 6px 18px rgba(0,0,0,0.2);
      }

      .tm-exif-gps-link:hover {
        background: rgba(255,255,255,0.08);
      }

      .tm-exif-hist-panel {
        width: ${CONFIG.histPanelWidth}px;
        padding: 10px 10px 9px;
        border-radius: 12px;
        background: rgba(10, 10, 12, 0.84);
        z-index: ${CONFIG.zIndexBase + 2};
      }

      .tm-exif-hist-canvas-wrap {
        border-radius: 8px;
        overflow: hidden;
        background:
          linear-gradient(to top, rgba(255,255,255,0.06), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.08);
      }

      .tm-exif-hist-canvas {
        display: block;
        width: 100%;
        height: ${CONFIG.histCanvasHeight}px;
      }

      .tm-exif-hist-foot {
        margin-top: 8px;
        font-size: 11px;
        color: rgba(255,255,255,0.82);
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }

      .tm-exif-hist-note {
        margin-top: 4px;
        font-size: 10px;
        color: rgba(255,255,255,0.54);
      }

      .tm-exif-hist-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-height: ${CONFIG.histCanvasHeight}px;
        height: ${CONFIG.histCanvasHeight}px;
        box-sizing: border-box;
        font-size: 12px;
        color: rgba(255,255,255,0.82);
      }
    `);
  }

  function createDiv(className) {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  function createControls() {
    const root = document.createElement('div');
    root.className = 'tm-exif-controls';

    const tooltip = document.createElement('div');
    tooltip.className = 'tm-exif-btn-tooltip';

    const row = document.createElement('div');
    row.className = 'tm-exif-controls-row';

    const gpsButton = document.createElement('button');
    gpsButton.className = 'tm-exif-btn tm-hidden';
    gpsButton.type = 'button';

    const histButton = document.createElement('button');
    histButton.className = 'tm-exif-btn';
    histButton.type = 'button';

    row.appendChild(gpsButton);
    row.appendChild(histButton);
    root.appendChild(tooltip);
    root.appendChild(row);

    return { root, tooltip, row, gpsButton, histButton };
  }

  function createHistogramPanel() {
    const root = document.createElement('div');
    root.className = 'tm-exif-hist-panel';

    const head = document.createElement('div');
    head.className = 'tm-exif-hist-head';

    const title = document.createElement('div');
    title.className = 'tm-exif-hist-title';
    title.textContent = 'RGB + Luma';

    const meta = document.createElement('div');
    meta.className = 'tm-exif-hist-meta';

    head.appendChild(title);
    head.appendChild(meta);

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'tm-exif-hist-canvas-wrap';

    const loading = document.createElement('div');
    loading.className = 'tm-exif-hist-loading';
    loading.textContent = '히스토그램 계산 중...';

    const canvas = document.createElement('canvas');
    canvas.className = 'tm-exif-hist-canvas';
    canvas.width = CONFIG.histCanvasWidth;
    canvas.height = CONFIG.histCanvasHeight;
    canvas.style.display = 'none';

    canvasWrap.appendChild(loading);
    canvasWrap.appendChild(canvas);

    const foot = document.createElement('div');
    foot.className = 'tm-exif-hist-foot';

    const shadow = document.createElement('div');
    const highlight = document.createElement('div');

    foot.appendChild(shadow);
    foot.appendChild(highlight);

    const note = document.createElement('div');
    note.className = 'tm-exif-hist-note';
    note.textContent = '웹페이지에 표시된 이미지 기준';
    note.style.display = 'none';

    root.appendChild(head);
    root.appendChild(canvasWrap);
    root.appendChild(foot);
    root.appendChild(note);

    return {
      root,
      meta,
      loading,
      canvas,
      shadow,
      highlight,
      note,
    };
  }

  function createGpsPanel() {
    const root = document.createElement('div');
    root.className = 'tm-exif-gps-panel';

    const head = document.createElement('div');
    head.className = 'tm-exif-gps-head';

    const headMain = document.createElement('div');
    headMain.className = 'tm-exif-gps-head-main';

    const title = document.createElement('div');
    title.className = 'tm-exif-gps-title';
    title.textContent = 'GPS';

    const meta = document.createElement('div');
    meta.className = 'tm-exif-gps-meta';

    headMain.appendChild(title);
    headMain.appendChild(meta);

    const headActions = document.createElement('div');
    headActions.className = 'tm-exif-gps-head-actions';

    const closeButton = document.createElement('button');
    closeButton.className = 'tm-exif-panel-close';
    closeButton.type = 'button';
    closeButton.textContent = '닫기';
    closeButton.setAttribute('aria-label', 'GPS 정보 닫기');

    headActions.appendChild(closeButton);

    head.appendChild(headMain);
    head.appendChild(headActions);

    const body = document.createElement('div');
    body.className = 'tm-exif-gps-body';

    const mapWrap = document.createElement('div');
    mapWrap.className = 'tm-exif-gps-map-wrap';

    const mapCanvas = document.createElement('canvas');
    mapCanvas.className = 'tm-exif-gps-map';
    mapCanvas.width = CONFIG.gpsMapWidth;
    mapCanvas.height = CONFIG.gpsMapHeight;

    const mapAttribution = document.createElement('div');
    mapAttribution.className = 'tm-exif-gps-map-attrib';
    mapAttribution.textContent = '© OSM';

    mapWrap.appendChild(mapCanvas);
    mapWrap.appendChild(mapAttribution);

    const coordsRow = document.createElement('div');
    coordsRow.className = 'tm-exif-gps-row';
    const coordsLabel = document.createElement('div');
    coordsLabel.className = 'tm-exif-gps-label';
    coordsLabel.textContent = '좌표';
    const coordsValue = document.createElement('div');
    coordsValue.className = 'tm-exif-gps-value';
    coordsRow.appendChild(coordsLabel);
    coordsRow.appendChild(coordsValue);

    const altitudeRow = document.createElement('div');
    altitudeRow.className = 'tm-exif-gps-row';
    const altitudeLabel = document.createElement('div');
    altitudeLabel.className = 'tm-exif-gps-label';
    altitudeLabel.textContent = '고도';
    const altitudeValue = document.createElement('div');
    altitudeValue.className = 'tm-exif-gps-value';
    altitudeRow.appendChild(altitudeLabel);
    altitudeRow.appendChild(altitudeValue);

    const directionRow = document.createElement('div');
    directionRow.className = 'tm-exif-gps-row';
    const directionLabel = document.createElement('div');
    directionLabel.className = 'tm-exif-gps-label';
    directionLabel.textContent = '방향';
    const directionValue = document.createElement('div');
    directionValue.className = 'tm-exif-gps-value';
    directionRow.appendChild(directionLabel);
    directionRow.appendChild(directionValue);

    const links = document.createElement('div');
    links.className = 'tm-exif-gps-links';

    const naverLink = document.createElement('a');
    naverLink.className = 'tm-exif-gps-link';
    naverLink.target = '_blank';
    naverLink.rel = 'noopener noreferrer';
    naverLink.textContent = 'Naver Map';

    const kakaoLink = document.createElement('a');
    kakaoLink.className = 'tm-exif-gps-link';
    kakaoLink.target = '_blank';
    kakaoLink.rel = 'noopener noreferrer';
    kakaoLink.textContent = 'Kakao Map';

    const googleLink = document.createElement('a');
    googleLink.className = 'tm-exif-gps-link';
    googleLink.target = '_blank';
    googleLink.rel = 'noopener noreferrer';
    googleLink.textContent = 'Google Maps';

    links.appendChild(naverLink);
    links.appendChild(kakaoLink);
    links.appendChild(googleLink);

    body.appendChild(mapWrap);
    body.appendChild(coordsRow);
    body.appendChild(altitudeRow);
    body.appendChild(directionRow);
    body.appendChild(links);

    root.appendChild(head);
    root.appendChild(body);

    return {
      root,
      meta,
      closeButton,
      mapWrap,
      mapCanvas,
      mapAttribution,
      coordsRow,
      coordsValue,
      altitudeRow,
      altitudeValue,
      directionRow,
      directionValue,
      links,
      naverLink,
      kakaoLink,
      googleLink,
    };
  }

  function bindExistingImages(root = document) {
    const imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
    for (const img of imgs) bindImage(img);
  }

  function bindImage(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (processedImages.has(img)) return;

    processedImages.add(img);
    img.addEventListener('mouseenter', () => onImageEnter(img), { passive: true });
    img.addEventListener('mouseleave', () => onImageLeave(img), { passive: true });
    img.addEventListener('load', () => onImageSourceMaybeChanged(img, 'load'), { passive: true });
    img.addEventListener('error', () => onImageSourceMaybeChanged(img, 'error'), { passive: true });
    observeImageAttributes(img);

    const state = getState(img);
    state.lastSignature = getImageSignature(img);
  }

  function observeNewImages() {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.tagName === 'IMG') bindImage(node);
            else bindExistingImages(node);
          }

          if (activeImage && m.target instanceof Element && m.target.contains(activeImage)) {
            onImageSourceMaybeChanged(activeImage, 'dom-swap');
          }
        } else if (
          m.type === 'attributes' &&
          activeImage &&
          m.target instanceof HTMLSourceElement &&
          m.target.parentElement &&
          activeImage.parentElement === m.target.parentElement
        ) {
          onImageSourceMaybeChanged(activeImage, 'source-attr');
        }
      }
    });

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'sizes'],
    });
  }

  function bindAuxHover(el) {
    el.addEventListener('mouseenter', () => {
      auxHover = true;
      cancelHideTimer();
    }, true);

    el.addEventListener('mouseleave', () => {
      auxHover = false;
      scheduleHideIfInactive();
    }, true);
  }

  function bindControlTooltip(button) {
    button.addEventListener('mouseenter', () => {
      showControlTooltip(button, button.dataset.tip || '');
    }, true);

    button.addEventListener('mouseleave', () => {
      if (!tooltipStickyTimer) hideControlTooltip();
    }, true);
  }

  function showControlTooltip(button, text, stickyMs = 0) {
    clearTimeout(tooltipStickyTimer);
    tooltipStickyTimer = null;

    controlsEl.tooltip.textContent = text;

    const rootRect = controlsEl.root.getBoundingClientRect();
    const btnRect = button.getBoundingClientRect();
    const centerX = btnRect.left - rootRect.left + btnRect.width / 2;

    controlsEl.tooltip.style.left = `${centerX}px`;
    controlsEl.tooltip.classList.add('tm-visible');

    if (stickyMs > 0) {
      tooltipStickyTimer = setTimeout(() => {
        tooltipStickyTimer = null;
        if (!button.matches(':hover')) hideControlTooltip();
      }, stickyMs);
    }
  }

  function hideControlTooltip() {
    controlsEl.tooltip.classList.remove('tm-visible');
  }

  function getState(img) {
    if (!stateMap.has(img)) {
      stateMap.set(img, {
        enterTimer: null,
        leaveTimer: null,
        refreshTimer: null,
        attrObserver: null,
        token: 0,
        lastSignature: '',
        lastUrl: '',
      });
    }
    return stateMap.get(img);
  }


  function observeImageAttributes(img) {
    const state = getState(img);
    if (state.attrObserver) return;

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          onImageSourceMaybeChanged(img, `img-${m.attributeName || 'attr'}`);
          break;
        }
      }
    });

    mo.observe(img, {
      attributes: true,
      attributeFilter: ['src', 'srcset', 'sizes'],
    });

    state.attrObserver = mo;
  }

  function getImageSignature(img) {
    if (!(img instanceof HTMLImageElement)) return '';
    return [
      img.currentSrc || '',
      img.src || '',
      img.getAttribute('src') || '',
      img.getAttribute('srcset') || '',
      img.getAttribute('sizes') || '',
      img.naturalWidth || 0,
      img.naturalHeight || 0,
      img.complete ? 1 : 0,
    ].join('||');
  }

  function onImageSourceMaybeChanged(img, _reason = 'change') {
    if (!(img instanceof HTMLImageElement)) return;

    const state = getState(img);
    const nextSignature = getImageSignature(img);
    const hovered = document.contains(img) && img.matches(':hover');

    if (nextSignature === state.lastSignature && activeImage !== img) return;
    state.lastSignature = nextSignature;

    clearTimeout(state.refreshTimer);

    if (activeImage === img) {
      state.token += 1;
      activeGpsData = null;
      gpsPanelOpen = false;
      hideGpsPanel(true);

      if (histogramEnabled) {
        resetHistogramPanelState();
        hideHistogramPanel(true);
      } else {
        hideHistogramPanel(true);
      }

      updateControlTexts();
      showControls();
      positionControls(img);

      if (CONFIG.showLoadingText) {
        const loadingLayout = chooseTextPresentation(img, CONFIG.loadingText);
        showTextUI(CONFIG.loadingText, img, loadingLayout, true);
      } else {
        hideTextUI();
      }
    } else if (!hovered) {
      return;
    }

    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;

      if (activeImage === img || (document.contains(img) && img.matches(':hover'))) {
        void activateImage(img);
      }
    }, CONFIG.imageChangeDebounceMs);
  }

  function onImageEnter(img) {
    const state = getState(img);
    clearTimeout(state.leaveTimer);
    state.enterTimer = setTimeout(() => {
      void activateImage(img);
    }, CONFIG.hoverDelayMs);
  }

  function onImageLeave(img) {
    const state = getState(img);
    clearTimeout(state.enterTimer);
    state.leaveTimer = setTimeout(() => {
      if (activeImage === img) scheduleHideIfInactive();
    }, 20);
  }

  function cancelHideTimer() {
    if (activeImage) {
      clearTimeout(getState(activeImage).leaveTimer);
    }
  }

  function scheduleHideIfInactive() {
    if (!activeImage) return;

    const state = getState(activeImage);
    clearTimeout(state.leaveTimer);
    state.leaveTimer = setTimeout(() => {
      if (isActiveZoneHovered()) return;

      if (shouldPersistGpsPanel()) {
        collapseToGpsPanel();
        return;
      }

      hideAll();
    }, CONFIG.hideDelayMs);
  }

  function isActiveZoneHovered() {
    return !!(
      activeImage &&
      (
        (document.contains(activeImage) && activeImage.matches(':hover')) ||
        auxHover
      )
    );
  }

  function shouldPersistGpsPanel() {
    return !!(
      activeImage &&
      activeGpsData &&
      gpsPanelOpen &&
      document.contains(activeImage)
    );
  }

  function collapseToGpsPanel() {
    if (!shouldPersistGpsPanel()) {
      hideAll();
      return;
    }

    hideTextUI();
    hideControls();
    hideHistogramPanel(true);

    if (!gpsPanelEl.root.classList.contains('tm-visible')) {
      renderGpsPanel(activeGpsData, activeImage);
      return;
    }

    positionGpsPanel(activeImage);
  }

  function updateControlTexts() {
    const hasGps = !!activeGpsData;

    controlsEl.gpsButton.classList.toggle('tm-hidden', !hasGps);
    controlsEl.gpsButton.classList.toggle('tm-on', gpsPanelOpen && hasGps);
    controlsEl.gpsButton.innerHTML = buildGpsIconSvg(gpsPanelOpen && hasGps);
    controlsEl.gpsButton.dataset.tip = hasGps
      ? (gpsPanelOpen ? 'GPS 정보 숨기기' : 'GPS 정보 보기')
      : '';
    if (hasGps) controlsEl.gpsButton.setAttribute('aria-label', controlsEl.gpsButton.dataset.tip);
    else controlsEl.gpsButton.removeAttribute('aria-label');
    controlsEl.gpsButton.removeAttribute('title');

    controlsEl.histButton.classList.toggle('tm-on', histogramEnabled);
    controlsEl.histButton.innerHTML = buildHistogramIconSvg(histogramEnabled);
    controlsEl.histButton.dataset.tip = histogramEnabled
      ? '히스토그램 숨기기'
      : '히스토그램 보기';
    controlsEl.histButton.setAttribute('aria-label', controlsEl.histButton.dataset.tip);
    controlsEl.histButton.removeAttribute('title');
  }

  function buildGpsIconSvg(isOn) {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path class="tm-icon-stroke" d="M12 21.2s-5.4-5.3-5.4-9.6a5.4 5.4 0 1 1 10.8 0c0 4.3-5.4 9.6-5.4 9.6z" />
        <circle class="tm-icon-stroke" cx="12" cy="11.1" r="1.9" />
        <path class="tm-icon-stroke tm-icon-slash" d="M5 5l14 14" />
      </svg>
    `;
  }

  function buildHistogramIconSvg(isOn) {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path class="tm-icon-stroke" d="M3.5 19.5h17" />
        <rect class="tm-icon-fill" x="5" y="11.5" width="2.8" height="6" rx="0.9" />
        <rect class="tm-icon-fill" x="10.6" y="7.5" width="2.8" height="10" rx="0.9" />
        <rect class="tm-icon-fill" x="16.2" y="4.5" width="2.8" height="13" rx="0.9" />
        <path class="tm-icon-stroke tm-icon-slash" d="M5 5l14 14" />
      </svg>
    `;
  }

  async function activateImage(img) {
    if (!shouldHandleImage(img)) return;

    const state = getState(img);
    state.token += 1;
    const token = state.token;

    activeImage = img;
    state.lastSignature = getImageSignature(img);
    activeGpsData = null;
    gpsPanelOpen = false;
    hideGpsPanel(true);

    if (histogramEnabled) {
      resetHistogramPanelState();
      hideHistogramPanel(true);
    } else {
      hideHistogramPanel(true);
    }

    updateControlTexts();
    showControls();
    positionControls(img);

    if (CONFIG.showLoadingText) {
      const loadingLayout = chooseTextPresentation(img, CONFIG.loadingText);
      showTextUI(CONFIG.loadingText, img, loadingLayout, true);
    }

    const url = getImageUrl(img);
    state.lastUrl = url;
    if (!url) {
      hideTextUI();
      return;
    }

    let exif = null;
    let resource = null;

    try {
      [exif, resource] = await Promise.all([
        getExif(url),
        getImageResource(url).catch(() => null),
      ]);
    } catch (_) {}

    if (isStale(img, token)) return;

    activeGpsData = extractGpsInfo(exif);
    if (!activeGpsData) {
      gpsPanelOpen = false;
      hideGpsPanel(true);
    }
    updateControlTexts();

    if (!exif) {
      if (CONFIG.showNoExifText) {
        const noExifLayout = chooseTextPresentation(img, CONFIG.noExifText);
        showTextUI(CONFIG.noExifText, img, noExifLayout, true);
      } else {
        hideTextUI();
      }
    } else {
      const text = buildOverlayText(exif, img, resource);
      if (text) {
        const layout = chooseTextPresentation(img, text);
        showTextUI(text, img, layout, false);
      } else if (CONFIG.showNoExifText) {
        const noExifLayout = chooseTextPresentation(img, CONFIG.noExifText);
        showTextUI(CONFIG.noExifText, img, noExifLayout, true);
      } else {
        hideTextUI();
      }
    }

    if (histogramEnabled) {
      void ensureHistogramVisibleForCurrentImage(token);
    } else {
      positionControls(img);
    }

    if (gpsPanelOpen && activeGpsData) {
      renderGpsPanel(activeGpsData, img);
    } else {
      positionControls(img);
    }
  }

  function isStale(img, token) {
    return !(activeImage === img && getState(img).token === token);
  }

  function shouldHandleImage(img) {
    if (!(img instanceof HTMLImageElement)) return false;

    const rect = img.getBoundingClientRect();
    if (rect.width < CONFIG.minDisplayWidth || rect.height < CONFIG.minDisplayHeight) return false;

    const cs = getComputedStyle(img);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;

    return !!getImageUrl(img);
  }

  function getImageUrl(img) {
    return img.currentSrc || img.src || '';
  }

  function getResourceEntry(url) {
    if (!resourceCache.has(url)) {
      resourceCache.set(url, {
        imageResourcePromise: null,
        exifPromise: null,
        histogramPromise: null,
      });
    }
    return resourceCache.get(url);
  }

  async function getImageResource(url) {
    const entry = getResourceEntry(url);
    if (entry.imageResourcePromise) return entry.imageResourcePromise;

    entry.imageResourcePromise = (async () => {
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        const res = await fetch(url);
        const blob = await res.blob();
        const buffer = await blob.arrayBuffer();
        return {
          buffer,
          mime: blob.type || guessMimeFromUrl(url) || 'image/jpeg',
        };
      }

      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          timeout: 15000,
          onload: (res) => {
            if (!(res.status >= 200 && res.status < 400) || !res.response) {
              reject(new Error(`HTTP ${res.status}`));
              return;
            }

            resolve({
              buffer: res.response,
              mime: getContentTypeFromHeaders(res.responseHeaders) || guessMimeFromUrl(url) || 'image/jpeg',
            });
          },
          onerror: () => reject(new Error('GM_xmlhttpRequest failed')),
          ontimeout: () => reject(new Error('Image fetch timeout')),
        });
      });
    })().catch((err) => {
      entry.imageResourcePromise = null;
      throw err;
    });

    return entry.imageResourcePromise;
  }

  async function getExif(url) {
    const entry = getResourceEntry(url);
    if (entry.exifPromise) return entry.exifPromise;

    entry.exifPromise = (async () => {
      const resource = await getImageResource(url);
      const exif = await exifr.parse(resource.buffer, {
        pick: [
          'Make',
          'Model',
          'LensModel',
          'LensSpecification',
          'FocalLength',
          'FocalLengthIn35mmFilm',
          'ExposureTime',
          'FNumber',
          'ISO',
          'DateTimeOriginal',
          'CreateDate',
          'latitude',
          'longitude',
          'altitude',
          'GPSLatitude',
          'GPSLongitude',
          'GPSLatitudeRef',
          'GPSLongitudeRef',
          'GPSAltitude',
          'GPSImgDirection',
          'GPSDestBearing',
        ],
      });
      return exif || null;
    })().catch(() => null);

    return entry.exifPromise;
  }

  async function getHistogram(url) {
    const entry = getResourceEntry(url);
    if (entry.histogramPromise) return entry.histogramPromise;

    entry.histogramPromise = (async () => {
      const resource = await getImageResource(url);
      return await buildHistogramFromBuffer(resource.buffer, resource.mime);
    })().catch(() => null);

    return entry.histogramPromise;
  }

  async function buildHistogramFromBuffer(buffer, mime) {
    const blob = new Blob([buffer], { type: mime || 'image/jpeg' });
    const source = await decodeImageRenderable(blob);

    try {
      const srcW = source.naturalWidth || source.videoWidth || source.width;
      const srcH = source.naturalHeight || source.videoHeight || source.height;

      let roiInfo = {
        confidence: 0,
        borderTrimmed: false,
        roi: { x: 0, y: 0, width: srcW, height: srcH },
        cropPixels: { top: 0, bottom: 0, left: 0, right: 0 },
      };

      if (CONFIG.autoIgnoreSolidBorders) {
        const detected = detectSmartBorderROI(source, srcW, srcH);
        if (detected && detected.confidence >= CONFIG.borderDetectConfidenceThreshold) {
          roiInfo = detected;
        }
      }

      const roi = roiInfo.roi;
      const maxDim = CONFIG.histogramSampleMaxDim;
      const scale = Math.min(1, maxDim / Math.max(roi.width, roi.height));
      const w = Math.max(1, Math.round(roi.width * scale));
      const h = Math.max(1, Math.round(roi.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      ctx.drawImage(
        source,
        roi.x, roi.y, roi.width, roi.height,
        0, 0, w, h
      );

      const { data } = ctx.getImageData(0, 0, w, h);
      const r = new Uint32Array(256);
      const g = new Uint32Array(256);
      const b = new Uint32Array(256);
      const l = new Uint32Array(256);

      let shadowClip = 0;
      let shadowNear = 0;
      let highlightClip = 0;
      let highlightNear = 0;
      let total = 0;

      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) continue;

        const rv = data[i];
        const gv = data[i + 1];
        const bv = data[i + 2];

        r[rv]++;
        g[gv]++;
        b[bv]++;

        const lv = Math.max(0, Math.min(255, Math.round(0.2126 * rv + 0.7152 * gv + 0.0722 * bv)));
        l[lv]++;

        if (lv <= 1) shadowClip++;
        if (lv <= 5) shadowNear++;
        if (lv >= 254) highlightClip++;
        if (lv >= 250) highlightNear++;
        total++;
      }

      const rawShadowClipPct = total ? (shadowClip / total) * 100 : 0;
      const nearShadowPct = total ? (shadowNear / total) * 100 : 0;
      const rawHighlightClipPct = total ? (highlightClip / total) * 100 : 0;
      const nearHighlightPct = total ? (highlightNear / total) * 100 : 0;

      return {
        r, g, b, l,
        total,
        sampledWidth: w,
        sampledHeight: h,
        shadowClipPct: computeWeightedRisk(rawShadowClipPct, nearShadowPct),
        highlightClipPct: computeWeightedRisk(rawHighlightClipPct, nearHighlightPct),
        rawShadowClipPct,
        rawHighlightClipPct,
        nearShadowPct,
        nearHighlightPct,
        borderTrimmed: !!roiInfo.borderTrimmed,
        roiConfidence: roiInfo.confidence || 0,
        cropPixels: roiInfo.cropPixels || { top: 0, bottom: 0, left: 0, right: 0 },
      };
    } finally {
      if (source && typeof source.close === 'function') {
        try { source.close(); } catch (_) {}
      }
    }
  }

  function detectSmartBorderROI(source, srcW, srcH) {
    const maxDim = CONFIG.borderDetectAnalysisMaxDim;
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.max(24, Math.round(srcW * scale));
    const h = Math.max(24, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);

    const { data } = ctx.getImageData(0, 0, w, h);

    const maxCropX = Math.max(2, Math.floor(w * CONFIG.borderDetectMaxCropRatio));
    const maxCropY = Math.max(2, Math.floor(h * CONFIG.borderDetectMaxCropRatio));

    const candidates = {
      top: detectBorderCandidate(data, w, h, 'top', maxCropY),
      bottom: detectBorderCandidate(data, w, h, 'bottom', maxCropY),
      left: detectBorderCandidate(data, w, h, 'left', maxCropX),
      right: detectBorderCandidate(data, w, h, 'right', maxCropX),
    };

    const kept = finalizeBorderCandidates(candidates);

    const cropTop = kept.top.depth;
    const cropBottom = kept.bottom.depth;
    const cropLeft = kept.left.depth;
    const cropRight = kept.right.depth;

    const remainW = w - cropLeft - cropRight;
    const remainH = h - cropTop - cropBottom;

    if (remainW < w * 0.55 || remainH < h * 0.55) {
      return {
        confidence: 0,
        borderTrimmed: false,
        roi: { x: 0, y: 0, width: srcW, height: srcH },
        cropPixels: { top: 0, bottom: 0, left: 0, right: 0 },
      };
    }

    const totalCrop = cropTop + cropBottom + cropLeft + cropRight;
    if (totalCrop < 2) {
      return {
        confidence: 0,
        borderTrimmed: false,
        roi: { x: 0, y: 0, width: srcW, height: srcH },
        cropPixels: { top: 0, bottom: 0, left: 0, right: 0 },
      };
    }

    const usedSides = Object.values(kept).filter((side) => side.depth > 0);
    const confidence = usedSides.length
      ? usedSides.reduce((sum, side) => sum + side.confidence, 0) / usedSides.length
      : 0;

    const roi = {
      x: Math.round((cropLeft / w) * srcW),
      y: Math.round((cropTop / h) * srcH),
      width: Math.round((remainW / w) * srcW),
      height: Math.round((remainH / h) * srcH),
    };

    if (roi.width <= 0 || roi.height <= 0) {
      return {
        confidence: 0,
        borderTrimmed: false,
        roi: { x: 0, y: 0, width: srcW, height: srcH },
        cropPixels: { top: 0, bottom: 0, left: 0, right: 0 },
      };
    }

    return {
      confidence,
      borderTrimmed: totalCrop > 0,
      roi,
      cropPixels: {
        top: Math.round((cropTop / h) * srcH),
        bottom: Math.round((cropBottom / h) * srcH),
        left: Math.round((cropLeft / w) * srcW),
        right: Math.round((cropRight / w) * srcW),
      },
    };
  }

  function detectBorderCandidate(data, w, h, side, maxDepth) {
    const seed = estimateEdgeSeed(data, w, h, side);
    const statsList = [];
    const accepted = [];
    let depth = 0;
    let failStreak = 0;

    for (let i = 0; i < maxDepth; i++) {
      const stats = sampleBorderLineStats(data, w, h, side, i, seed);
      const score = scoreBorderLine(stats, seed);
      stats.score = score;
      statsList.push(stats);

      if (score >= 0.74) {
        accepted.push(stats);
        depth = i + 1;
        failStreak = 0;
        continue;
      }

      if (depth > 0 && score >= 0.60 && failStreak < CONFIG.borderDetectMaxFailures) {
        accepted.push(stats);
        depth = i + 1;
        failStreak++;
        continue;
      }

      if (depth > 0) {
        failStreak++;
        if (failStreak >= CONFIG.borderDetectMaxFailures) break;
      }
    }

    if (!depth) {
      return {
        side,
        depth: 0,
        confidence: 0,
        captionLike: false,
        seed,
        boundary: 0,
      };
    }

    const captionLike = accepted.some((stats) => (
      stats.neutralCoverage >= 0.94 &&
      stats.nearSeedCoverage >= 0.28 &&
      stats.nearSeedCoverage <= 0.86 &&
      Math.abs(stats.q75 - seed.luma) <= 18 &&
      Math.abs(stats.q50 - seed.luma) <= 58
    ));

    const boundary = evaluateBorderBoundary(statsList, depth);
    const avgScore = accepted.reduce((sum, stats) => sum + stats.score, 0) / accepted.length;
    let confidence = (avgScore * 0.64) + (boundary * 0.36);

    if (boundary < 0.42 && !captionLike) {
      confidence *= 0.55;
    }

    if (depth < 2 && !captionLike) {
      confidence *= 0.5;
    }

    return {
      side,
      depth,
      confidence,
      captionLike,
      seed,
      boundary,
    };
  }

  function finalizeBorderCandidates(candidates) {
    const keepable = (candidate) => candidate.depth >= 2 && candidate.confidence >= CONFIG.borderDetectConfidenceThreshold;
    const valid = {
      top: keepable(candidates.top),
      bottom: keepable(candidates.bottom),
      left: keepable(candidates.left),
      right: keepable(candidates.right),
    };

    const oppositePair = (
      (valid.top && valid.bottom) ||
      (valid.left && valid.right)
    );

    const validCount = Object.values(valid).filter(Boolean).length;
    const allowStructuredFrame = oppositePair || validCount >= 3;

    const kept = {
      top: { depth: 0, confidence: 0 },
      bottom: { depth: 0, confidence: 0 },
      left: { depth: 0, confidence: 0 },
      right: { depth: 0, confidence: 0 },
    };

    for (const side of ['top', 'bottom', 'left', 'right']) {
      const candidate = candidates[side];
      if (!valid[side]) continue;

      const allowSingleCaptionBand = (
        candidate.captionLike &&
        candidate.depth >= Math.max(6, CONFIG.borderDetectMinStripThickness) &&
        candidate.boundary >= 0.58
      );

      if (allowStructuredFrame || allowSingleCaptionBand) {
        kept[side] = {
          depth: candidate.depth,
          confidence: candidate.confidence,
        };
      }
    }

    return kept;
  }

  function estimateEdgeSeed(data, w, h, side) {
    const valuesR = [];
    const valuesG = [];
    const valuesB = [];
    const thickness = 2;

    if (side === 'top' || side === 'bottom') {
      for (let yOffset = 0; yOffset < thickness; yOffset++) {
        const y = side === 'top' ? yOffset : (h - 1 - yOffset);
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          valuesR.push(data[idx]);
          valuesG.push(data[idx + 1]);
          valuesB.push(data[idx + 2]);
        }
      }
    } else {
      for (let xOffset = 0; xOffset < thickness; xOffset++) {
        const x = side === 'left' ? xOffset : (w - 1 - xOffset);
        for (let y = 0; y < h; y++) {
          const idx = (y * w + x) * 4;
          valuesR.push(data[idx]);
          valuesG.push(data[idx + 1]);
          valuesB.push(data[idx + 2]);
        }
      }
    }

    const r = medianOf(valuesR);
    const g = medianOf(valuesG);
    const b = medianOf(valuesB);

    return {
      r,
      g,
      b,
      luma: rgbToLuma(r, g, b),
    };
  }

  function sampleBorderLineStats(data, w, h, side, offset, seed) {
    const lumas = [];
    let sumL = 0;
    let sumL2 = 0;
    let sumSat = 0;
    let edgeCount = 0;
    let neutralCount = 0;
    let nearSeedCount = 0;
    let strongSeedCount = 0;
    let n = 0;

    if (side === 'top' || side === 'bottom') {
      const y = side === 'top' ? offset : (h - 1 - offset);
      const innerY = side === 'top'
        ? Math.min(h - 1, y + 1)
        : Math.max(0, y - 1);

      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const idx2 = (innerY * w + x) * 4;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const r2 = data[idx2];
        const g2 = data[idx2 + 1];
        const b2 = data[idx2 + 2];

        const l = rgbToLuma(r, g, b);
        const l2 = rgbToLuma(r2, g2, b2);
        const sat = rgbToSaturation(r, g, b);
        const delta = Math.max(
          Math.abs(r - seed.r),
          Math.abs(g - seed.g),
          Math.abs(b - seed.b)
        );

        lumas.push(l);
        sumL += l;
        sumL2 += l * l;
        sumSat += sat;
        if (sat <= 24) neutralCount++;
        if (sat <= 24 && delta <= 30) nearSeedCount++;
        if (sat <= 18 && delta <= 14) strongSeedCount++;
        if (Math.abs(l - l2) > 18) edgeCount++;
        n++;
      }
    } else {
      const x = side === 'left' ? offset : (w - 1 - offset);
      const innerX = side === 'left'
        ? Math.min(w - 1, x + 1)
        : Math.max(0, x - 1);

      for (let y = 0; y < h; y++) {
        const idx = (y * w + x) * 4;
        const idx2 = (y * w + innerX) * 4;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const r2 = data[idx2];
        const g2 = data[idx2 + 1];
        const b2 = data[idx2 + 2];

        const l = rgbToLuma(r, g, b);
        const l2 = rgbToLuma(r2, g2, b2);
        const sat = rgbToSaturation(r, g, b);
        const delta = Math.max(
          Math.abs(r - seed.r),
          Math.abs(g - seed.g),
          Math.abs(b - seed.b)
        );

        lumas.push(l);
        sumL += l;
        sumL2 += l * l;
        sumSat += sat;
        if (sat <= 24) neutralCount++;
        if (sat <= 24 && delta <= 30) nearSeedCount++;
        if (sat <= 18 && delta <= 14) strongSeedCount++;
        if (Math.abs(l - l2) > 18) edgeCount++;
        n++;
      }
    }

    lumas.sort((a, b) => a - b);

    const meanL = n ? sumL / n : 0;
    const variance = n ? (sumL2 / n) - (meanL * meanL) : 0;

    return {
      meanL,
      stdL: Math.sqrt(Math.max(0, variance)),
      meanSat: n ? sumSat / n : 0,
      edgeDensity: n ? edgeCount / n : 0,
      neutralCoverage: n ? neutralCount / n : 0,
      nearSeedCoverage: n ? nearSeedCount / n : 0,
      strongSeedCoverage: n ? strongSeedCount / n : 0,
      q10: quantileSorted(lumas, 0.10),
      q25: quantileSorted(lumas, 0.25),
      q50: quantileSorted(lumas, 0.50),
      q75: quantileSorted(lumas, 0.75),
      q90: quantileSorted(lumas, 0.90),
    };
  }

  function scoreBorderLine(stats, seed) {
    const seedIsExtreme = seed.luma >= 220 || seed.luma <= 35;

    const strongSeedScore = stats.strongSeedCoverage;
    const nearSeedScore = stats.nearSeedCoverage;
    const neutralScore = stats.neutralCoverage;
    const stdScore = clamp01(1 - (stats.stdL / (seedIsExtreme ? 28 : 14)));
    const edgeScore = clamp01(1 - (stats.edgeDensity / (seedIsExtreme ? 0.18 : 0.10)));
    const q75Score = clamp01(1 - (Math.abs(stats.q75 - seed.luma) / (seedIsExtreme ? 24 : 16)));
    const q50Score = clamp01(1 - (Math.abs(stats.q50 - seed.luma) / (seedIsExtreme ? 52 : 30)));

    const directSeedMix = (
      (strongSeedScore * 0.28) +
      (nearSeedScore * 0.30) +
      (neutralScore * 0.12) +
      (stdScore * 0.12) +
      (edgeScore * 0.08) +
      (q75Score * 0.06) +
      (q50Score * 0.04)
    );

    const neutralBandMix = (
      (neutralScore * 0.38) +
      (q75Score * 0.28) +
      (q50Score * 0.16) +
      (stdScore * 0.10) +
      (edgeScore * 0.08)
    );

    return Math.max(directSeedMix, neutralBandMix);
  }

  function evaluateBorderBoundary(statsList, depth) {
    if (!depth || depth >= statsList.length) return 0;

    const borderStats = averageLineStats(statsList.slice(Math.max(0, depth - 2), depth));
    const innerStats = averageLineStats(statsList.slice(depth, Math.min(statsList.length, depth + 4)));
    if (!borderStats || !innerStats) return 0;

    const q50Delta = Math.abs(innerStats.q50 - borderStats.q50);
    const q75Delta = Math.abs(innerStats.q75 - borderStats.q75);
    const neutralDrop = Math.max(0, borderStats.neutralCoverage - innerStats.neutralCoverage);
    const satRise = Math.max(0, innerStats.meanSat - borderStats.meanSat);
    const edgeRise = Math.max(0, innerStats.edgeDensity - borderStats.edgeDensity);

    return clamp01(
      (clamp01(q50Delta / 34) * 0.26) +
      (clamp01(q75Delta / 22) * 0.16) +
      (clamp01(neutralDrop / 0.42) * 0.18) +
      (clamp01(satRise / 22) * 0.12) +
      (clamp01(edgeRise / 0.28) * 0.28)
    );
  }

  function averageLineStats(statsList) {
    if (!statsList || !statsList.length) return null;
    const sum = statsList.reduce((acc, stats) => {
      for (const key of [
        'meanL', 'stdL', 'meanSat', 'edgeDensity',
        'neutralCoverage', 'nearSeedCoverage', 'strongSeedCoverage',
        'q10', 'q25', 'q50', 'q75', 'q90'
      ]) {
        acc[key] += stats[key] || 0;
      }
      return acc;
    }, {
      meanL: 0,
      stdL: 0,
      meanSat: 0,
      edgeDensity: 0,
      neutralCoverage: 0,
      nearSeedCoverage: 0,
      strongSeedCoverage: 0,
      q10: 0,
      q25: 0,
      q50: 0,
      q75: 0,
      q90: 0,
    });

    const n = statsList.length;
    for (const key of Object.keys(sum)) {
      sum[key] /= n;
    }
    return sum;
  }

  function quantileSorted(values, q) {
    if (!values.length) return 0;
    if (values.length === 1) return values[0];
    const pos = (values.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = values[Math.min(values.length - 1, base + 1)];
    return values[base] + ((next - values[base]) * rest);
  }

  function medianOf(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function computeWeightedRisk(clipPct, nearPct) {
    const haloPct = Math.max(0, nearPct - clipPct);
    return clipPct + (haloPct * 0.35);
  }

  function rgbToLuma(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function rgbToSaturation(r, g, b) {
    return Math.max(r, g, b) - Math.min(r, g, b);
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  async function decodeImageRenderable(blob) {
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(blob);
      } catch (_) {}
    }

    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Image decode failed'));
      };

      img.src = url;
    });
  }

  function buildOverlayText(exif, img, resource) {
    const camera = formatCamera(exif);
    const lens = formatLens(exif);
    const focalInfo = getFocalDisplayInfo(exif, lens);

    const shutter = formatShutter(exif?.ExposureTime);
    const aperture = formatAperture(exif?.FNumber);
    const iso = formatISO(exif?.ISO);
    const date = formatDate(exif?.DateTimeOriginal || exif?.CreateDate);
    const formatInfo = buildFormatInfo(img, resource);

    const parts = [];
    if (camera) parts.push(camera);
    if (lens) parts.push(lens);
    if (focalInfo.text) parts.push(focalInfo.text);
    if (shutter) parts.push(shutter);
    if (aperture) parts.push(aperture);
    if (iso) parts.push(iso);
    if (date) parts.push(date);
    if (formatInfo) parts.push(formatInfo);

    return parts.filter(Boolean).join(' | ');
  }

  function buildFormatInfo(img, resource) {
    const format = normalizeFormatLabel(resource?.mime);
    const w = img?.naturalWidth || 0;
    const h = img?.naturalHeight || 0;

    if (format && w && h) return `${format} ${w}×${h}`;
    if (format) return format;
    if (w && h) return `${w}×${h}`;
    return '';
  }

  function shouldPreferPinnedOverlay(img) {
    if (!img) return false;

    const rect = img.getBoundingClientRect();
    if (rect.width < CONFIG.forceTooltipWidth || rect.height < CONFIG.forceTooltipHeight) return false;

    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const widthRatio = rect.width / viewportWidth;
    const heightRatio = rect.height / viewportHeight;
    const areaRatio = (rect.width * rect.height) / (viewportWidth * viewportHeight);

    if (
      widthRatio >= CONFIG.fullscreenOverlayViewportRatio ||
      heightRatio >= CONFIG.fullscreenOverlayViewportRatio ||
      areaRatio >= CONFIG.fullscreenOverlayAreaRatio
    ) {
      return true;
    }

    let node = img.parentElement;
    let depth = 0;

    while (node && depth < 8 && node !== document.body) {
      const signature = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''} ${node.getAttribute('role') || ''}`.toLowerCase();
      if (/modal|dialog|viewer|lightbox|imageview|photoswipe|pswp|fancybox|magnific|zoom/.test(signature)) {
        return true;
      }

      const cs = getComputedStyle(node);
      if (cs.position === 'fixed') return true;

      node = node.parentElement;
      depth += 1;
    }

    return false;
  }

  function setTextLayoutClasses(el, layout = null) {
    const multiline = !!(layout && layout.multiline);
    el.classList.toggle('tm-multiline', multiline);
  }

  function chooseTextPresentation(img, text) {
    const rect = img.getBoundingClientRect();
    const availableOverlayWidth = Math.max(80, rect.width - CONFIG.overlayMargin * 2);
    const overlayNaturalWidth = measureSingleLineWidth(text);
    const preferPinnedOverlay = shouldPreferPinnedOverlay(img);
    const overlayOverflowsImage = overlayNaturalWidth > availableOverlayWidth;

    if (preferPinnedOverlay) {
      const wrappedWidth = Math.min(
        availableOverlayWidth,
        Math.max(
          Math.min(availableOverlayWidth, CONFIG.tooltipMinWidth),
          Math.min(chooseTooltipWidth(text, rect), Math.floor(rect.width * 0.92))
        )
      );

      return {
        mode: 'overlay',
        width: overlayOverflowsImage ? wrappedWidth : Math.min(overlayNaturalWidth, availableOverlayWidth),
        multiline: overlayOverflowsImage,
        pinnedTop: true,
      };
    }

    const forceTooltip =
      rect.width < CONFIG.forceTooltipWidth ||
      rect.height < CONFIG.forceTooltipHeight;

    if (!forceTooltip) {
      const fitRatio = overlayNaturalWidth / availableOverlayWidth;
      if (fitRatio <= CONFIG.overlayFitThreshold) {
        return {
          mode: 'overlay',
          width: Math.min(overlayNaturalWidth, availableOverlayWidth),
          multiline: false,
          pinnedTop: false,
        };
      }
    }

    return {
      mode: 'tooltip',
      width: chooseTooltipWidth(text, rect),
      multiline: false,
      pinnedTop: false,
    };
  }

  function measureSingleLineWidth(text) {
    measureEl.style.whiteSpace = 'nowrap';
    measureEl.style.width = 'auto';
    measureEl.style.maxWidth = 'none';
    measureEl.textContent = text;
    return Math.ceil(measureEl.getBoundingClientRect().width);
  }

  function chooseTooltipWidth(text, rect) {
    const viewportMax = Math.min(CONFIG.tooltipMaxWidth, window.innerWidth - 24);
    const preferred = Math.max(
      CONFIG.tooltipMinWidth,
      Math.min(viewportMax, Math.floor(rect.width * 1.25))
    );

    measureEl.style.whiteSpace = 'normal';
    measureEl.style.width = `${preferred}px`;
    measureEl.style.maxWidth = `${preferred}px`;
    measureEl.textContent = text;

    return Math.min(viewportMax, Math.max(CONFIG.tooltipMinWidth, preferred));
  }

  function showTextUI(text, img, layout, muted = false) {
    hideTextUI();

    activeText = text;
    activeTextMode = layout.mode;

    const el = layout.mode === 'overlay' ? overlayEl : tooltipEl;
    const otherEl = layout.mode === 'overlay' ? tooltipEl : overlayEl;

    setTextLayoutClasses(el, layout);
    setTextLayoutClasses(otherEl, null);

    el.textContent = text;
    el.classList.toggle('tm-muted', muted);

    if (layout.mode === 'overlay') {
      applyOverlayPosition(el, img, layout.width, layout);
    } else {
      applyTooltipPosition(el, img, layout.width);
    }

    el.classList.add('tm-visible');
  }

  function hideTextUI() {
    overlayEl.classList.remove('tm-visible');
    tooltipEl.classList.remove('tm-visible');
    overlayEl.classList.remove('tm-muted');
    tooltipEl.classList.remove('tm-muted');
    setTextLayoutClasses(overlayEl, null);
    setTextLayoutClasses(tooltipEl, null);
    activeText = '';
    activeTextMode = null;
  }

  function applyOverlayPosition(el, img, width, layout = null) {
    const rect = img.getBoundingClientRect();
    const margin = CONFIG.overlayMargin;
    const maxWidth = Math.max(80, rect.width - margin * 2);
    const preferPinnedTop = !!(layout && layout.pinnedTop);

    const left = clamp(rect.left + margin, 6, window.innerWidth - 24);

    el.style.width = width ? `${Math.min(width, maxWidth)}px` : 'auto';
    el.style.maxWidth = `${Math.min(maxWidth, window.innerWidth - left - 12)}px`;

    const overlayRect = measureLiveRect(el);
    const minTop = clamp(rect.top + margin, 6, window.innerHeight - overlayRect.height - 8);
    const maxPinnedTop = clamp(
      rect.top + Math.min(CONFIG.fullscreenOverlayMaxTopShift, Math.max(margin, rect.height * 0.16)),
      minTop,
      Math.max(minTop, rect.bottom - overlayRect.height - margin)
    );

    let top = minTop;

    if (!preferPinnedTop) {
      const candidateRect = {
        left,
        top,
        right: left + overlayRect.width,
        bottom: top + overlayRect.height,
        width: overlayRect.width,
        height: overlayRect.height,
      };

      for (const blocker of getOcclusionRects()) {
        if (!rectsOverlap(candidateRect, blocker, 0)) continue;

        const shiftedTop = Math.max(top, blocker.bottom + margin);
        top = shiftedTop;
        candidateRect.top = top;
        candidateRect.bottom = top + overlayRect.height;
      }

      top = clamp(top, 6, window.innerHeight - overlayRect.height - 8);
    } else {
      top = minTop;
    }

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function applyTooltipPosition(el, img, width) {
    const rect = img.getBoundingClientRect();
    const gap = CONFIG.tooltipGap;

    el.style.width = `${width}px`;
    el.style.maxWidth = `${Math.min(width, window.innerWidth - 24)}px`;

    const tooltipRect = measureLiveRect(el);
    const blockers = getOcclusionRects();
    const best = chooseBestFloatingRect([
      { left: rect.left, top: rect.top - tooltipRect.height - gap },
      { left: rect.left, top: rect.bottom + gap },
      { left: rect.right + gap, top: rect.top },
      { left: rect.left - width - gap, top: rect.top },
      { left: rect.right - width, top: rect.bottom + gap },
      { left: rect.right - width, top: rect.top - tooltipRect.height - gap },
      { left: rect.left, top: rect.top },
    ], width, tooltipRect.height, blockers, 6);

    el.style.left = `${best ? best.left : 8}px`;
    el.style.top = `${best ? best.top : 8}px`;
  }

  function resetHistogramPanelState() {
    histPanelEl.meta.textContent = '';
    histPanelEl.loading.textContent = '히스토그램 계산 중...';
    histPanelEl.loading.style.display = 'none';
    histPanelEl.canvas.style.display = 'none';
    histPanelEl.shadow.textContent = '';
    histPanelEl.highlight.textContent = '';
    histPanelEl.note.style.display = 'none';
  }

  function resetGpsPanelState() {
    gpsPanelEl.meta.textContent = '';
    gpsPanelEl.coordsValue.textContent = '';
    gpsPanelEl.altitudeValue.textContent = '';
    gpsPanelEl.directionValue.textContent = '';
    gpsPanelEl.coordsRow.style.display = 'none';
    gpsPanelEl.altitudeRow.style.display = 'none';
    gpsPanelEl.directionRow.style.display = 'none';
    gpsPanelEl.links.style.display = 'none';
    gpsPanelEl.naverLink.removeAttribute('href');
    gpsPanelEl.kakaoLink.removeAttribute('href');
    gpsPanelEl.googleLink.removeAttribute('href');
    drawGpsMapPlaceholder(gpsPanelEl.mapCanvas);
  }

  function sameRectApprox(a, b, tolerance = 1) {
    if (!a || !b) return false;
    return (
      Math.abs(a.left - b.left) <= tolerance &&
      Math.abs(a.top - b.top) <= tolerance &&
      Math.abs(a.width - b.width) <= tolerance &&
      Math.abs(a.height - b.height) <= tolerance
    );
  }

  function calculateGpsPanelPosition(img) {
    const rect = img.getBoundingClientRect();
    const panelRect = measureLiveRect(gpsPanelEl.root);
    const gap = CONFIG.gpsGap;
    const blockers = getOcclusionRects();
    const visibleRects = getVisibleRectsForControls();
    const histRect = histPanelEl.root.classList.contains('tm-visible')
      ? toPlainRect(histPanelEl.root.getBoundingClientRect())
      : null;

    if (histRect) {
      const avoidRects = [
        ...visibleRects.filter((candidate) => !sameRectApprox(candidate, histRect)),
        ...blockers,
      ];

      const histAnchored = chooseBestFloatingRect([
        { left: histRect.left, top: histRect.bottom + gap },
        { left: histRect.right - panelRect.width, top: histRect.bottom + gap },
        { left: histRect.left, top: histRect.top - panelRect.height - gap },
        { left: histRect.right - panelRect.width, top: histRect.top - panelRect.height - gap },
      ], panelRect.width, panelRect.height, avoidRects, 6);

      if (histAnchored) {
        return {
          left: histAnchored.left,
          top: histAnchored.top,
          width: panelRect.width,
          height: panelRect.height,
        };
      }
    }

    const avoidRects = [
      ...visibleRects,
      ...blockers,
    ];

    const best = chooseBestFloatingRect([
      { left: rect.left, top: rect.bottom + gap },
      { left: rect.right - panelRect.width, top: rect.bottom + gap },
      { left: rect.left, top: rect.top - panelRect.height - gap },
      { left: rect.right - panelRect.width, top: rect.top - panelRect.height - gap },
      { left: rect.right + gap, top: rect.top },
      { left: rect.left - panelRect.width - gap, top: rect.top },
      { left: rect.left + 8, top: rect.bottom - panelRect.height - 8 },
    ], panelRect.width, panelRect.height, avoidRects, 6);

    return {
      left: best ? best.left : 8,
      top: best ? best.top : 8,
      width: panelRect.width,
      height: panelRect.height,
    };
  }

  function positionGpsPanel(img) {
    const pos = calculateGpsPanelPosition(img);
    gpsPanelEl.root.style.left = `${pos.left}px`;
    gpsPanelEl.root.style.top = `${pos.top}px`;
  }

  function calculateHistogramPanelPosition(img) {
    const rect = img.getBoundingClientRect();
    const panelRect = measureLiveRect(histPanelEl.root);
    const gap = CONFIG.histGap;
    const blockers = getOcclusionRects();
    const best = chooseBestFloatingRect([
      { left: rect.right + gap, top: rect.top },
      { left: rect.left - panelRect.width - gap, top: rect.top },
      { left: rect.left, top: rect.bottom + gap },
      { left: rect.left, top: rect.top - panelRect.height - gap },
      { left: rect.right - panelRect.width, top: rect.bottom + gap },
      { left: rect.right - panelRect.width, top: rect.top - panelRect.height - gap },
      { left: rect.right - panelRect.width - 8, top: rect.bottom - panelRect.height - 8 },
    ], panelRect.width, panelRect.height, blockers, 6);

    return {
      left: best ? best.left : 8,
      top: best ? best.top : 8,
      width: panelRect.width,
      height: panelRect.height,
    };
  }

  function positionHistogramPanel(img) {
    const pos = calculateHistogramPanelPosition(img);
    histPanelEl.root.style.left = `${pos.left}px`;
    histPanelEl.root.style.top = `${pos.top}px`;
  }

  function getVisibleRectsForControls() {
    const rects = [];

    if (overlayEl.classList.contains('tm-visible')) {
      rects.push(toPlainRect(overlayEl.getBoundingClientRect()));
    }

    if (tooltipEl.classList.contains('tm-visible')) {
      rects.push(toPlainRect(tooltipEl.getBoundingClientRect()));
    }

    if (histPanelEl.root.classList.contains('tm-visible')) {
      rects.push(toPlainRect(histPanelEl.root.getBoundingClientRect()));
    }

    if (gpsPanelEl.root.classList.contains('tm-visible')) {
      rects.push(toPlainRect(gpsPanelEl.root.getBoundingClientRect()));
    }

    return rects.filter((rect) => rect && rect.width > 0 && rect.height > 0);
  }

  function toPlainRect(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  function rectsOverlap(a, b, pad = 0) {
    return !(
      a.right + pad <= b.left ||
      a.left - pad >= b.right ||
      a.bottom + pad <= b.top ||
      a.top - pad >= b.bottom
    );
  }

  function getOverlapArea(a, b, pad = 0) {
    const left = Math.max(a.left - pad, b.left);
    const right = Math.min(a.right + pad, b.right);
    const top = Math.max(a.top - pad, b.top);
    const bottom = Math.min(a.bottom + pad, b.bottom);
    const w = Math.max(0, right - left);
    const h = Math.max(0, bottom - top);
    return w * h;
  }

  function isManagedUiElement(el) {
    return !!(
      el &&
      el instanceof Element &&
      el.closest('.tm-exif-overlay, .tm-exif-tooltip, .tm-exif-measure, .tm-exif-controls, .tm-exif-hist-panel, .tm-exif-gps-panel, .tm-exif-btn-tooltip')
    );
  }

  function getOcclusionRects() {
    const maxX = Math.max(1, window.innerWidth - 1);
    const maxY = Math.max(1, window.innerHeight - 1);
    const xs = [0.08, 0.24, 0.5, 0.76, 0.92]
      .map((ratio) => clamp(Math.round(window.innerWidth * ratio), 1, maxX));
    const ys = [2, 18, 40, 72]
      .filter((y) => y < Math.min(160, window.innerHeight - 2));

    const found = new Set();

    for (const x of xs) {
      for (const y of ys) {
        const stack = document.elementsFromPoint(x, y);
        for (const el of stack) {
          if (!(el instanceof Element)) continue;
          if (isManagedUiElement(el)) continue;

          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;

          const rect = el.getBoundingClientRect();
          if (rect.width < window.innerWidth * 0.15 || rect.height < 24) continue;
          if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
          if (rect.top > Math.max(96, window.innerHeight * 0.18)) continue;

          found.add(el);
          break;
        }
      }
    }

    return Array.from(found)
      .map((el) => toPlainRect(el.getBoundingClientRect()))
      .filter((rect) => rect && rect.width > 0 && rect.height > 0);
  }

  function chooseBestFloatingRect(candidates, width, height, avoidRects = [], pad = 0) {
    let best = null;

    for (let i = 0; i < candidates.length; i++) {
      const clamped = {
        left: clamp(candidates[i].left, 8, window.innerWidth - width - 8),
        top: clamp(candidates[i].top, 8, window.innerHeight - height - 8),
      };

      const candidateRect = {
        left: clamped.left,
        top: clamped.top,
        right: clamped.left + width,
        bottom: clamped.top + height,
        width,
        height,
      };

      let overlapCount = 0;
      let overlapArea = 0;

      for (const avoidRect of avoidRects) {
        if (rectsOverlap(candidateRect, avoidRect, pad)) {
          overlapCount += 1;
          overlapArea += getOverlapArea(candidateRect, avoidRect, pad);
        }
      }

      const score = {
        overlapCount,
        overlapArea,
        priority: i,
        left: clamped.left,
        top: clamped.top,
      };

      if (
        !best ||
        score.overlapCount < best.overlapCount ||
        (score.overlapCount === best.overlapCount && score.overlapArea < best.overlapArea) ||
        (score.overlapCount === best.overlapCount && score.overlapArea === best.overlapArea && score.priority < best.priority)
      ) {
        best = score;
        if (score.overlapCount === 0 && score.overlapArea === 0) break;
      }
    }

    return best;
  }

  function positionControls(img) {
    if (!img) return;

    updateControlTexts();

    const controlsRect = measureLiveRect(controlsEl.root);
    const rect = img.getBoundingClientRect();
    const inset = CONFIG.controlsInset;
    const gap = CONFIG.controlsGap;
    const avoidPad = CONFIG.controlsAvoidGap;
    const avoidRects = [
      ...getVisibleRectsForControls(),
      ...getOcclusionRects(),
    ];

    const candidates = [
      { left: rect.right - controlsRect.width - inset, top: rect.bottom - controlsRect.height - inset },
      { left: rect.left + inset, top: rect.bottom - controlsRect.height - inset },
      { left: rect.right - controlsRect.width - inset, top: rect.top + inset },
      { left: rect.left + inset, top: rect.top + inset },
      { left: rect.right - controlsRect.width, top: rect.top - controlsRect.height - gap },
      { left: rect.left, top: rect.top - controlsRect.height - gap },
      { left: rect.right - controlsRect.width, top: rect.bottom + gap },
      { left: rect.left, top: rect.bottom + gap },
    ];

    let best = null;

    for (let i = 0; i < candidates.length; i++) {
      const clamped = {
        left: clamp(candidates[i].left, 8, window.innerWidth - controlsRect.width - 8),
        top: clamp(candidates[i].top, 8, window.innerHeight - controlsRect.height - 8),
      };

      const candidateRect = {
        left: clamped.left,
        top: clamped.top,
        right: clamped.left + controlsRect.width,
        bottom: clamped.top + controlsRect.height,
        width: controlsRect.width,
        height: controlsRect.height,
      };

      let overlapCount = 0;
      let overlapArea = 0;

      for (const avoidRect of avoidRects) {
        if (rectsOverlap(candidateRect, avoidRect, avoidPad)) {
          overlapCount++;
          overlapArea += getOverlapArea(candidateRect, avoidRect, avoidPad);
        }
      }

      const score = {
        overlapCount,
        overlapArea,
        priority: i,
        left: clamped.left,
        top: clamped.top,
      };

      if (
        !best ||
        score.overlapCount < best.overlapCount ||
        (score.overlapCount === best.overlapCount && score.overlapArea < best.overlapArea) ||
        (score.overlapCount === best.overlapCount && score.overlapArea === best.overlapArea && score.priority < best.priority)
      ) {
        best = score;
        if (score.overlapCount === 0 && score.overlapArea === 0) break;
      }
    }

    controlsEl.root.style.left = `${best ? best.left : 8}px`;
    controlsEl.root.style.top = `${best ? best.top : 8}px`;
  }

  function showControls() {
    controlsEl.root.classList.add('tm-visible');
  }

  function hideControls() {
    controlsEl.root.classList.remove('tm-visible');
    hideControlTooltip();
  }

  async function onToggleGpsClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (!activeImage || !activeGpsData) return;

    gpsPanelOpen = !gpsPanelOpen;
    updateControlTexts();

    if (gpsPanelOpen) {
      renderGpsPanel(activeGpsData, activeImage);
    } else {
      hideGpsPanel(true);
      if (isActiveZoneHovered()) {
        showControls();
        positionControls(activeImage);
      } else {
        hideAll();
      }
    }
  }

  function onGpsPanelCloseClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (!activeImage) {
      hideAll();
      return;
    }

    auxHover = false;
    gpsPanelOpen = false;
    updateControlTexts();
    hideGpsPanel(true);

    if (isActiveZoneHovered()) {
      showControls();
      positionControls(activeImage);
    } else {
      hideAll();
    }
  }

  async function onToggleHistogramClick(event) {
    event.preventDefault();
    event.stopPropagation();

    histogramEnabled = !histogramEnabled;
    persistBool(STORAGE_KEYS.histogramEnabled, histogramEnabled);
    updateControlTexts();

    if (!activeImage) return;

    if (histogramEnabled) {
      resetHistogramPanelState();
      hideHistogramPanel(true);
      positionControls(activeImage);
      const token = getState(activeImage).token;
      void ensureHistogramVisibleForCurrentImage(token);
    } else {
      hideHistogramPanel(true);
      positionControls(activeImage);
    }
  }


  async function ensureHistogramVisibleForCurrentImage(token) {
    if (!activeImage || !histogramEnabled) return;

    const img = activeImage;
    const url = getImageUrl(img);
    if (!url) return;

    resetHistogramPanelState();
    hideHistogramPanel(true);
    positionControls(img);

    let hist = null;
    try {
      hist = await getHistogram(url);
    } catch (_) {}

    if (!activeImage || activeImage !== img) return;
    if (getState(img).token !== token) return;
    if (!histogramEnabled) return;

    if (!hist) {
      hideHistogramPanel(true);
      positionControls(img);
      return;
    }

    renderHistogramPanel(hist, img);
  }

  function renderHistogramPanel(hist, img) {
    histPanelEl.meta.textContent = `${hist.sampledWidth}×${hist.sampledHeight} 샘플`;
    histPanelEl.loading.style.display = 'none';
    histPanelEl.canvas.style.display = 'block';

    drawHistogram(histPanelEl.canvas, hist);

    const shadowState = clipState(hist.shadowClipPct);
    const highlightState = clipState(hist.highlightClipPct);

    histPanelEl.shadow.textContent = `암부 ${shadowState} ${hist.shadowClipPct.toFixed(1)}%`;
    histPanelEl.highlight.textContent = `하이라이트 ${highlightState} ${hist.highlightClipPct.toFixed(1)}%`;
    histPanelEl.note.textContent = hist.borderTrimmed ? '사진 본문 기준 · 테두리 제외' : '표시 이미지 기준';
    histPanelEl.note.style.display = '';

    positionHistogramPanel(img);
    histPanelEl.root.classList.add('tm-visible');
    positionControls(img);
  }

  function renderGpsPanel(gps, img) {
    if (!gps) return;

    resetGpsPanelState();

    gpsPanelEl.meta.textContent = '';
    gpsPanelEl.coordsValue.textContent = `${formatCoordinate(gps.latitude)}, ${formatCoordinate(gps.longitude)}`;
    gpsPanelEl.coordsRow.style.display = '';

    if (Number.isFinite(gps.altitude)) {
      gpsPanelEl.altitudeValue.textContent = `${stripTrailingZero(gps.altitude)}m`;
      gpsPanelEl.altitudeRow.style.display = '';
    }

    if (Number.isFinite(gps.direction)) {
      gpsPanelEl.directionValue.textContent = `${stripTrailingZero(normalizeBearing(gps.direction))}°`;
      gpsPanelEl.directionRow.style.display = '';
    }

    const naverHref = buildNaverMapHref(gps.latitude, gps.longitude);
    const kakaoHref = buildKakaoMapHref(gps.latitude, gps.longitude);
    const googleHref = buildGoogleMapsHref(gps.latitude, gps.longitude);

    if (naverHref) gpsPanelEl.naverLink.href = naverHref;
    if (kakaoHref) gpsPanelEl.kakaoLink.href = kakaoHref;
    if (googleHref) gpsPanelEl.googleLink.href = googleHref;

    if (naverHref || kakaoHref || googleHref) {
      gpsPanelEl.links.style.display = '';
    }

    const renderSeq = String(Date.now()) + '_' + Math.random().toString(36).slice(2, 7);
    gpsPanelEl.root.dataset.mapSeq = renderSeq;
    drawGpsMapPlaceholder(gpsPanelEl.mapCanvas);

    positionGpsPanel(img);
    gpsPanelEl.root.classList.add('tm-visible');
    positionControls(img);

    void renderGpsMiniMap(gps, renderSeq, img);
  }

  async function renderGpsMiniMap(gps, renderSeq, img) {
    if (!gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) return;

    const canvas = gpsPanelEl.mapCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      const specs = buildMiniMapTileSpecs(gps.latitude, gps.longitude, CONFIG.gpsMapZoom, canvas.width, canvas.height);
      const tiles = await Promise.all(specs.map(async (spec) => ({
        ...spec,
        image: await getMapTileImage(spec.url),
      })));

      if (!activeImage || activeImage !== img) return;
      if (!gpsPanelOpen) return;
      if (gpsPanelEl.root.dataset.mapSeq !== renderSeq) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#111318';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const tile of tiles) {
        ctx.drawImage(tile.image, tile.drawX, tile.drawY, 256, 256);
      }

      drawGpsMapMarker(ctx, canvas.width, canvas.height);
    } catch (_) {
      if (gpsPanelEl.root.dataset.mapSeq !== renderSeq) return;
      drawGpsMapPlaceholder(canvas, true);
    }
  }

  function buildMiniMapTileSpecs(latitude, longitude, zoom, width, height) {
    const worldSize = Math.pow(2, zoom);
    const xFloat = ((longitude + 180) / 360) * worldSize;
    const latRad = latitude * Math.PI / 180;
    const mercator = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const yFloat = (1 - mercator / Math.PI) / 2 * worldSize;

    const baseTileX = Math.floor(xFloat);
    const baseTileY = Math.floor(yFloat);
    const fracX = (xFloat - baseTileX) * 256;
    const fracY = (yFloat - baseTileY) * 256;
    const baseDrawX = width / 2 - fracX;
    const baseDrawY = height / 2 - fracY;

    const tiles = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const tileX = wrapTileX(baseTileX + dx, zoom);
        const tileY = clamp(baseTileY + dy, 0, worldSize - 1);
        tiles.push({
          url: `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`,
          drawX: Math.round(baseDrawX + dx * 256),
          drawY: Math.round(baseDrawY + dy * 256),
        });
      }
    }

    return tiles;
  }

  function wrapTileX(x, zoom) {
    const size = Math.pow(2, zoom);
    return ((x % size) + size) % size;
  }

  async function getMapTileImage(url) {
    if (mapTileCache.has(url)) return mapTileCache.get(url);

    const promise = (async () => {
      try {
        return await loadImageElement(url);
      } catch (_) {
        const dataUrl = await fetchAsDataUrl(url, 'image/png');
        return await loadImageElement(dataUrl);
      }
    })().catch((error) => {
      mapTileCache.delete(url);
      throw error;
    });

    mapTileCache.set(url, promise);
    return promise;
  }

  async function fetchAsDataUrl(url, fallbackMime = 'application/octet-stream') {
    return await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 12000,
        onload: async (res) => {
          try {
            if (!(res.status >= 200 && res.status < 400) || !res.response) {
              reject(new Error(`HTTP ${res.status}`));
              return;
            }

            const mime = getContentTypeFromHeaders(res.responseHeaders) || fallbackMime;
            const blob = new Blob([res.response], { type: mime });
            resolve(await blobToDataUrl(blob));
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error('GM_xmlhttpRequest failed')),
        ontimeout: () => reject(new Error('Map tile fetch timeout')),
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
      reader.readAsDataURL(blob);
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image element'));
      img.src = src;
    });
  }

  function drawGpsMapPlaceholder(canvas, failed = false) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, failed ? '#17181d' : '#16181d');
    grad.addColorStop(1, failed ? '#101116' : '#101218');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }

    drawGpsMapMarker(ctx, width, height, failed);
  }

  function drawGpsMapMarker(ctx, width, height, failed = false) {
    const x = width / 2;
    const y = height / 2;

    ctx.save();
    ctx.strokeStyle = failed ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.92)';
    ctx.fillStyle = failed ? 'rgba(255,255,255,0.76)' : 'rgba(255,255,255,0.96)';
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.arc(x, y, 5.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.beginPath();
    ctx.moveTo(x - 14, y);
    ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14);
    ctx.lineTo(x, y + 14);
    ctx.stroke();
    ctx.restore();
  }

  function hideGpsPanel(immediate = false) {
    if (immediate) {
      const prevTransition = gpsPanelEl.root.style.transition;
      gpsPanelEl.root.style.transition = 'none';
      gpsPanelEl.root.classList.remove('tm-visible');
      gpsPanelEl.root.style.opacity = '0';
      gpsPanelEl.root.style.transform = 'translateY(-4px)';
      gpsPanelEl.root.style.pointerEvents = 'none';
      void gpsPanelEl.root.offsetHeight;
      requestAnimationFrame(() => {
        gpsPanelEl.root.style.transition = prevTransition;
        gpsPanelEl.root.style.opacity = '';
        gpsPanelEl.root.style.transform = '';
        gpsPanelEl.root.style.pointerEvents = '';
      });
      return;
    }

    gpsPanelEl.root.classList.remove('tm-visible');
  }

  function hideHistogramPanel(immediate = false) {
    if (immediate) {
      const prevTransition = histPanelEl.root.style.transition;
      histPanelEl.root.style.transition = 'none';
      histPanelEl.root.classList.remove('tm-visible');
      histPanelEl.root.style.opacity = '0';
      histPanelEl.root.style.transform = 'translateY(-4px)';
      histPanelEl.root.style.pointerEvents = 'none';
      void histPanelEl.root.offsetHeight;
      requestAnimationFrame(() => {
        histPanelEl.root.style.transition = prevTransition;
        histPanelEl.root.style.opacity = '';
        histPanelEl.root.style.transform = '';
        histPanelEl.root.style.pointerEvents = '';
      });
      return;
    }

    histPanelEl.root.classList.remove('tm-visible');
  }

  function getHistogramCanvasCssWidth(canvas) {
    const wrap = canvas?.parentElement;
    if (wrap instanceof HTMLElement) {
      const width = Math.round(wrap.clientWidth);
      if (width > 0) return width;
    }
    return CONFIG.histCanvasWidth;
  }

  function drawHistogram(canvas, hist) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = getHistogramCanvasCssWidth(canvas);
    const cssH = CONFIG.histCanvasHeight;

    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    canvas.style.width = '100%';
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const displayL = smoothHistogramBins(hist.l, CONFIG.histDisplaySmoothingRadius);
    const displayR = smoothHistogramBins(hist.r, CONFIG.histDisplaySmoothingRadius);
    const displayG = smoothHistogramBins(hist.g, CONFIG.histDisplaySmoothingRadius);
    const displayB = smoothHistogramBins(hist.b, CONFIG.histDisplaySmoothingRadius);
    const reference = computeHistogramDisplayReference(
      [displayL, displayR, displayG, displayB],
      CONFIG.histDisplayPercentile
    );

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = Math.round((cssH / 4) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0.5, y);
      ctx.lineTo(cssW - 0.5, y);
      ctx.stroke();
    }

    drawFilledHistogramChannel(ctx, displayL, cssW, cssH, reference, 'rgba(255,255,255,0.14)', {
      lineColor: 'rgba(255,255,255,0.20)',
      lineWidth: 0.9,
    });

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    drawFilledHistogramChannel(ctx, displayR, cssW, cssH, reference, 'rgba(255, 84, 84, 0.30)', {
      lineColor: 'rgba(255, 105, 105, 0.92)',
      lineWidth: 1.0,
    });
    drawFilledHistogramChannel(ctx, displayG, cssW, cssH, reference, 'rgba(92, 255, 120, 0.30)', {
      lineColor: 'rgba(110, 255, 136, 0.92)',
      lineWidth: 1.0,
    });
    drawFilledHistogramChannel(ctx, displayB, cssW, cssH, reference, 'rgba(105, 160, 255, 0.30)', {
      lineColor: 'rgba(125, 175, 255, 0.92)',
      lineWidth: 1.0,
    });
    ctx.restore();
  }

  function drawFilledHistogramChannel(ctx, bins, w, h, reference, fillColor, options = {}) {
    const baseline = h - 1;

    ctx.beginPath();
    ctx.moveTo(0, baseline);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * (w - 1);
      const y = histogramValueToY(bins[i], h, reference);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w - 1, baseline);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    if (!options.lineColor) return;

    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * (w - 1);
      const y = histogramValueToY(bins[i], h, reference);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = options.lineColor;
    ctx.lineWidth = options.lineWidth || 1;
    ctx.stroke();
  }

  function histogramValueToY(value, h, reference) {
    const ref = Math.max(1, reference || 1);
    const normalized = clamp(value / ref, 0, 1);
    const curved = Math.pow(normalized, CONFIG.histDisplayGamma);
    return h - 1 - curved * (h - 4);
  }

  function computeHistogramDisplayReference(seriesList, percentile = 0.992) {
    const positive = [];
    let hardMax = 1;

    for (const bins of seriesList) {
      for (let i = 0; i < bins.length; i++) {
        const value = Number(bins[i]) || 0;
        if (value > 0) positive.push(value);
        if (value > hardMax) hardMax = value;
      }
    }

    if (!positive.length) return hardMax;

    positive.sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(positive.length - 1, Math.floor((positive.length - 1) * percentile)));
    const ref = positive[idx] || hardMax;
    return Math.max(1, Math.min(hardMax, ref));
  }

  function smoothHistogramBins(bins, radius = 1) {
    if (!radius || radius <= 0) return Array.from(bins);

    const out = new Float32Array(bins.length);
    for (let i = 0; i < bins.length; i++) {
      let sum = 0;
      let weightSum = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const idx = clamp(i + offset, 0, bins.length - 1);
        const weight = radius + 1 - Math.abs(offset);
        sum += (Number(bins[idx]) || 0) * weight;
        weightSum += weight;
      }
      out[i] = weightSum ? sum / weightSum : (Number(bins[i]) || 0);
    }
    return out;
  }

  function clipState(pct) {
    if (pct < 0.7) return 'Safe';
    if (pct < 3.0) return 'Mild';
    return 'Risk';
  }


  function repositionActiveUI() {
    if (!activeImage || !document.contains(activeImage)) {
      hideAll();
      return;
    }

    if (activeText && activeTextMode) {
      const layout = chooseTextPresentation(activeImage, activeText);
      if (layout.mode === 'overlay') {
        overlayEl.textContent = activeText;
        setTextLayoutClasses(overlayEl, layout);
        setTextLayoutClasses(tooltipEl, null);
        overlayEl.classList.add('tm-visible');
        tooltipEl.classList.remove('tm-visible');
        applyOverlayPosition(overlayEl, activeImage, layout.width, layout);
        activeTextMode = 'overlay';
      } else {
        tooltipEl.textContent = activeText;
        setTextLayoutClasses(overlayEl, null);
        setTextLayoutClasses(tooltipEl, null);
        tooltipEl.classList.add('tm-visible');
        overlayEl.classList.remove('tm-visible');
        applyTooltipPosition(tooltipEl, activeImage, layout.width);
        activeTextMode = 'tooltip';
      }
    }

    if (histogramEnabled && histPanelEl.root.classList.contains('tm-visible')) {
      positionHistogramPanel(activeImage);
    }

    if (gpsPanelOpen && gpsPanelEl.root.classList.contains('tm-visible') && activeGpsData) {
      positionGpsPanel(activeImage);
    }

    if (shouldPersistGpsPanel() && !isActiveZoneHovered()) {
      hideTextUI();
      hideControls();
      hideHistogramPanel(true);
      return;
    }

    positionControls(activeImage);
  }

  function hideAll() {
    if (activeImage) {
      const state = getState(activeImage);
      clearTimeout(state.refreshTimer);
    }

    hideTextUI();
    hideControls();
    hideHistogramPanel(true);
    hideGpsPanel(true);
    activeGpsData = null;
    gpsPanelOpen = false;
    auxHover = false;
    activeImage = null;
  }

  function measureLiveRect(el) {
    const prevVis = el.style.visibility;
    const prevOp = el.style.opacity;
    const prevLeft = el.style.left;
    const prevTop = el.style.top;
    const prevDisplay = el.style.display;

    el.style.visibility = 'hidden';
    el.style.opacity = '0';
    el.style.display = '';
    el.style.left = '0px';
    el.style.top = '0px';

    const rect = el.getBoundingClientRect();

    el.style.visibility = prevVis;
    el.style.opacity = prevOp;
    el.style.left = prevLeft;
    el.style.top = prevTop;
    el.style.display = prevDisplay;

    return rect;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function getContentTypeFromHeaders(headers = '') {
    const lines = headers.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^content-type:\s*([^;]+)/i);
      if (m) return m[1].trim();
    }
    return '';
  }

  function guessMimeFromUrl(url) {
    const clean = String(url).split('?')[0].split('#')[0].toLowerCase();
    if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
    if (clean.endsWith('.png')) return 'image/png';
    if (clean.endsWith('.webp')) return 'image/webp';
    if (clean.endsWith('.avif')) return 'image/avif';
    if (clean.endsWith('.gif')) return 'image/gif';
    if (clean.endsWith('.bmp')) return 'image/bmp';
    if (clean.endsWith('.tif') || clean.endsWith('.tiff')) return 'image/tiff';
    return '';
  }

  function normalizeFormatLabel(mime = '') {
    const m = String(mime).toLowerCase();
    if (m.includes('jpeg')) return 'JPEG';
    if (m.includes('png')) return 'PNG';
    if (m.includes('webp')) return 'WebP';
    if (m.includes('avif')) return 'AVIF';
    if (m.includes('gif')) return 'GIF';
    if (m.includes('bmp')) return 'BMP';
    if (m.includes('tiff')) return 'TIFF';
    return '';
  }

  function getCropFactor(exif) {
    const make = cleanText(exif?.Make).toLowerCase();
    const rawModel = cleanText(exif?.Model);
    const model = stripKnownMakePrefixes(rawModel);

    if (!model && !rawModel) return 1;

    if (make.includes('sony') || /^ILCE-|^DSC-/i.test(model)) {
      if (/^ILCE-6|^ILCE-5|^ZV-E10|^NEX-|^A6\d{3}/i.test(model)) return 1.5;
      if (/^ILCE-7|^ILCE-9|^ILCE-1|^DSC-RX1/i.test(model)) return 1.0;
      return 1.0;
    }

    if (make.includes('fujifilm')) {
      if (/^X-/i.test(model) || /^X[ASTHPE]\d/i.test(model)) return 1.5;
      if (/^GFX/i.test(model)) return 0.79;
      return 1.5;
    }

    if (make.includes('olympus') || make.includes('om digital') || make.includes('om system')) return 2.0;

    if (make.includes('panasonic')) {
      if (/^DC-GH|^DC-G9|^DMC-G|^LUMIX G/i.test(model)) return 2.0;
      if (/^DC-S|^LUMIX S/i.test(model)) return 1.0;
    }

    if (make.includes('canon')) {
      if (/EOS R[3568P]|EOS RP|EOS-1D|EOS 5D|EOS 6D/i.test(model)) return 1.0;
      if (/EOS R7|EOS R10|EOS R50|EOS R100|EOS 7D|EOS 90D|EOS 80D|EOS 70D|EOS 60D|EOS 850D|EOS 800D|EOS Kiss|EOS 250D|EOS 200D|EOS 1500D|EOS 3000D/i.test(model)) return 1.6;
    }

    if (make.includes('nikon')) {
      if (/^Z ?[56789f]/i.test(model) || /^D[45689]\d{2}/i.test(model) || /^Df$/i.test(model)) return 1.0;
      if (/^Z ?50/i.test(model) || /^D5\d{2}/i.test(model) || /^D7\d{2}0/i.test(model) || /^D3\d{2}0/i.test(model)) return 1.5;
    }

    if (make.includes('leica')) {
      if (/^Q|^SL|^M/i.test(model)) return 1.0;
      if (/^CL|^TL/i.test(model)) return 1.5;
    }

    return 1.0;
  }

  function romanToInt(token) {
    const map = {
      I: 1,
      II: 2,
      III: 3,
      IV: 4,
      V: 5,
      VI: 6,
      VII: 7,
      VIII: 8,
      IX: 9,
      X: 10,
    };
    return map[String(token || '').toUpperCase()] || null;
  }

  function compactBrandName(make, model) {
    const source = `${make || ''} ${model || ''}`.trim();
    if (/sony|\bILCE-|\bILME-|\bDSC-/i.test(source)) return 'Sony';
    if (/canon/i.test(source)) return 'Canon';
    if (/nikon/i.test(source)) return 'Nikon';
    if (/fujifilm/i.test(source)) return 'Fuji';
    if (/panasonic|lumix/i.test(source)) return 'Lumix';
    if (/om system|om digital|olympus/i.test(source)) return 'OM';
    if (/leica/i.test(source)) return 'Leica';
    if (/hasselblad/i.test(source)) return 'Hasselblad';
    return cleanText(make);
  }

  function stripKnownMakePrefixes(model) {
    return cleanText(model)
      .replace(/^NIKON CORPORATION\s+/i, '')
      .replace(/^NIKON\s+/i, '')
      .replace(/^Canon\s+/i, '')
      .replace(/^FUJIFILM\s+/i, '')
      .replace(/^Panasonic\s+/i, '')
      .replace(/^LUMIX\s+/i, '')
      .replace(/^OM SYSTEM\s+/i, '')
      .replace(/^OLYMPUS\s+/i, '')
      .replace(/^LEICA\s+/i, '')
      .replace(/^HASSELBLAD\s+/i, '')
      .replace(/^SONY\s+/i, '')
      .trim();
  }

  function compactSonyModel(model) {
    let compact = stripKnownMakePrefixes(model).toUpperCase();
    compact = compact.replace(/^ILCE-/, 'A').replace(/^ILME-/, '');
    compact = compact.replace(/^DSC-/, '');
    compact = compact.replace(/\s+/g, '');
    if (/^\d/.test(compact)) compact = `A${compact}`;
    if (/^7[A-Z0-9]/.test(compact)) compact = `A${compact}`;
    return compact;
  }

  function compactCanonModel(model) {
    let compact = stripKnownMakePrefixes(model);
    compact = compact.replace(/^EOS[-\s]*/i, '');
    compact = compact.replace(/\bMark\s+(II|III|IV|V|VI|VII|VIII|IX|X)\b/gi, (_, roman) => `M${romanToInt(roman) || ''}`);
    compact = compact.replace(/\bMARK\s+(\d+)\b/gi, (_, digits) => `M${digits}`);
    compact = compact.replace(/\s+/g, '');
    compact = compact.replace(/^-+/, '');
    return compact;
  }

  function compactNikonModel(model) {
    return stripKnownMakePrefixes(model)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactFujiModel(model) {
    let compact = stripKnownMakePrefixes(model)
      .replace(/\bMark\s+(II|III|IV|V|VI|VII|VIII|IX|X)\b/gi, (_, roman) => `M${romanToInt(roman) || ''}`)
      .replace(/\s+(II|III|IV|V|VI|VII|VIII|IX|X)$/i, (_, roman) => `M${romanToInt(roman) || ''}`)
      .trim();
    return compact;
  }

  function compactGenericModel(model) {
    return stripKnownMakePrefixes(model)
      .replace(/\bDIGITAL CAMERA\b/gi, '')
      .replace(/\bCORPORATION\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatCamera(exif) {
    const make = cleanText(exif?.Make);
    const model = cleanText(exif?.Model);

    if (!make && !model) return '';

    const brand = compactBrandName(make, model);
    let compactModel = '';

    if (brand === 'Sony') {
      compactModel = compactSonyModel(model);
    } else if (brand === 'Canon') {
      compactModel = compactCanonModel(model);
    } else if (brand === 'Nikon') {
      compactModel = compactNikonModel(model);
    } else if (brand === 'Fuji') {
      compactModel = compactFujiModel(model);
    } else {
      compactModel = compactGenericModel(model);
    }

    if (!compactModel) return brand || '';
    if (!brand) return compactModel;

    const normalizedBrand = brand.toLowerCase();
    if (compactModel.toLowerCase().startsWith(normalizedBrand + ' ')) return compactModel;

    return `${brand} ${compactModel}`.trim();
  }

  function formatLens(exif) {
    let lens = cleanText(exif?.LensModel);

    if (!lens && Array.isArray(exif?.LensSpecification) && exif.LensSpecification.length >= 4) {
      const [minFocal, maxFocal, minAperture, maxAperture] = exif.LensSpecification;
      if (minFocal && maxFocal) {
        lens = Math.round(minFocal) === Math.round(maxFocal)
          ? `${stripTrailingZero(minFocal)}mm`
          : `${stripTrailingZero(minFocal)}-${stripTrailingZero(maxFocal)}mm`;

        if (minAperture && maxAperture) {
          lens += Number(minAperture) === Number(maxAperture)
            ? ` F${stripTrailingZero(minAperture)}`
            : ` F${stripTrailingZero(minAperture)}-${stripTrailingZero(maxAperture)}`;
        }
      }
    }

    return lens;
  }

  function getFocalDisplayInfo(exif, lensModel = '') {
    const actualValue = toNumber(exif?.FocalLength);
    const embeddedEqValue = toNumber(exif?.FocalLengthIn35mmFilm);
    const cropFactor = getCropFactor(exif);

    const actualText = formatFocalLength(actualValue);
    const derivedEqValue = Number.isFinite(actualValue) && Number.isFinite(cropFactor) && cropFactor > 0
      ? actualValue * cropFactor
      : NaN;
    const chosenEqValue = Number.isFinite(embeddedEqValue)
      ? embeddedEqValue
      : (Number.isFinite(cropFactor) && Math.abs(cropFactor - 1) > 0.01 ? derivedEqValue : NaN);
    const eqText = formatFocalLength(chosenEqValue);

    const hasActual = !!actualText;
    const hasEq = !!eqText;
    const hasDistinctEq = hasActual && hasEq && Math.abs(chosenEqValue - actualValue) >= 0.4;
    const isZoom = isZoomLens(lensModel);
    const shouldShowActual = hasActual && (!lensModel || isZoom || hasDistinctEq);

    let text = '';
    if (shouldShowActual) {
      text = hasDistinctEq ? `${actualText} (${eqText} eq.)` : actualText;
    } else if (!lensModel && hasEq) {
      text = hasDistinctEq ? `${eqText} eq.` : eqText;
    }

    return {
      text,
      actualText,
      eqText,
      cropFactor,
      hasDistinctEq,
    };
  }

  function isZoomLens(lensModel) {
    if (!lensModel) return false;
    return /\b\d{1,3}(?:\.\d+)?\s*-\s*\d{1,3}(?:\.\d+)?\s*mm\b/i.test(lensModel);
  }

  function formatFocalLength(value) {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return '';
    return `${stripTrailingZero(n)}mm`;
  }

  function formatShutter(value) {
    if (value == null || value === '') return '';

    if (typeof value === 'string') {
      const v = value.trim();
      if (/^\d+\/\d+$/.test(v)) return `${v}s`;

      const num = Number(v);
      if (Number.isFinite(num)) return formatShutter(num);

      return v.endsWith('s') ? v : `${v}s`;
    }

    if (typeof value === 'number') {
      if (value <= 0) return '';
      if (value >= 1) return Number.isInteger(value) ? `${value}s` : `${value.toFixed(1)}s`;
      return `1/${Math.round(1 / value)}s`;
    }

    return '';
  }

  function formatAperture(value) {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return '';
    return `f/${n.toFixed(1)}`;
  }

  function formatISO(value) {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return '';
    return `ISO ${Math.round(n)}`;
  }

  function formatDate(value) {
    if (!value) return '';

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return formatDateObj(value);
    }

    const s = String(value).trim();
    const m = s.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;

    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return formatDateObj(d);

    return '';
  }

  function formatDateObj(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function cleanText(value) {
    if (value == null) return '';
    return String(value).replace(/\0/g, '').replace(/\s+/g, ' ').trim();
  }

  function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  function stripTrailingZero(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '';
    return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(1)));
  }

  function extractGpsInfo(exif) {
    if (!exif || typeof exif !== 'object') return null;

    const latitude = extractGpsCoordinate(
      exif.latitude,
      exif.GPSLatitude,
      exif.GPSLatitudeRef,
      'lat'
    );
    const longitude = extractGpsCoordinate(
      exif.longitude,
      exif.GPSLongitude,
      exif.GPSLongitudeRef,
      'lon'
    );

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    const altitude = firstFiniteNumber(exif.altitude, exif.GPSAltitude);
    const direction = firstFiniteNumber(exif.GPSImgDirection, exif.GPSDestBearing);

    return {
      latitude,
      longitude,
      altitude,
      direction,
    };
  }

  function extractGpsCoordinate(primary, fallback, ref, kind) {
    const direct = toNumber(primary);
    if (Number.isFinite(direct)) return direct;

    const parsed = parseGpsCoordinateValue(fallback);
    if (!Number.isFinite(parsed)) return NaN;

    const refText = cleanText(ref).toUpperCase();
    const sign = (
      (kind === 'lat' && refText === 'S') ||
      (kind === 'lon' && refText === 'W')
    ) ? -1 : 1;

    return parsed * sign;
  }

  function parseGpsCoordinateValue(value) {
    const direct = toNumber(value);
    if (Number.isFinite(direct)) return direct;

    if (Array.isArray(value) && value.length) {
      const nums = value.map((item) => toNumber(item)).filter((n) => Number.isFinite(n));
      if (!nums.length) return NaN;
      if (nums.length === 1) return nums[0];
      const deg = nums[0] || 0;
      const min = nums[1] || 0;
      const sec = nums[2] || 0;
      const sign = deg < 0 ? -1 : 1;
      return sign * (Math.abs(deg) + (min / 60) + (sec / 3600));
    }

    if (typeof value === 'string') {
      const nums = value.match(/-?\d+(?:\.\d+)?/g);
      if (!nums || !nums.length) return NaN;
      if (nums.length === 1) return Number(nums[0]);
      const deg = Number(nums[0]) || 0;
      const min = Number(nums[1]) || 0;
      const sec = Number(nums[2] || 0) || 0;
      const sign = deg < 0 ? -1 : 1;
      return sign * (Math.abs(deg) + (min / 60) + (sec / 3600));
    }

    return NaN;
  }

  function firstFiniteNumber(...values) {
    for (const value of values) {
      const n = toNumber(value);
      if (Number.isFinite(n)) return n;
    }
    return NaN;
  }

  function normalizeBearing(value) {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return NaN;
    const normalized = n % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  function formatCoordinate(value) {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return '';
    return n.toFixed(5);
  }

  function buildNaverMapHref(lat, lon) {
    const latitude = toNumber(lat);
    const longitude = toNumber(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
    return `https://map.naver.com/p/search/${encodeURIComponent(`${latitude},${longitude}`)}?c=15.00,0,0,0,dh`;
  }

  function buildKakaoMapHref(lat, lon) {
    const latitude = toNumber(lat);
    const longitude = toNumber(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
    return `https://map.kakao.com/link/map/${encodeURIComponent(`${latitude},${longitude}`)},${latitude},${longitude}`;
  }

  function buildGoogleMapsHref(lat, lon) {
    const latitude = toNumber(lat);
    const longitude = toNumber(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
    return `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
  }

  function loadPersistedBool(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return !!GM_getValue(key, fallback);
    } catch (_) {}

    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return raw === '1' || raw === 'true';
    } catch (_) {}

    return fallback;
  }

  function persistBool(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, !!value);
        return;
      }
    } catch (_) {}

    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch (_) {}
  }
})();