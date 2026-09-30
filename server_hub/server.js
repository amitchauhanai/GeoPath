const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const FormData = require('form-data');
const fetch = require('node-fetch');

const aiBackendUrl = process.env.AI_BACKEND_URL || 'https://geopath-frontend.onrender.com';
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


async function processFrameWithAI(buffer) {
    if (isProcessing) {
        console.log('⏳ AI processing already in progress, skipping frame');
        return;
    }

    isProcessing = true;

    try {
        console.log(`📸 Frame received: ${buffer.length} bytes`);

        const formData = new FormData();

        formData.append('file', buffer, {
            filename: 'frame.jpg',
            contentType: 'image/jpeg'
        });

        // AI backend URL
        const aiUrl =
            `${aiBackendUrl}/process_frame?mode=${currentAIMode}`;

        console.log(`🤖 Sending frame to AI backend: ${aiUrl}`);
        console.log(`🎯 AI mode: ${currentAIMode}`);

        const response = await fetch(
            aiUrl,
            {
                method: 'POST',
                body: formData,
                headers: formData.getHeaders()
            }
        );

        console.log(`📡 AI backend response: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(
                `AI backend returned ${response.status} ${response.statusText} ${errorText}`
            );
        }

        const aiBuffer = await response.buffer();

        console.log(
            `✅ AI processed frame successfully: ${aiBuffer.length} bytes`
        );

        const base64Frame =
            `data:image/jpeg;base64,${aiBuffer.toString('base64')}`;

        const detections =
            response.headers.get('x-geopath-detections') || '{}';

        const events =
            response.headers.get('x-geopath-events') || '[]';

        const plateDetectorAvailable =
            response.headers.get('x-geopath-plate-available') === 'true';

        console.log(`🔍 Detections: ${detections}`);
        console.log(`🚨 Events: ${events}`);
        console.log(
            `🚘 Plate detector available: ${plateDetectorAvailable}`
        );

        dashboardClients.forEach(client => {

            if (client.readyState === WebSocket.OPEN) {

                client.send(JSON.stringify({
                    type: 'ai_frame',
                    data: base64Frame,
                    detections: JSON.parse(detections),
                    events: JSON.parse(events),
                    gps: latestGPS,
                    cameraDevice,
                    plateDetectorAvailable
                }));

            }

        });

        console.log(
            `📤 AI frame sent to ${dashboardClients.length} dashboard client(s)`
        );

    } catch (e) {

        console.error('❌ AI Backend Error:', e.message);

        if (e.cause) {
            console.error('Cause:', e.cause);
        }

    } finally {

        isProcessing = false;

    }
}


wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', async (message, isBinary) => {

        // ==========================================
        // BINARY CAMERA FRAME
        // ==========================================
        if (isBinary) {

            console.log(`Binary camera frame received: ${message.length} bytes`);

            // Send original frame to dashboard
            dashboardClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message, { binary: true });
                }
            });

            // Send frame to AI backend
            await processFrameWithAI(message);

            return;
        }

        // ==========================================
        // TEXT / JSON MESSAGE
        // ==========================================
        try {
            const data = JSON.parse(message.toString());

            if (data.type === 'dashboard') {

                if (!dashboardClients.includes(ws)) {
                    dashboardClients.push(ws);
                }

                console.log('Dashboard connected');

            } else if (data.type === 'gps') {

                latestGPS = {
                    latitude: parseFloat(data.latitude),
                    longitude: parseFloat(data.longitude)
                };

                dashboardClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(data));
                    }
                });

            } else if (data.type === 'change_mode') {

                currentAIMode = data.mode;
                console.log(`AI mode changed to: ${currentAIMode}`);

            } else if (data.type === 'camera_device') {

                cameraDevice = String(
                    data.name || 'Unknown camera'
                );

                console.log(`Camera device: ${cameraDevice}`);

            } else {

                const frame = getCameraFramePayload(data);

                if (frame) {

                    console.log('Base64/JSON camera frame received');

                    // Send to dashboard
                    relayCameraFrame(frame);

                    // Convert base64 image to Buffer
                    const base64 = frame.replace(
                        /^data:image\/[^;]+;base64,/,
                        ''
                    );

                    const buffer = Buffer.from(
                        base64,
                        'base64'
                    );

                    // Send to AI
                    await processFrameWithAI(buffer);

                } else {

                    console.log(
                        `Unrecognized WebSocket message: type=${data.type || 'none'}, keys=${Object.keys(data).join(',')}`
                    );

                }
            }

        } catch (e) {

            const text = message.toString();

            if (isEncodedImagePayload(text)) {

                console.log('Raw base64 camera frame received');

                relayCameraFrame(text);

                const base64 = text.replace(
                    /^data:image\/[^;]+;base64,/,
                    ''
                );

                const buffer = Buffer.from(
                    base64,
                    'base64'
                );

                await processFrameWithAI(buffer);

            } else {

                console.log(
                    'Ignored non-JSON WebSocket message'
                );

            }
        }
    });

    ws.on('close', () => {

        dashboardClients =
            dashboardClients.filter(
                client => client !== ws
            );

        console.log('Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Hub Server running on port ${PORT}`);
});
