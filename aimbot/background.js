const SCRIPT_NAME = "Xcloud Vision Assist";
const SCRIPT_VERSION = "0.1.0";
const DEBUGGER_VERSION = "1.3"; // CDP version
let attachedTabs = {}; // Store { tabId: debuggee } mapping

// --- Debugger Attachment ---

async function attachDebugger(tabId) {
    if (attachedTabs[tabId]) {
        console.log(`[${SCRIPT_NAME}][Tab ${tabId}] Debugger already attached to tab ${tabId}.`);
        return true; // Already attached
    }

    const debuggee = { tabId: tabId };
    try {
        console.log(`[${SCRIPT_NAME}][Tab ${tabId}] Attempting to attach debugger to tab ${tabId}...`);
        await chrome.debugger.attach(debuggee, DEBUGGER_VERSION);
        console.log(`[${SCRIPT_NAME}][Tab ${tabId}] Debugger attached successfully to tab ${tabId}.`);
        attachedTabs[tabId] = debuggee;
        chrome.debugger.onDetach.addListener(onDebuggerDetach);
        chrome.debugger.onEvent.addListener(onDebuggerEvent);
        chrome.tabs.sendMessage(tabId, { type: 'debuggerStatus', status: 'attached' }).catch(e => console.warn(`[${SCRIPT_NAME}][Tab ${tabId}] Failed to send attached confirmation to content script:`, e.message));
        return true;
    } catch (error) {
        console.error(`[${SCRIPT_NAME}][Tab ${tabId}] Failed to attach debugger to tab ${tabId}:`, error.message);
        chrome.tabs.sendMessage(tabId, { type: 'debuggerStatus', status: 'error', message: error.message }).catch(e => {});
        delete attachedTabs[tabId]; // Ensure cleanup
        return false;
    }
}

async function detachDebugger(tabId) {
    if (attachedTabs[tabId]) {
        const debuggee = attachedTabs[tabId];
        try {
            console.log(`[${SCRIPT_NAME}][Tab ${tabId}] Detaching debugger from tab ${tabId}...`);
            await chrome.debugger.detach(debuggee);
            chrome.tabs.sendMessage(tabId, { type: 'debuggerStatus', status: 'detached' }).catch(e => {});
        } catch (error) {
            console.error(`[${SCRIPT_NAME}][Tab ${tabId}] Error detaching debugger from tab ${tabId}:`, error.message);
            delete attachedTabs[tabId];
        }
    } else {
        console.log(`[${SCRIPT_NAME}][Tab ${tabId}] Debugger not attached to tab ${tabId}, cannot detach.`);
    }
}

function onDebuggerDetach(source, reason) {
    const tabId = source.tabId;
    if (attachedTabs[tabId]) {
        console.log(`[${SCRIPT_NAME}][Tab ${tabId}] Debugger detached from tab ${tabId}. Reason: ${reason}`);
        delete attachedTabs[tabId];
        chrome.tabs.sendMessage(tabId, { type: 'debuggerStatus', status: 'detached', reason: reason }).catch(e => {});
    }
}

function onDebuggerEvent(source, method, params) {
    // Placeholder for debugging events
}

// --- Input Simulation via CDP ---

async function sendDebuggerCommand(tabId, method, params = {}) {
    if (!attachedTabs[tabId]) {
        console.warn(`[${SCRIPT_NAME}][Tab ${tabId}] Attempted to send command "${method}" to tab ${tabId}, but debugger is not attached.`);
        return null;
    }
    const debuggee = attachedTabs[tabId];
    try {
        const result = await chrome.debugger.sendCommand(debuggee, method, params);
        return result;
    } catch (error) {
        console.error(`[${SCRIPT_NAME}][Tab ${tabId}] Error sending command "${method}" to tab ${tabId}:`, error.message, 'Params:', params);
        if (error.message.includes("detached") || error.message.includes("Cannot access")) {
            detachDebugger(tabId);
        }
        return null;
    }
}

// --- Message Handling from Content Script ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender.tab || !sender.tab.id) {
        console.warn(`[${SCRIPT_NAME}] Received message without sender tab ID.`, message);
        return;
    }

    const tabId = sender.tab.id;

    if (message.type === 'controlDebugger') {
        if (message.command === 'attach') {
            attachDebugger(tabId).then(success => sendResponse({ success }));
            return true;
        } else if (message.command === 'detach') {
            detachDebugger(tabId).then(() => sendResponse({ success: true }));
            return true;
        } else if (message.command === 'queryStatus') {
            const isAttached = !!attachedTabs[tabId];
            sendResponse({ attached: isAttached });
            return false;
        }
    }

    if (!attachedTabs[tabId]) {
        console.warn(`[${SCRIPT_NAME}][Tab ${tabId}] Received input request type "${message.type}" but debugger not attached.`);
        sendResponse({ success: false, error: 'Debugger not attached' });
        return false;
    }

    if (message.type === 'simulateInput') {
        const { inputType, params } = message;

        if (inputType === 'mouseMove') {
            sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: params.x || 0,
                y: params.y || 0,
                movementX: params.dx,
                movementY: params.dy,
                buttons: 1
            }).then(result => sendResponse({ success: !!result }));
            return true;
        } else if (inputType === 'mouseDown' || inputType === 'mouseUp') {
            const cdpType = inputType === 'mouseDown' ? 'mousePressed' : 'mouseReleased';
            const button = params.button || 'left';
            const buttons = inputType === 'mouseDown' ? 1 : 0;

            sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
                type: cdpType,
                x: params.x,
                y: params.y,
                button: button,
                buttons: buttons,
                clickCount: 1
            }).then(result => sendResponse({ success: !!result }));
            return true;
        }
    }

    return false;
});

// --- Tab Management ---

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (attachedTabs[tabId]) {
        console.log(`[${SCRIPT_NAME}] Tab ${tabId} removed. Detaching debugger.`);
        detachDebugger(tabId);
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (attachedTabs[tabId] && changeInfo.url) {
        if (!changeInfo.url.includes("xbox.com") || !changeInfo.url.includes("/play")) {
            console.log(`[${SCRIPT_NAME}] Tab ${tabId} navigated away from xbox play (${changeInfo.url}). Detaching debugger.`);
            detachDebugger(tabId);
        }
    }
});

// Log when the extension starts
console.log(`[${SCRIPT_NAME}] Background Service Worker v${SCRIPT_VERSION} started.`);
