/* coco-worker.js - Web Worker for object detection using COCO-SSD and TensorFlow.js */
(async function () {
    'use strict';

    // --- Constants ---
    const LOG_PREFIX = '[COCO-Worker] ';

    // --- State Variables ---
    let model = null;
    let config = null;
    let inputWidth = 0;
    let inputHeight = 0;

    // --- Utility Functions ---
    const logger = {
        log: (level, ...args) => {
            const currentLevel = ['none', 'error', 'warn', 'info', 'debug'].indexOf(config?.debug?.logLevel ?? 'info');
            const messageLevel = ['none', 'error', 'warn', 'info', 'debug'].indexOf(level);
            if (messageLevel <= currentLevel) {
                self.postMessage({ type: 'log', payload: { level, message: args.join(' ') } });
            }
        },
        error: (...args) => logger.log('error', ...args),
        warn: (...args) => logger.log('warn', ...args),
        info: (...args) => logger.log('info', ...args),
        debug: (...args) => logger.log('debug', ...args),
    };

    // --- Load TensorFlow.js and COCO-SSD ---
    async function loadTfjsAndModel() {
        try {
            // Import TensorFlow.js
            logger.info('Loading TensorFlow.js...');
            self.importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.18.0/dist/tf.min.js');
            logger.info('TensorFlow.js loaded.');

            // Import COCO-SSD
            logger.info('Loading COCO-SSD model...');
            self.importScripts('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js');
            logger.info('COCO-SSD script loaded.');

            // Load the model
            model = await self.cocoSsd.load();
            logger.info('COCO-SSD model loaded successfully.');
            self.postMessage({ type: 'workerReady', payload: {} });
        } catch (error) {
            logger.error('Failed to load TFJS or COCO-SSD model:', error.message);
            self.postMessage({ type: 'workerError', payload: error.message });
        }
    }

    // --- Process Image Data for Detection ---
    async function detectObjects(imageDataInfo) {
        if (!model) {
            logger.error('Model not loaded. Cannot perform detection.');
            self.postMessage({ type: 'workerError', payload: 'Model not loaded' });
            return;
        }

        try {
            // Create an ImageData object from the buffer
            const { imageDataBuffer, width, height } = imageDataInfo;
            const uint8Array = new Uint8ClampedArray(imageDataBuffer);
            const imageData = new ImageData(uint8Array, width, height);

            // Create a canvas to hold the image data
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d');
            ctx.putImageData(imageData, 0, 0);

            // Perform detection
            const predictions = await model.detect(canvas, config.detection.maxDetections);
            logger.debug(`Detected ${predictions.length} objects.`);

            // Format predictions to match expected output
            const formattedPredictions = predictions.map(pred => ({
                class: pred.class,
                score: pred.score,
                bbox: [pred.bbox[0], pred.bbox[1], pred.bbox[2], pred.bbox[3]] // [x, y, width, height]
            }));

            self.postMessage({ type: 'detectionResult', payload: { predictions: formattedPredictions, timestamp: imageDataInfo.timestamp } });
        } catch (error) {
            logger.error('Error during detection:', error.message);
            self.postMessage({ type: 'workerError', payload: error.message });
        }
    }

    // --- Message Handler ---
    self.onmessage = async (event) => {
        const { type, payload } = event.data;

        if (type === 'init') {
            config = payload.config;
            inputWidth = payload.config.videoWidth;
            inputHeight = payload.config.videoHeight;
            logger.info(`Worker initialized with config. Input size: ${inputWidth}x${inputHeight}`);
            await loadTfjsAndModel();
        } else if (type === 'detect') {
            await detectObjects(payload);
        } else {
            logger.warn(`Unknown message type received: ${type}`);
        }
    };

    // Log worker startup
    logger.info('COCO-SSD Worker started.');
})();
