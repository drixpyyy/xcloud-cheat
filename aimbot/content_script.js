// content_script.js - Runs on Xcloud page

(async function () {
    'use strict';

    // --- Constants ---
    const SCRIPT_NAME = 'Xcloud Vision Assist Ext';
    const SCRIPT_VERSION = '0.1.0-alpha';
    const LOG_PREFIX = `[${SCRIPT_NAME} Content] `;
    const CONFIG_KEY = 'xcloudVisionAssistConfig_ext_v0_1';
    const POTENTIAL_VIDEO_SELECTORS = [
        'video[playsinline]',
        'video[src*="blob:"]',
        'video',
        'canvas[data-testid="game-stream-canvas"]',
        'canvas',
    ];
    const POTENTIAL_INPUT_TARGET_SELECTORS = [
        'div[data-testid="video-player-container"]',
        'div[aria-label*="stream"]',
        'div[role="application"]',
        '#game-stream',
    ];

    // --- Default Configuration ---
    const DEFAULT_CONFIG = {
        enabled: true,
        aimbotEnabled: true,
        autoShootEnabled: false,
        silentAimEnabled: false,
        aimKey: 'ShiftLeft',
        triggerBotEnabled: false,
        colorAimAssistEnabled: false, // New setting for color-based aim assist
        colorAimAssistKey: 'KeyL', // Key to toggle color aim assist ('L')
        colorAimAssistTargetColor: [255, 0, 0], // Target color (red in RGB)
        detection: {
            enabled: true, modelUrl: null, intervalMs: 120, confidenceThreshold: 0.55,
            targetClass: 'person', maxDetections: 10, useWorker: true, maxDistance: 800,
            visibilityCheck: true, resolutionScale: 0.75,
        },
        aiming: {
            fovRadius: 150, smoothing: 0.18, silentAimSmoothing: 0.06, predictionMs: 40,
            targetSelection: 'crosshair', hitbox: 'head', verticalOffset: 0.1,
        },
        visuals: {
            showFovCircle: true, fovColor: 'rgba(255, 0, 0, 0.3)', showCrosshair: true,
            crosshairSize: 10, crosshairColor: 'red', crosshairStyle: 'cross',
            showTargetBoxes: true, targetBoxColor: 'rgba(0, 255, 0, 0.7)', targetInfoColor: 'white',
        },
        debug: {
            logLevel: 'info', showPerformance: true, showPointerLockWarning: true,
        }
    };

    // --- Utility Functions ---
    const logger = {
        log: (level, ...args) => {
            const currentLevel = ['none', 'error', 'warn', 'info', 'debug'].indexOf(config?.debug?.logLevel ?? 'info');
            const messageLevel = ['none', 'error', 'warn', 'info', 'debug'].indexOf(level);
            if (messageLevel <= currentLevel) {
                console[level === 'debug' ? 'log' : level](LOG_PREFIX, ...args);
            }
        },
        error: (...args) => logger.log('error', ...args),
        warn: (...args) => logger.log('warn', ...args),
        info: (...args) => logger.log('info', ...args),
        debug: (...args) => logger.log('debug', ...args),
    };

    class Vec2 {
        constructor(x = 0, y = 0) { this.x = x; this.y = y; }
        add(v) { return new Vec2(this.x + v.x, this.y + v.y); }
        sub(v) { return new Vec2(this.x - v.x, this.y - v.y); }
        mul(s) { return new Vec2(this.x * s, this.y * s); }
        mag() { return Math.sqrt(this.x * this.x + this.y * this.y); }
        normalize() { const m = this.mag(); return m > 0 ? new Vec2(this.x / m, this.y / m) : new Vec2(); }
        static distance(v1, v2) { return v1.sub(v2).mag(); }
        static lerp(v1, v2, amt) { return new Vec2(lerp(v1.x, v2.x, amt), lerp(v1.y, v2.y, amt)); }
    }

    function getDistance(x1, y1, x2, y2) { return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2)); }
    function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
    function lerp(start, end, amt) { return (1 - amt) * start + amt * end; }

    // --- State Variables ---
    let config = {};
    let model = null;
    let videoElement = null;
    let inputTargetElement = null;
    let overlayCanvas = null;
    let overlayCtx = null;
    let detectionWorker = null;
    let lastDetections = [];
    let currentTarget = null;
    let isAimingActive = false;
    let lastAimTime = 0;
    let lastDetectionTime = 0;
    let targetHistory = new Map();
    let performanceMetrics = { detectionTime: 0, aimLoopTime: 0, fps: 0, lastFrameTime: 0 };
    let screenCenter = new Vec2();
    let isPointerLocked = false;
    let checkElementsInterval = null;
    let tempDetectionCanvas = null;
    let tempDetectionCtx = null;
    let isDebuggerAttached = false;
    let debuggerError = null;
    let isColorAimAssistActive = false; // State for color-based aim assist
    let overlayLoopInterval = null; // For continuous overlay rendering

    // --- Core Modules ---

    // --- ElementFinder ---
    class ElementFinder {
        static findElement(selectors) {
            for (const selector of selectors) {
                try {
                    const element = document.querySelector(selector);
                    if (element && element.isConnected && ElementFinder.isVisible(element)) {
                        logger.debug(`Found element matching selector: "${selector}"`, element);
                        return element;
                    }
                } catch (e) { logger.warn(`Error querying selector "${selector}":`, e); }
            }
            logger.warn(`Could not find a suitable element matching selectors:`, selectors);
            return null;
        }
        static findVideoElement() {
            videoElement = ElementFinder.findElement(POTENTIAL_VIDEO_SELECTORS);
            if (videoElement) {
                const matchingSelector = POTENTIAL_VIDEO_SELECTORS.find(s => { try { return document.querySelector(s) === videoElement; } catch { return false; } });
                logger.info(`Video/Canvas element found: ${videoElement.tagName} matching "${matchingSelector || 'unknown selector'}"`);
                if (videoElement.tagName === 'VIDEO') {
                    try { videoElement.crossOrigin = "anonymous"; logger.debug('Set video crossOrigin to anonymous'); }
                    catch (e) { logger.warn('Could not set video crossOrigin', e); }
                }
                ElementFinder.setupDetectionCanvas();
                return true;
            } else { logger.error('Failed to find suitable Video/Canvas element.'); return false; }
        }
        static findInputTargetElement() {
            inputTargetElement = ElementFinder.findElement(POTENTIAL_INPUT_TARGET_SELECTORS);
            if (!inputTargetElement && videoElement) {
                logger.warn(`No specific input target found, falling back to video/canvas element.`);
                inputTargetElement = videoElement;
            }
            if (inputTargetElement) { logger.info(`Input target element resolved to:`, inputTargetElement); return true; }
            else { logger.error(`No suitable element for input simulation found.`); return false; }
        }
        static setupDetectionCanvas() {
            if (!tempDetectionCanvas) {
                tempDetectionCanvas = document.createElement('canvas');
                tempDetectionCtx = tempDetectionCanvas.getContext('2d');
                logger.debug('Temporary detection canvas created.');
            }
        }
        static checkElementsValidity() {
            let needsReinit = false;
            if (!videoElement || !videoElement.isConnected || !ElementFinder.isVisible(videoElement)) {
                logger.warn('Video element lost/invalid. Re-finding...');
                if (!ElementFinder.findVideoElement()) { logger.error("Failed to re-find video element. Stopping script."); stopAndCleanup(); return; }
                needsReinit = true;
            }
            if (!inputTargetElement || !inputTargetElement.isConnected || !ElementFinder.isVisible(inputTargetElement)) {
                logger.warn('Input target element lost/invalid. Re-finding...');
                if (!ElementFinder.findInputTargetElement()) {
                    logger.error("Failed to re-find input target. Input features disabled.");
                    config.aimbotEnabled = false; config.autoShootEnabled = false; config.triggerBotEnabled = false;
                } else { handlePointerLockChange(); }
            }
            if (needsReinit) {
                logger.info('Crucial elements re-found/changed, re-initializing detection...');
                DetectionEngine.stop();
                setTimeout(() => DetectionEngine.setup(), 500);
            }
        }
        static isVisible(elem) { return !!(elem && elem.isConnected && (elem.offsetWidth || elem.offsetHeight || elem.getClientRects().length)); }
    }

    // --- ConfigManager ---
    class ConfigManager {
        static async load() {
            logger.info('Loading configuration from chrome.storage...');
            config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
            try {
                const result = await chrome.storage.local.get(CONFIG_KEY);
                if (result && result[CONFIG_KEY]) {
                    config = ConfigManager.validateAndMerge(DEFAULT_CONFIG, result[CONFIG_KEY]);
                    logger.info('Configuration loaded and validated.');
                } else { logger.info('No saved configuration found, using defaults.'); }
            } catch (error) { logger.error('Error loading configuration:', error); config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
            screenCenter = new Vec2(window.innerWidth / 2, window.innerHeight / 2);
        }
        static async save() {
            logger.debug('Saving configuration to chrome.storage...');
            try { await chrome.storage.local.set({ [CONFIG_KEY]: config }); }
            catch (error) { logger.error('Error saving configuration:', error); }
        }
        static update(key, value) {
            const keys = key.split('.');
            let obj = config;
            try {
                for (let i = 0; i < keys.length - 1; i++) {
                    obj = obj[keys[i]];
                    if (typeof obj !== 'object' || obj === null) { logger.warn(`Invalid config key path: ${key}`); return; }
                }
                if (obj && typeof obj === 'object' && keys[keys.length - 1] in obj) {
                    obj[keys[keys.length - 1]] = value;
                    logger.debug(`Updated config: ${key} = ${value}`);
                    ConfigManager.save();
                    applyConfigChanges(key, value);
                } else { logger.warn(`Could not find key in config: ${key}`); }
            } catch (error) { logger.error(`Error updating config key "${key}":`, error); }
        }
        static validateAndMerge(defaultObj, savedObj) {
            const merged = {};
            for (const key in defaultObj) {
                if (!Object.hasOwnProperty.call(defaultObj, key)) continue;
                if (savedObj && Object.hasOwnProperty.call(savedObj, key)) {
                    const defaultValue = defaultObj[key]; const savedValue = savedObj[key];
                    const defaultType = typeof defaultValue; const savedType = typeof savedValue;
                    if (defaultType === 'object' && defaultValue !== null && !Array.isArray(defaultValue) && savedType === 'object' && savedValue !== null && !Array.isArray(savedValue)) {
                        merged[key] = ConfigManager.validateAndMerge(defaultValue, savedValue);
                    } else if (defaultType === savedType) {
                        if (Array.isArray(defaultValue) !== Array.isArray(savedValue)) {
                            logger.warn(`Config type mismatch for key "${key}". Using default.`);
                            merged[key] = JSON.parse(JSON.stringify(defaultValue));
                        } else { merged[key] = savedValue; }
                    } else if (defaultValue === null && savedValue === null) { merged[key] = null; }
                    else { logger.warn(`Config type mismatch for key "${key}". Using default.`); merged[key] = JSON.parse(JSON.stringify(defaultValue)); }
                } else { logger.debug(`Key "${key}" missing in saved config, using default.`); merged[key] = JSON.parse(JSON.stringify(defaultObj[key])); }
            }
            for (const key in savedObj) { if (Object.hasOwnProperty.call(savedObj, key) && !Object.hasOwnProperty.call(defaultObj, key)) { logger.warn(`Ignoring unknown key "${key}" in saved config.`); } }
            return merged;
        }
    }

    // --- OverlayManager ---
    class OverlayManager {
        static setup() {
            logger.info('Setting up overlay canvas...');
            if (overlayCanvas) { logger.warn('Overlay canvas already exists. Re-using.'); return; }
            overlayCanvas = document.createElement('canvas'); overlayCanvas.id = 'xcloud-assist-overlay';
            overlayCanvas.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;`;
            document.body.appendChild(overlayCanvas);
            overlayCtx = overlayCanvas.getContext('2d');
            if (!overlayCtx) { logger.error("Failed to get 2D context for overlay."); overlayCanvas.remove(); overlayCanvas = null; return; }
            OverlayManager.resizeCanvas(); window.addEventListener('resize', OverlayManager.resizeCanvas); logger.info('Overlay canvas setup complete.');
            OverlayManager.startDrawingLoop(); // Start the drawing loop
        }
        static startDrawingLoop() {
            if (overlayLoopInterval) return;
            logger.info('Starting overlay drawing loop...');
            overlayLoopInterval = setInterval(() => {
                OverlayManager.draw();
            }, 16); // ~60 FPS
        }
        static stopDrawingLoop() {
            if (overlayLoopInterval) {
                clearInterval(overlayLoopInterval);
                overlayLoopInterval = null;
                logger.info('Overlay drawing loop stopped.');
            }
        }
        static resizeCanvas() {
            if (!overlayCanvas) return;
            overlayCanvas.width = window.innerWidth; overlayCanvas.height = window.innerHeight;
            screenCenter = new Vec2(overlayCanvas.width / 2, overlayCanvas.height / 2);
            logger.debug(`Overlay canvas resized to ${overlayCanvas.width}x${overlayCanvas.height}`);
        }
        static clear() { if (overlayCtx) { overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height); } }
        static draw() {
            OverlayManager.clear();
            if (!config.enabled || !overlayCtx || !overlayCanvas) return;
            const now = performance.now();
            if (performanceMetrics.lastFrameTime > 0) { performanceMetrics.fps = 1000 / (now - performanceMetrics.lastFrameTime); }
            performanceMetrics.lastFrameTime = now;
            try {
                if (config.visuals.showCrosshair) OverlayManager.drawCrosshair();
                if (config.visuals.showFovCircle && (config.aimbotEnabled || config.colorAimAssistEnabled)) OverlayManager.drawFovCircle();
                if (config.visuals.showTargetBoxes && lastDetections.length > 0) OverlayManager.drawTargetBoxes();
                if (config.debug.showPerformance) OverlayManager.drawPerformance();
                if (isPointerLocked && config.debug.showPointerLockWarning) OverlayManager.drawPointerLockWarning();
                OverlayManager.drawDebuggerStatus();
            } catch (error) { logger.error("Error during overlay drawing:", error); }
        }
        static drawCrosshair() {
            const { size, color, style } = config.visuals; const { x, y } = screenCenter;
            overlayCtx.strokeStyle = color; overlayCtx.fillStyle = color; overlayCtx.lineWidth = 1.5;
            overlayCtx.save(); overlayCtx.setLineDash([]);
            switch (style) {
                case 'circle': overlayCtx.beginPath(); overlayCtx.arc(x, y, size / 2, 0, 2 * Math.PI); overlayCtx.stroke(); break;
                case 'dot': overlayCtx.beginPath(); overlayCtx.arc(x, y, size / 2, 0, 2 * Math.PI); overlayCtx.fill(); break;
                case 'cross': default: overlayCtx.beginPath(); overlayCtx.moveTo(x - size / 2, y); overlayCtx.lineTo(x + size / 2, y); overlayCtx.moveTo(x, y - size / 2); overlayCtx.lineTo(x, y + size / 2); overlayCtx.stroke(); break;
            } overlayCtx.restore();
        }
        static drawFovCircle() {
            overlayCtx.strokeStyle = config.visuals.fovColor; overlayCtx.lineWidth = 2;
            overlayCtx.save(); overlayCtx.setLineDash([5, 5]);
            overlayCtx.beginPath(); overlayCtx.arc(screenCenter.x, screenCenter.y, config.aiming.fovRadius, 0, 2 * Math.PI); overlayCtx.stroke();
            overlayCtx.restore();
        }
        static drawTargetBoxes() {
            overlayCtx.save(); overlayCtx.strokeStyle = config.visuals.targetBoxColor; overlayCtx.fillStyle = config.visuals.targetInfoColor;
            overlayCtx.lineWidth = 1; overlayCtx.font = '12px Arial'; overlayCtx.textAlign = 'left'; overlayCtx.textBaseline = 'top'; overlayCtx.setLineDash([]);
            const videoRect = videoElement?.getBoundingClientRect(); if (!videoRect) return;
            for (const target of lastDetections) {
                if (!target.bbox) continue;
                const screenPos = mapVideoToScreen(new Vec2(target.bbox[0], target.bbox[1]), videoRect);
                const screenWidth = (target.bbox[2] / (videoElement.videoWidth ?? videoElement.width)) * videoRect.width;
                const screenHeight = (target.bbox[3] / (videoElement.videoHeight ?? videoElement.height)) * videoRect.height;
                const screenX = screenPos.x; const screenY = screenPos.y;
                const confidence = target.score.toFixed(2); const distance = target.estimatedDistance?.toFixed(0) ?? 'N/A';
                overlayCtx.strokeRect(screenX, screenY, screenWidth, screenHeight);
                const infoText = `Conf: ${confidence} | Dist: ${distance}`; const textWidth = overlayCtx.measureText(infoText).width;
                overlayCtx.fillStyle = 'rgba(0,0,0,0.7)'; overlayCtx.fillRect(screenX, screenY - 14, Math.max(textWidth + 4, screenWidth), 14);
                overlayCtx.fillStyle = config.visuals.targetInfoColor; overlayCtx.fillText(infoText, screenX + 2, screenY - 13);
                if (target === currentTarget && isAimingActive) {
                    const aimScreenPoint = AimingLogic.calculateAimScreenPos(target, false);
                    overlayCtx.fillStyle = 'cyan'; overlayCtx.fillRect(aimScreenPoint.x - 3, aimScreenPoint.y - 3, 6, 6);
                }
            } overlayCtx.restore();
        }
        static drawPerformance() {
            overlayCtx.save(); overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            overlayCtx.fillRect(10, overlayCanvas.height - 75, 220, 65);
            overlayCtx.fillStyle = 'white'; overlayCtx.font = '12px Arial'; overlayCtx.textAlign = 'left'; overlayCtx.textBaseline = 'top';
            overlayCtx.fillText(`FPS: ${performanceMetrics.fps.toFixed(1)}`, 15, overlayCanvas.height - 70);
            overlayCtx.fillText(`Detection Time: ${performanceMetrics.detectionTime.toFixed(1)} ms`, 15, overlayCanvas.height - 55);
            overlayCtx.fillText(`Aim Loop Time: ${performanceMetrics.aimLoopTime.toFixed(1)} ms`, 15, overlayCanvas.height - 40);
            overlayCtx.fillText(`Targets Found: ${lastDetections.length}`, 15, overlayCanvas.height - 25);
            overlayCtx.restore();
        }
        static drawPointerLockWarning() {
            overlayCtx.save(); overlayCtx.fillStyle = 'rgba(255, 165, 0, 0.8)';
            overlayCtx.fillRect(overlayCanvas.width / 2 - 150, 10, 300, 25);
            overlayCtx.fillStyle = 'black'; overlayCtx.font = 'bold 14px Arial'; overlayCtx.textAlign = 'center'; overlayCtx.textBaseline = 'middle';
            overlayCtx.fillText('Pointer Lock Active - Input Sim May Fail', overlayCanvas.width / 2, 22);
            overlayCtx.restore();
        }
        static drawDebuggerStatus() {
            let statusText = "Debugger: "; let bgColor = 'rgba(100, 100, 100, 0.7)';
            if (debuggerError) { statusText += `ERROR (${debuggerError.substring(0, 30)}...)`; bgColor = 'rgba(255, 0, 0, 0.7)'; }
            else if (isDebuggerAttached) { statusText += "Attached"; bgColor = 'rgba(0, 180, 0, 0.7)'; }
            else { statusText += "Detached"; bgColor = 'rgba(255, 165, 0, 0.7)'; }
            overlayCtx.save(); overlayCtx.fillStyle = bgColor;
            overlayCtx.fillRect(overlayCanvas.width - 180, 10, 170, 25);
            overlayCtx.fillStyle = 'white'; overlayCtx.font = 'bold 12px Arial'; overlayCtx.textAlign = 'center'; overlayCtx.textBaseline = 'middle';
            overlayCtx.fillText(statusText, overlayCanvas.width - 95, 23);
            overlayCtx.restore();
        }
    }

    // --- ColorAimAssist ---
    class ColorAimAssist {
        static isScanning = false;
        static lastScanTime = 0;
        static scanInterval = 50; // Scan every 50ms when active
        static colorThreshold = 30; // Color matching threshold (RGB distance)

        static start() {
            if (ColorAimAssist.isScanning) return;
            logger.info('Starting color aim assist scanning...');
            ColorAimAssist.isScanning = true;
            ColorAimAssist.scanLoop();
        }

        static stop() {
            if (!ColorAimAssist.isScanning) return;
            logger.info('Stopping color aim assist scanning...');
            ColorAimAssist.isScanning = false;
            InputSimulator.stopADS(); // Release ADS when stopping
        }

        static scanLoop() {
            if (!ColorAimAssist.isScanning || !config.enabled || !config.colorAimAssistEnabled || !videoElement || !overlayCanvas) return;

            const now = performance.now();
            if (now - ColorAimAssist.lastScanTime < ColorAimAssist.scanInterval) {
                setTimeout(ColorAimAssist.scanLoop, ColorAimAssist.scanInterval);
                return;
            }
            ColorAimAssist.lastScanTime = now;

            try {
                const videoRect = videoElement.getBoundingClientRect();
                if (!videoRect) return;

                // Create a temporary canvas to capture the FOV area
                const fovCanvas = document.createElement('canvas');
                const fovCtx = fovCanvas.getContext('2d');
                const fovRadius = config.aiming.fovRadius;
                fovCanvas.width = fovRadius * 2;
                fovCanvas.height = fovRadius * 2;

                // Capture the area around the screen center
                const sourceX = screenCenter.x - fovRadius;
                const sourceY = screenCenter.y - fovRadius;
                fovCtx.drawImage(videoElement,
                    (sourceX - videoRect.left) * (videoElement.videoWidth / videoRect.width),
                    (sourceY - videoRect.top) * (videoElement.videoHeight / videoRect.height),
                    (fovCanvas.width / videoRect.width) * videoElement.videoWidth,
                    (fovCanvas.height / videoRect.height) * videoElement.videoHeight,
                    0, 0, fovCanvas.width, fovCanvas.height
                );

                // Get pixel data from the FOV area
                const imageData = fovCtx.getImageData(0, 0, fovCanvas.width, fovCanvas.height);
                const pixels = imageData.data;
                const targetColor = config.colorAimAssistTargetColor; // [255, 0, 0] for red

                let colorDetected = false;
                for (let i = 0; i < pixels.length; i += 4) {
                    const r = pixels[i];
                    const g = pixels[i + 1];
                    const b = pixels[i + 2];
                    const distance = Math.sqrt(
                        Math.pow(r - targetColor[0], 2) +
                        Math.pow(g - targetColor[1], 2) +
                        Math.pow(b - targetColor[2], 2)
                    );
                    if (distance < ColorAimAssist.colorThreshold) {
                        colorDetected = true;
                        break;
                    }
                }

                // If color is detected, simulate ADS (right-click)
                if (colorDetected) {
                    logger.debug('Red color detected in FOV. Activating ADS...');
                    InputSimulator.startADS();
                } else {
                    InputSimulator.stopADS();
                }
            } catch (error) {
                logger.error('Error during color aim assist scan:', error);
                InputSimulator.stopADS();
            }

            if (ColorAimAssist.isScanning) {
                setTimeout(ColorAimAssist.scanLoop, ColorAimAssist.scanInterval);
            }
        }
    }

    // --- UIManager ---
    class UIManager {
        static guiContainer = null;
        static debuggerStatusElement = null;

        static setup() {
            logger.info('Setting up GUI...');
            if (UIManager.guiContainer) { UIManager.guiContainer.remove(); }
            UIManager.guiContainer = document.createElement('div'); UIManager.guiContainer.id = 'xcloud-assist-gui';
            UIManager.guiContainer.style.cssText = `position:fixed;top:10px;left:10px;background:rgba(30,30,30,0.92);color:white;padding:15px;border-radius:8px;z-index:10000;font-family:sans-serif;font-size:12px;max-height:90vh;overflow-y:auto;border:1px solid #555;display:${config.enabled?'block':'none'};backdrop-filter:blur(2px);`;
            document.body.appendChild(UIManager.guiContainer);
            UIManager.buildGUI(); logger.info('GUI setup complete.');
        }

        static buildGUI() {
            const gui = UIManager.guiContainer; if (!gui) return;
            gui.innerHTML = '';

            const title = document.createElement('h3'); title.textContent = `${SCRIPT_NAME} ${SCRIPT_VERSION}`;
            title.style.cssText = 'margin:0 0 15px;text-align:center;color:lightcoral;border-bottom:1px solid #555;padding-bottom:5px;';
            gui.appendChild(title);

            const dbgControlSection = UIManager.createSection('Debugger Control');
            const statusContainer = document.createElement('div'); statusContainer.style.marginBottom = '10px'; statusContainer.textContent = 'Debugger Status: ';
            UIManager.debuggerStatusElement = document.createElement('span'); UIManager.debuggerStatusElement.textContent = 'Querying...'; UIManager.debuggerStatusElement.style.fontWeight = 'bold';
            statusContainer.appendChild(UIManager.debuggerStatusElement); dbgControlSection.appendChild(statusContainer);
            UIManager.updateDebuggerStatusDisplay();
            UIManager.createButton('Attach Debugger', DebuggerControl.attach, dbgControlSection);
            UIManager.createButton('Detach Debugger', DebuggerControl.detach, dbgControlSection);
            const dbgExplain = document.createElement('p'); dbgExplain.innerHTML = 'Attaching the debugger is required for input simulation (aiming/shooting) and requires special permissions.';
            dbgExplain.style.cssText = 'font-size:11px;margin-top:5px;color:#aaa;'; dbgControlSection.appendChild(dbgExplain);

            const genSection = UIManager.createSection('General');
            UIManager.createToggle('Master Enable', 'enabled', (val) => { gui.style.display = val ? 'block' : 'none'; }, genSection);
            UIManager.createToggle('Aimbot Enabled', 'aimbotEnabled', null, genSection);
            UIManager.createToggle('Auto Shoot', 'autoShootEnabled', null, genSection);
            UIManager.createToggle('Trigger Bot', 'triggerBotEnabled', null, genSection);
            UIManager.createToggle('Silent Aim (Fast Snap)', 'silentAimEnabled', null, genSection);
            UIManager.createToggle('Color Aim Assist', 'colorAimAssistEnabled', null, genSection); // New toggle for color aim assist

            const detSection = UIManager.createSection('Detection');
            const detNote = document.createElement('p'); detNote.innerHTML = 'Uses Web Worker for detection. Ensure worker setup is correct.';
            detNote.style.cssText = 'font-size:11px;margin-bottom:8px;color:#aaa;'; detSection.appendChild(detNote);
            UIManager.createToggle('Detection Enabled', 'detection.enabled', null, detSection);
            UIManager.createSlider('Detection Interval (ms)', 'detection.intervalMs', 30, 500, 5, detSection);
            UIManager.createSlider('Confidence Threshold', 'detection.confidenceThreshold', 0.1, 0.9, 0.05, detSection);
            UIManager.createSlider('Detection Resolution Scale', 'detection.resolutionScale', 0.1, 1.0, 0.05, detSection);
            UIManager.createSelect('Target Class', 'detection.targetClass', ['person', 'car', 'cat', 'dog', 'bottle'], detSection);
            UIManager.createToggle('Basic Visibility Check', 'detection.visibilityCheck', null, detSection);
            UIManager.createSlider('Max Target Distance (Est.)', 'detection.maxDistance', 100, 2000, 50, detSection);

            const aimSection = UIManager.createSection('Aiming');
            UIManager.createInput('Aim Key', 'aimKey', 'text', 'Click and press a key (e.g., Q)', aimSection, true);
            UIManager.createInput('Color Aim Assist Key', 'colorAimAssistKey', 'text', 'Click and press a key (e.g., L)', aimSection, true); // New input for color aim assist key
            UIManager.createSlider('FOV Radius (Visual)', 'aiming.fovRadius', 30, 700, 10, aimSection);
            UIManager.createSlider('Aim Smoothing', 'aiming.smoothing', 0.01, 0.6, 0.01, aimSection);
            UIManager.createSlider('Silent Aim Smoothing', 'aiming.silentAimSmoothing', 0.01, 0.3, 0.01, aimSection);
            UIManager.createSlider('Prediction (ms)', 'aiming.predictionMs', 0, 200, 5, aimSection);
            UIManager.createSelect('Target Selection', 'aiming.targetSelection', ['crosshair', 'distance'], aimSection);
            UIManager.createSelect('Hitbox', 'aiming.hitbox', ['head', 'body', 'nearest'], aimSection);
            UIManager.createSlider('Vertical Aim Offset (%)', 'aiming.verticalOffset', -0.5, 0.5, 0.05, aimSection);

            const visSection = UIManager.createSection('Visuals');
            UIManager.createToggle('Show FOV Circle', 'visuals.showFovCircle', null, visSection);
            UIManager.createToggle('Show Crosshair', 'visuals.showCrosshair', null, visSection);
            UIManager.createSlider('Crosshair Size', 'visuals.crosshairSize', 1, 30, 1, visSection);
            UIManager.createSelect('Crosshair Style', 'visuals.crosshairStyle', ['cross', 'circle', 'dot'], visSection);
            UIManager.createInput('Crosshair Color', 'visuals.crosshairColor', 'text', 'red, #FF0000, rgba(...)', visSection);
            UIManager.createToggle('Show Target Boxes', 'visuals.showTargetBoxes', null, visSection);

            const miscSection = UIManager.createSection('Debug / Misc');
            UIManager.createToggle('Show Performance', 'debug.showPerformance', null, miscSection);
            UIManager.createToggle('Show Pointer Lock Warning', 'debug.showPointerLockWarning', null, miscSection);
            UIManager.createSelect('Log Level', 'debug.logLevel', ['none', 'error', 'warn', 'info', 'debug'], miscSection);
            UIManager.createButton('Reset Settings', () => {
                if (confirm('Reset all settings to default?')) {
                    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
                    ConfigManager.save().then(() => {
                        UIManager.buildGUI();
                        logger.info('Settings reset to default.');
                        applyConfigChanges('enabled', config.enabled);
                        applyConfigChanges('detection.enabled', config.detection.enabled);
                    });
                }
            }, miscSection);
            UIManager.createButton('Reload Extension', () => chrome.runtime.reload(), miscSection);
            miscSection.appendChild(document.createElement('hr'));
            const helpText = document.createElement('p'); helpText.innerHTML = 'Toggle GUI: <b>Home</b> Key<br>Hold <b>Aim Key</b> to activate aimbot.<br>Press <b>Color Aim Assist Key</b> to toggle color aim assist.<br><b>Debugger must be attached for aiming/shooting.</b>';
            helpText.style.cssText = 'font-size:11px;margin-top:10px;'; miscSection.appendChild(helpText);

            DebuggerControl.queryStatus();
        }

        static updateDebuggerStatusDisplay() {
            if (!UIManager.debuggerStatusElement) return;
            let text = 'Unknown'; let color = 'grey';
            if (debuggerError) { text = `ERROR`; color = 'red'; }
            else if (isDebuggerAttached) { text = "Attached"; color = 'lightgreen'; }
            else { text = "Detached"; color = 'orange'; }
            UIManager.debuggerStatusElement.textContent = text; UIManager.debuggerStatusElement.style.color = color;
        }

        static createSection(title, parent = UIManager.guiContainer) {
            const section = document.createElement('div'); section.style.cssText = 'margin-top:15px;padding-top:10px;border-top:1px solid #444;';
            const header = document.createElement('strong'); header.textContent = title; header.style.cssText = 'display:block;margin-bottom:8px;color:#adedff;';
            section.appendChild(header); if (parent) parent.appendChild(section); return section;
        }
        static createToggle(label, configKey, onChange = null, parent = UIManager.guiContainer) {
            const container = document.createElement('div'); container.style.cssText = 'margin-bottom:6px;display:flex;align-items:center;';
            const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = `toggle_${configKey.replace('.','_')}`;
            checkbox.checked = UIManager.getConfigValue(configKey); checkbox.style.cssText = 'margin-right:8px;cursor:pointer;';
            const labelElement = document.createElement('label'); labelElement.htmlFor = checkbox.id; labelElement.textContent = label; labelElement.style.cssText = 'cursor:pointer;flex-grow:1;';
            checkbox.addEventListener('change', () => { const newVal = checkbox.checked; ConfigManager.update(configKey, newVal); if (onChange) onChange(newVal); });
            container.appendChild(checkbox); container.appendChild(labelElement); if (parent) parent.appendChild(container);
        }
        static createSlider(label, configKey, min, max, step, parent = UIManager.guiContainer) {
            const container = document.createElement('div'); container.style.marginBottom = '10px';
            const initialValue = UIManager.getConfigValue(configKey); const valueSpan = document.createElement('span');
            valueSpan.textContent = parseFloat(initialValue).toFixed(step < 1 ? 2 : 0);
            const labelElement = document.createElement('label'); labelElement.textContent = `${label}: `; labelElement.appendChild(valueSpan); labelElement.style.cssText = 'display:block;margin-bottom:4px;';
            const slider = document.createElement('input'); slider.type = 'range'; slider.min = min; slider.max = max; slider.step = step; slider.value = initialValue;
            slider.style.cssText = 'width:95%;height:5px;cursor:pointer;';
            slider.addEventListener('input', () => { const numVal = parseFloat(slider.value); valueSpan.textContent = numVal.toFixed(step < 1 ? 2 : 0); ConfigManager.update(configKey, numVal); });
            container.appendChild(labelElement); container.appendChild(slider); if (parent) parent.appendChild(container);
        }
        static createSelect(label, configKey, options, parent = UIManager.guiContainer) {
            const container = document.createElement('div'); container.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;';
            const labelElement = document.createElement('label'); labelElement.textContent = label + ': '; labelElement.style.marginRight = '5px'; labelElement.htmlFor = `select_${configKey.replace('.','_')}`;
            const select = document.createElement('select'); select.id = `select_${configKey.replace('.','_')}`; select.style.cssText = 'padding:3px;flex-grow:1;cursor:pointer;';
            const currentValue = UIManager.getConfigValue(configKey);
            options.forEach(option => { const opt = document.createElement('option'); opt.value = option; opt.textContent = option.charAt(0).toUpperCase() + option.slice(1); opt.selected = (option === currentValue); select.appendChild(opt); });
            select.value = currentValue; select.addEventListener('change', () => { ConfigManager.update(configKey, select.value); });
            container.appendChild(labelElement); container.appendChild(select); if (parent) parent.appendChild(container);
        }
        static createInput(label, configKey, type = 'text', placeholder = '', parent = UIManager.guiContainer, isAimKey = false) {
            const container = document.createElement('div'); container.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;';
            const labelElement = document.createElement('label'); labelElement.textContent = label + ': '; labelElement.style.marginRight = '5px'; labelElement.htmlFor = `input_${configKey.replace('.','_')}`;
            const input = document.createElement('input'); input.id = `input_${configKey.replace('.','_')}`; input.type = type; input.placeholder = placeholder;
            input.value = UIManager.getConfigValue(configKey);
            input.style.cssText = 'padding:4px;border:1px solid #555;background:#333;color:white;flex-grow:1;';
            if (isAimKey) {
                input.readOnly = true;
                input.style.cursor = 'pointer';
                input.addEventListener('click', () => {
                    input.value = 'Press a key...';
                    const keyListener = (e) => {
                        e.preventDefault();
                        let keyCode = e.code;
                        if (!keyCode) {
                            keyCode = 'Key' + e.key.toUpperCase();
                        }
                        input.value = keyCode;
                        ConfigManager.update(configKey, keyCode);
                        document.removeEventListener('keydown', keyListener);
                    };
                    document.addEventListener('keydown', keyListener);
                });
            } else {
                input.addEventListener('change', () => { ConfigManager.update(configKey, input.value); });
            }
            container.appendChild(labelElement); container.appendChild(input); if (parent) parent.appendChild(container);
        }
        static createButton(label, onClick, parent = UIManager.guiContainer) {
            const button = document.createElement('button'); button.textContent = label;
            button.style.cssText = `display:inline-block;margin:5px 5px 0 0;padding:6px 12px;background:#007bff;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;transition:background-color 0.2s ease;`;
            button.addEventListener('mouseenter', () => button.style.backgroundColor = '#0056b3'); button.addEventListener('mouseleave', () => button.style.backgroundColor = '#007bff');
            button.addEventListener('click', onClick); if (parent) parent.appendChild(button);
        }
        static getConfigValue(key) {
            const keys = key.split('.'); let value = config;
            try { for (const k of keys) { if (value && typeof value === 'object' && k in value) { value = value[k]; } else { logger.warn(`Config get failed: ${key} (at '${k}')`); return undefined; } } return value; }
            catch (e) { logger.warn(`Error getting config value "${key}":`, e); return undefined; }
        }
    }

    // --- DebuggerControl ---
    class DebuggerControl {
        static async attach() {
            logger.info("Requesting debugger attach..."); debuggerError = null;
            if (UIManager.debuggerStatusElement) { UIManager.debuggerStatusElement.textContent = 'Attaching...'; UIManager.debuggerStatusElement.style.color = 'yellow'; }
            try {
                const response = await chrome.runtime.sendMessage({ type: 'controlDebugger', command: 'attach' });
                logger.info("Attach response:", response);
            } catch (error) { logger.error("Error sending attach request:", error); isDebuggerAttached = false; debuggerError = error.message || "Communication failed"; UIManager.updateDebuggerStatusDisplay(); }
        }
        static async detach() {
            logger.info("Requesting debugger detach..."); debuggerError = null;
            if (UIManager.debuggerStatusElement) { UIManager.debuggerStatusElement.textContent = 'Detaching...'; UIManager.debuggerStatusElement.style.color = 'yellow'; }
            try {
                await chrome.runtime.sendMessage({ type: 'controlDebugger', command: 'detach' });
                logger.info("Detach request sent.");
            } catch (error) { logger.error("Error sending detach request:", error); debuggerError = error.message || "Communication failed"; UIManager.updateDebuggerStatusDisplay(); }
        }
        static async queryStatus() {
            logger.debug("Querying debugger status...");
            try {
                const response = await chrome.runtime.sendMessage({ type: 'controlDebugger', command: 'queryStatus' });
                if (response) { isDebuggerAttached = response.attached; debuggerError = null; logger.debug("Debugger status queried:", isDebuggerAttached); }
                else { debuggerError = "Query failed"; }
            } catch (error) { logger.error("Error sending status query:", error); debuggerError = error.message || "Query communication failed"; isDebuggerAttached = false; }
            UIManager.updateDebuggerStatusDisplay();
        }
    }

    // --- DetectionEngine ---
    class DetectionEngine {
        static isReady = false;
        static isDetecting = false;
        static detectionLoopTimeout = null;

        static async setup() {
            logger.info('Setting up Detection Engine (Content Script)...');
            if (!config.detection.useWorker) {
                logger.error("Main thread detection mode requires manual setup and is not recommended. Enable Web Worker in config (if option existed) or edit script.");
                config.detection.enabled = false; return;
            }
            if (!videoElement || !tempDetectionCanvas) { logger.error('Video/temp canvas not ready for detection setup.'); return; }
            if (!config.detection.enabled) { logger.info('Detection disabled in config.'); return; }
            DetectionEngine.setupWorker();
        }

        static setupWorker() {
            logger.info('Setting up detection worker...');
            if (detectionWorker) { logger.warn("Terminating existing worker."); detectionWorker.terminate(); detectionWorker = null; }
            try {
                // Fetch the worker script content from the extension
                fetch(chrome.runtime.getURL('coco-worker.js'))
                    .then(response => response.text())
                    .then(workerScript => {
                        // Create a Blob with the worker script content
                        const blob = new Blob([workerScript], { type: 'application/javascript' });
                        const workerUrl = URL.createObjectURL(blob);
                        detectionWorker = new Worker(workerUrl);
                        detectionWorker.onmessage = (event) => {
                            const { type, payload } = event.data;
                            if (type === 'workerReady') { logger.info('Detection worker ready (TFJS/Model loaded inside).'); DetectionEngine.start(); }
                            else if (type === 'detectionResult') {
                                const { predictions, timestamp } = payload;
                                if (timestamp) { performanceMetrics.detectionTime = performance.now() - timestamp; } else { performanceMetrics.detectionTime = -1; }
                                lastDetections = DetectionEngine.processDetections(predictions, 1.0 / config.detection.resolutionScale);
                                DetectionEngine.isDetecting = false;
                            } else if (type === 'workerError') { logger.error('Error from detection worker:', payload); DetectionEngine.stop(); config.detection.enabled = false; }
                        };
                        detectionWorker.onerror = (error) => { logger.error('Fatal detection worker error:', error); DetectionEngine.stop(); config.detection.enabled = false; };
                        const workerConfig = { detection: config.detection, videoWidth: videoElement?.videoWidth || 640, videoHeight: videoElement?.videoHeight || 480 };
                        detectionWorker.postMessage({ type: 'init', payload: { config: workerConfig } });
                        logger.debug('Sent init message to worker.');
                        // Clean up the Blob URL after use
                        URL.revokeObjectURL(workerUrl);
                    })
                    .catch(error => {
                        logger.error('Failed to fetch worker script:', error);
                        config.detection.enabled = false;
                    });
            } catch (error) { logger.error('Failed to create detection worker:', error); config.detection.enabled = false; }
        }

        static start() {
            if (!config.enabled || !config.detection.enabled || !detectionWorker) { logger.warn("Cannot start detection (disabled or worker missing)."); return; }
            if (DetectionEngine.detectionLoopTimeout) { logger.warn("Detection loop already running."); return; }
            logger.info(`Starting detection loop (Worker Mode, Interval: ${config.detection.intervalMs}ms)...`);
            DetectionEngine.isDetecting = false; DetectionEngine.runDetectionCycle();
        }
        static stop() {
            logger.info('Stopping detection loop and worker...');
            if (DetectionEngine.detectionLoopTimeout) { clearTimeout(DetectionEngine.detectionLoopTimeout); DetectionEngine.detectionLoopTimeout = null; }
            if (detectionWorker) { logger.debug('Terminating worker.'); detectionWorker.terminate(); detectionWorker = null; }
            DetectionEngine.isDetecting = false; lastDetections = []; logger.info('Detection stopped.');
        }
        static async runDetectionCycle() {
            if (!config.enabled || !config.detection.enabled || !detectionWorker) { if (DetectionEngine.detectionLoopTimeout) clearTimeout(DetectionEngine.detectionLoopTimeout); DetectionEngine.detectionLoopTimeout = null; DetectionEngine.isDetecting = false; return; }
            if (!videoElement || videoElement.readyState < 2 || videoElement.paused || document.hidden) { DetectionEngine.detectionLoopTimeout = setTimeout(DetectionEngine.runDetectionCycle, config.detection.intervalMs * 2); return; }
            if (DetectionEngine.isDetecting) { DetectionEngine.detectionLoopTimeout = setTimeout(DetectionEngine.runDetectionCycle, config.detection.intervalMs); return; }
            DetectionEngine.isDetecting = true; const startTime = performance.now();
            const scale = clamp(config.detection.resolutionScale, 0.1, 1.0); let inputWidth = 0, inputHeight = 0;
            try {
                const sourceWidth = videoElement.videoWidth ?? videoElement.width; const sourceHeight = videoElement.videoHeight ?? videoElement.height;
                if (!sourceWidth || !sourceHeight || sourceWidth <= 0 || sourceHeight <= 0) throw new Error(`Invalid video dimensions: ${sourceWidth}x${sourceHeight}`);
                inputWidth = Math.max(1, Math.round(sourceWidth * scale)); inputHeight = Math.max(1, Math.round(sourceHeight * scale));
                tempDetectionCanvas.width = inputWidth; tempDetectionCanvas.height = inputHeight;
                tempDetectionCtx.drawImage(videoElement, 0, 0, sourceWidth, sourceHeight, 0, 0, inputWidth, inputHeight);
                const imageData = tempDetectionCtx.getImageData(0, 0, inputWidth, inputHeight);
                const imageDataInfo = { imageDataBuffer: imageData.data.buffer, width: inputWidth, height: inputHeight };
                detectionWorker.postMessage({ type: 'detect', payload: { imageDataInfo, timestamp: startTime } }, [imageData.data.buffer]);
            } catch (error) { logger.error('Error during detection cycle prep/exec:', error); lastDetections = []; DetectionEngine.isDetecting = false; }
            finally { if (DetectionEngine.detectionLoopTimeout !== null) { DetectionEngine.detectionLoopTimeout = setTimeout(DetectionEngine.runDetectionCycle, config.detection.intervalMs); } }
        }
        static processDetections(predictions, coordScaleFactor = 1.0) {
            const timestamp = performance.now(); if (!predictions || predictions.length === 0) return [];
            const videoRect = videoElement?.getBoundingClientRect();
            return predictions
                .filter(p => p && p.class === config.detection.targetClass && p.score >= config.detection.confidenceThreshold && p.bbox)
                .map((p, index) => {
                    const scaledBbox = [ p.bbox[0] * coordScaleFactor, p.bbox[1] * coordScaleFactor, p.bbox[2] * coordScaleFactor, p.bbox[3] * coordScaleFactor ];
                    const bboxHeight = scaledBbox[3]; const REF_HEIGHT_PX = 100; const REF_DISTANCE = 100; const FOCAL_LENGTH_APPROX = (REF_HEIGHT_PX * REF_DISTANCE);
                    const estimatedDistance = bboxHeight > 1 ? FOCAL_LENGTH_APPROX / bboxHeight : Infinity;
                    let isVisible = true; const centerXVideo = scaledBbox[0] + scaledBbox[2] / 2; const centerYVideo = scaledBbox[1] + scaledBbox[3] / 2;
                    if (config.detection.visibilityCheck && overlayCanvas && videoElement && videoRect) {
                        try {
                            const centerScreenPos = mapVideoToScreen(new Vec2(centerXVideo, centerYVideo), videoRect);
                            const elemAtCenter = document.elementFromPoint(centerScreenPos.x, centerScreenPos.y);
                            isVisible = elemAtCenter && (elemAtCenter === inputTargetElement || elemAtCenter === videoElement || inputTargetElement?.contains(elemAtCenter));
                        } catch (e) { isVisible = false; }
                    }
                    const id = `${index}-${timestamp}`; const centerPosVideo = new Vec2(centerXVideo, centerYVideo);
                    const history = targetHistory.get(id) || []; history.push({ time: timestamp, pos: centerPosVideo }); if (history.length > 15) history.shift(); targetHistory.set(id, history);
                    return { bbox: scaledBbox, score: p.score, class: p.class, id: id, timestamp: timestamp, center: centerPosVideo, estimatedDistance: estimatedDistance, isVisible: isVisible };
                })
                .filter(t => t.isVisible && t.estimatedDistance <= config.detection.maxDistance)
                .sort((a, b) => {
                    if (config.aiming.targetSelection === 'distance') { return a.estimatedDistance - b.estimatedDistance; }
                    else { if (!videoRect) return 0; const screenA = mapVideoToScreen(a.center, videoRect); const screenB = mapVideoToScreen(b.center, videoRect); return Vec2.distance(screenCenter, screenA) - Vec2.distance(screenCenter, screenB); }
                });
        }
        static cleanupTargetHistory() {
            const now = performance.now(); const expiryTime = 3000; let removedCount = 0;
            for (const [id, history] of targetHistory.entries()) { if (history.length === 0 || now - history[history.length - 1].time > expiryTime) { targetHistory.delete(id); removedCount++; } }
            if (removedCount > 0) logger.debug(`Cleaned up ${removedCount} old target history entries.`);
        }
    }

    // --- AimingLogic ---
    class AimingLogic {
        static currentAimPos = new Vec2(screenCenter.x, screenCenter.y); static lastTargetPos = null; static aimLoopInterval = null;
        static start() { if (AimingLogic.aimLoopInterval) { logger.warn("Aim loop already running."); return; } logger.info('Starting aiming loop...'); AimingLogic.currentAimPos = new Vec2(screenCenter.x, screenCenter.y); AimingLogic.aimLoopInterval = setInterval(AimingLogic.aimLoop, 16); }
        static stop() { if (!AimingLogic.aimLoopInterval) return; logger.info('Stopping aiming loop.'); clearInterval(AimingLogic.aimLoopInterval); AimingLogic.aimLoopInterval = null; currentTarget = null; if (InputSimulator.isShooting) InputSimulator.shoot(false); }
        static aimLoop() {
            const loopStartTime = performance.now();
            if (!config.enabled || !config.aimbotEnabled || !videoElement || !isDebuggerAttached) {
                if (currentTarget) currentTarget = null;
                if (InputSimulator.isShooting) InputSimulator.shoot(false);
                return;
            }
            AimingLogic.selectTarget();
            if (currentTarget && isAimingActive) {
                const targetScreenPos = AimingLogic.calculateAimScreenPos(currentTarget, true);
                const smoothingFactor = config.silentAimEnabled ? config.aiming.silentAimSmoothing : config.aiming.smoothing;
                const lerpAmount = 1.0 - Math.pow(smoothingFactor, (performance.now() - lastAimTime) / 16.67);
                const smoothedAimPos = Vec2.lerp(AimingLogic.currentAimPos, targetScreenPos, clamp(lerpAmount, 0.01, 1.0));
                const deltaX = smoothedAimPos.x - screenCenter.x; const deltaY = smoothedAimPos.y - screenCenter.y;
                const moveThreshold = 0.5;
                if (Math.abs(deltaX) > moveThreshold || Math.abs(deltaY) > moveThreshold) { InputSimulator.moveAim(deltaX, deltaY); }
                AimingLogic.currentAimPos = smoothedAimPos; AimingLogic.lastTargetPos = targetScreenPos;
                const crosshairRadius = (config.visuals.crosshairSize / 2) + 3;
                const isCrosshairOnTarget = Vec2.distance(AimingLogic.currentAimPos, targetScreenPos) <= crosshairRadius;
                if (config.autoShootEnabled && isCrosshairOnTarget) {
                    if (!InputSimulator.isShooting) InputSimulator.shoot(true);
                } else if (InputSimulator.isShooting) {
                    InputSimulator.shoot(false);
                }
                if (config.triggerBotEnabled && isCrosshairOnTarget) {
                    InputSimulator.click();
                }
            } else {
                if (InputSimulator.isShooting) InputSimulator.shoot(false);
                AimingLogic.currentAimPos = new Vec2(screenCenter.x, screenCenter.y);
                AimingLogic.lastTargetPos = null;
            }
            lastAimTime = performance.now();
            performanceMetrics.aimLoopTime = lastAimTime - loopStartTime;
        }
        static selectTarget() {
            currentTarget = null;
            if (lastDetections.length === 0) return;
            const videoRect = videoElement?.getBoundingClientRect();
            if (!videoRect) return;
            let bestTarget = null;
            let bestScore = Infinity;
            for (const target of lastDetections) {
                if (!target.center || !target.isVisible) continue;
                const screenPos = mapVideoToScreen(target.center, videoRect);
                const distanceToCrosshair = Vec2.distance(screenCenter, screenPos);
                if (distanceToCrosshair > config.aiming.fovRadius) continue;
                let score = distanceToCrosshair;
                if (config.aiming.targetSelection === 'distance') {
                    score = target.estimatedDistance;
                }
                if (score < bestScore) {
                    bestScore = score;
                    bestTarget = target;
                }
            }
            currentTarget = bestTarget;
        }
        static calculateAimScreenPos(target, applyPrediction = false) {
            if (!target || !target.center) return screenCenter;
            const videoRect = videoElement?.getBoundingClientRect();
            if (!videoRect) return screenCenter;
            let aimPoint = target.center;
            const targetHeight = target.bbox[3];
            const hitboxOffset = (targetHeight * (config.aiming.hitbox === 'head' ? 0.1 : config.aiming.hitbox === 'body' ? 0.5 : 0.3)) + (targetHeight * config.aiming.verticalOffset);
            aimPoint = new Vec2(target.center.x, target.center.y + hitboxOffset);
            if (applyPrediction && targetHistory.has(target.id) && config.aiming.predictionMs > 0) {
                const history = targetHistory.get(target.id);
                if (history.length >= 2) {
                    const latest = history[history.length - 1];
                    const previous = history[history.length - 2];
                    const timeDelta = (latest.time - previous.time) / 1000;
                    if (timeDelta > 0) {
                        const velocity = new Vec2(
                            (latest.pos.x - previous.pos.x) / timeDelta,
                            (latest.pos.y - previous.pos.y) / timeDelta
                        );
                        const predictionTime = config.aiming.predictionMs / 1000;
                        aimPoint = aimPoint.add(velocity.mul(predictionTime));
                    }
                }
            }
            const screenPos = mapVideoToScreen(aimPoint, videoRect);
            return screenPos;
        }
    }

    // --- InputSimulator ---
    class InputSimulator {
        static isShooting = false;
        static isADSHolding = false;

        static async moveAim(deltaX, deltaY) {
            if (!inputTargetElement || !isDebuggerAttached) return;
            if (isPointerLocked) {
                logger.warn("Pointer is locked, mouse movement simulation may fail.");
                return;
            }
            try {
                const boundedDeltaX = clamp(deltaX, -screenCenter.x, screenCenter.x);
                const boundedDeltaY = clamp(deltaY, -screenCenter.y, screenCenter.y);
                await chrome.runtime.sendMessage({
                    type: 'simulateInput',
                    action: 'mouseMove',
                    payload: { deltaX: boundedDeltaX, deltaY: boundedDeltaY }
                });
                logger.debug(`Simulated mouse move: deltaX=${boundedDeltaX.toFixed(1)}, deltaY=${boundedDeltaY.toFixed(1)}`);
            } catch (error) {
                logger.error('Error simulating mouse movement:', error);
                isDebuggerAttached = false;
                debuggerError = error.message || "Input simulation failed";
                UIManager.updateDebuggerStatusDisplay();
            }
        }

        static async click() {
            if (!inputTargetElement || !isDebuggerAttached) return;
            try {
                await chrome.runtime.sendMessage({
                    type: 'simulateInput',
                    action: 'click',
                    payload: { button: 'left' }
                });
                logger.debug('Simulated mouse click');
            } catch (error) {
                logger.error('Error simulating click:', error);
                isDebuggerAttached = false;
                debuggerError = error.message || "Click simulation failed";
                UIManager.updateDebuggerStatusDisplay();
            }
        }

        static async shoot(shouldShoot) {
            if (!inputTargetElement || !isDebuggerAttached) return;
            if (InputSimulator.isShooting === shouldShoot) return;
            try {
                await chrome.runtime.sendMessage({
                    type: 'simulateInput',
                    action: shouldShoot ? 'mouseDown' : 'mouseUp',
                    payload: { button: 'left' }
                });
                InputSimulator.isShooting = shouldShoot;
                logger.debug(`Simulated mouse ${shouldShoot ? 'down' : 'up'} (shooting)`);
            } catch (error) {
                logger.error(`Error simulating shoot (${shouldShoot ? 'down' : 'up'}):`, error);
                isDebuggerAttached = false;
                debuggerError = error.message || "Shoot simulation failed";
                UIManager.updateDebuggerStatusDisplay();
            }
        }

        static async startADS() {
            if (!inputTargetElement || !isDebuggerAttached || InputSimulator.isADSHolding) return;
            try {
                await chrome.runtime.sendMessage({
                    type: 'simulateInput',
                    action: 'mouseDown',
                    payload: { button: 'right' }
                });
                InputSimulator.isADSHolding = true;
                logger.debug('Simulated ADS (right-click down)');
            } catch (error) {
                logger.error('Error simulating ADS start:', error);
                isDebuggerAttached = false;
                debuggerError = error.message || "ADS simulation failed";
                UIManager.updateDebuggerStatusDisplay();
            }
        }

        static async stopADS() {
            if (!inputTargetElement || !isDebuggerAttached || !InputSimulator.isADSHolding) return;
            try {
                await chrome.runtime.sendMessage({
                    type: 'simulateInput',
                    action: 'mouseUp',
                    payload: { button: 'right' }
                });
                InputSimulator.isADSHolding = false;
                logger.debug('Simulated ADS release (right-click up)');
            } catch (error) {
                logger.error('Error simulating ADS stop:', error);
                isDebuggerAttached = false;
                debuggerError = error.message || "ADS release simulation failed";
                UIManager.updateDebuggerStatusDisplay();
            }
        }
    }

    // --- Helper Functions ---
    function mapVideoToScreen(videoPos, videoRect) {
        if (!videoElement || !videoRect) return new Vec2();
        const videoWidth = videoElement.videoWidth ?? videoElement.width;
        const videoHeight = videoElement.videoHeight ?? videoElement.height;
        const scaleX = videoRect.width / videoWidth;
        const scaleY = videoRect.height / videoHeight;
        const screenX = videoRect.left + (videoPos.x * scaleX);
        const screenY = videoRect.top + (videoPos.y * scaleY);
        return new Vec2(screenX, screenY);
    }

    function applyConfigChanges(key, value) {
        if (key === 'enabled' || key === 'detection.enabled') {
            if (!config.enabled || !config.detection.enabled) {
                DetectionEngine.stop();
                AimingLogic.stop();
                ColorAimAssist.stop();
            } else {
                DetectionEngine.setup();
                AimingLogic.start();
            }
        }
        if (key === 'colorAimAssistEnabled') {
            if (value && isColorAimAssistActive) {
                ColorAimAssist.start();
            } else {
                ColorAimAssist.stop();
            }
        }
    }

    function handlePointerLockChange() {
        const newPointerLockState = !!document.pointerLockElement;
        if (newPointerLockState !== isPointerLocked) {
            isPointerLocked = newPointerLockState;
            logger.info(`Pointer lock state changed: ${isPointerLocked ? 'Locked' : 'Unlocked'}`);
            if (isPointerLocked && inputTargetElement) {
                logger.warn("Pointer lock detected. Input simulation may fail.");
            }
        }
    }

    // --- Event Listeners ---
    function setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Home') {
                e.preventDefault();
                const gui = UIManager.guiContainer;
                if (gui) {
                    gui.style.display = gui.style.display === 'none' ? 'block' : 'none';
                    logger.debug(`GUI visibility toggled to: ${gui.style.display}`);
                }
            }
            if (e.code === config.aimKey) {
                if (!isAimingActive) {
                    isAimingActive = true;
                    logger.debug('Aiming activated');
                }
            }
            if (e.code === config.colorAimAssistKey) {
                e.preventDefault();
                if (!config.colorAimAssistEnabled) return;
                isColorAimAssistActive = !isColorAimAssistActive;
                if (isColorAimAssistActive) {
                    ColorAimAssist.start();
                    logger.info('Color aim assist activated');
                } else {
                    ColorAimAssist.stop();
                    logger.info('Color aim assist deactivated');
                }
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.code === config.aimKey) {
                if (isAimingActive) {
                    isAimingActive = false;
                    logger.debug('Aiming deactivated');
                    if (InputSimulator.isShooting) InputSimulator.shoot(false);
                    AimingLogic.currentAimPos = new Vec2(screenCenter.x, screenCenter.y);
                }
            }
        });

        document.addEventListener('pointerlockchange', handlePointerLockChange);
        document.addEventListener('mozpointerlockchange', handlePointerLockChange);
        window.addEventListener('unload', stopAndCleanup);
    }

    // --- Cleanup ---
    function stopAndCleanup() {
        logger.info('Cleaning up resources...');
        DetectionEngine.stop();
        AimingLogic.stop();
        ColorAimAssist.stop();
        OverlayManager.stopDrawingLoop();
        if (overlayCanvas) {
            window.removeEventListener('resize', OverlayManager.resizeCanvas);
            overlayCanvas.remove();
            overlayCanvas = null;
            overlayCtx = null;
        }
        if (UIManager.guiContainer) {
            UIManager.guiContainer.remove();
            UIManager.guiContainer = null;
        }
        if (checkElementsInterval) {
            clearInterval(checkElementsInterval);
            checkElementsInterval = null;
        }
        document.removeEventListener('pointerlockchange', handlePointerLockChange);
        document.removeEventListener('mozpointerlockchange', handlePointerLockChange);
        window.removeEventListener('unload', stopAndCleanup);
        logger.info('Cleanup complete.');
    }

    // --- Main Initialization ---
    async function init() {
        logger.info(`${SCRIPT_NAME} v${SCRIPT_VERSION} initializing...`);
        await ConfigManager.load();
        if (!ElementFinder.findVideoElement() || !ElementFinder.findInputTargetElement()) {
            logger.error('Failed to find required elements. Script cannot proceed.');
            return;
        }
        OverlayManager.setup();
        UIManager.setup();
        setupEventListeners();
        DetectionEngine.setup();
        AimingLogic.start();
        checkElementsInterval = setInterval(() => {
            ElementFinder.checkElementsValidity();
            DetectionEngine.cleanupTargetHistory();
        }, 5000);
        logger.info('Initialization complete.');
    }

    // Start the script
    try {
        await init();
    } catch (error) {
        logger.error('Initialization failed:', error);
        stopAndCleanup();
    }
})();
