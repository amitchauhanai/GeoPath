const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // Serve frontend files

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let dashboardClients = [];
let currentAIMode = 'both';
let isProcessing = false;
let latestGPS = null;
let cameraDevice = 'Unknown camera';

function relayCameraFrame(frame) {
    const message = JSON.stringify({ type: 'camera_frame', data: frame });
    dashboardClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

function normalizeCameraPayload(value) {
    if (typeof value === 'string') return value;
    const bytes = Array.isArray(value) ? value : value?.type === 'Buffer' && Array.isArray(value.data) ? value.data : null;
    return bytes?.length ? `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}` : null;
}

function isEncodedImagePayload(value) {
    return typeof value === 'string' && (value.startsWith('data:image/') || (value.length > 128 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)));
}

function getCameraFramePayload(data) {
    if (typeof data === 'string') return isEncodedImagePayload(data) ? data : null;
    if (Array.isArray(data)) return normalizeCameraPayload(data);
    if (!data || typeof data !== 'object') return null;
    const numericKeys = Object.keys(data);
    if (numericKeys.length > 128 && numericKeys.every(key => /^\d+$/.test(key)) && Object.values(data).every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
        return normalizeCameraPayload(Object.values(data));
    }
    const frameType = String(data.type || '').toLowerCase().replace(/[-_]/g, '');
    const frameTypes = ['frame', 'cameraframe', 'videoframe', 'image'];
    const fields = ['frame', 'image', 'data', 'base64', 'payload', 'imageData', 'frameData', 'jpeg', 'jpg', 'bytes', 'buffer', 'content', 'frameBytes', 'imageBytes'];
    const payload = fields.map(field => normalizeCameraPayload(data[field])).find(value => value);
    if (!payload) return null;
    const isEncodedImage = isEncodedImagePayload(payload);
    const hasImageField = fields.some(field => field !== 'data' && normalizeCameraPayload(data[field]));
    return frameTypes.includes(frameType) || hasImageField || isEncodedImage ? payload : null;
}

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', async (message, isBinary) => {
        if (isBinary) {
            // 1. Raw Frame to RGB Page
            dashboardClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) client.send(message, { binary: true });
            });

            // 2. Send to FastAPI for AI Processing
            if (!isProcessing) {
                isProcessing = true;
                try {
                    const formData = new FormData();
                    formData.append('file', message, { filename: 'frame.jpg', contentType: 'image/jpeg' });

                    const response = await fetch(`http://10.34.66.150:8000/process_frame?mode=${currentAIMode}`, {
                        method: 'POST',
                        body: formData
                    });
                    if (!response.ok) {
                        throw new Error(`AI backend returned ${response.status}`);
                    }
                    const aiBuffer = await response.buffer();
                    const base64Frame = `data:image/jpeg;base64,${aiBuffer.toString('base64')}`;
                    const detections = response.headers.get('x-geopath-detections') || '{}';
                    const events = response.headers.get('x-geopath-events') || '[]';
                    const plateDetectorAvailable = response.headers.get('x-geopath-plate-available') === 'true';

                    // 3. AI Frame to Segmented Page
                    dashboardClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'ai_frame', data: base64Frame, detections: JSON.parse(detections), events: JSON.parse(events), gps: latestGPS, cameraDevice, plateDetectorAvailable }));
                        }
                    });
                } catch (e) {
                    console.error("AI Backend Error:", e.message);
                }
                isProcessing = false;
            }
        } else {
            // Text Data (GPS or Commands)
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'dashboard') {
                    dashboardClients.push(ws);
                } else if (data.type === 'gps') {
                    latestGPS = { latitude: parseFloat(data.latitude), longitude: parseFloat(data.longitude) };
                    dashboardClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
                    });
                } else if (data.type === 'change_mode') {
                    currentAIMode = data.mode;
                } else if (data.type === 'camera_device') {
                    cameraDevice = String(data.name || 'Unknown camera');
                } else {
                    const frame = getCameraFramePayload(data);
                    if (frame) relayCameraFrame(frame);
                    else console.log(`Unrecognized WebSocket message: type=${data.type || 'none'}, keys=${Object.keys(data).join(',')}`);
                }
            } catch (e) {
                const text = message.toString();
                const isEncodedImage = isEncodedImagePayload(text);
                if (isEncodedImage) relayCameraFrame(text);
                else console.log('Ignored non-JSON WebSocket message');
            }
        }
    });

    ws.on('close', () => {
        dashboardClients = dashboardClients.filter(client => client !== ws);
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Hub Server running on port ${PORT}`));