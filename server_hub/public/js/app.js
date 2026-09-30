const serverProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const serverUrl = `${serverProtocol}://192.168.1.37:3000`;
const ws = new WebSocket(serverUrl);
const pages = document.querySelectorAll('.page');
const navItems = document.querySelectorAll('.nav-item');
const rgbCanvas = document.getElementById('rgbCanvas');
const segCanvas = document.getElementById('segCanvas');
const rgbContext = rgbCanvas.getContext('2d');
const segContext = segCanvas.getContext('2d');
const counts = {};
const classGroups = { road: 'ROAD SURFACE', pothole: 'ROAD DEFECT', road_damage: 'ROAD DEFECT', divider: 'INFRASTRUCTURE', outer_lane_marking: 'MARKING', middle_lane_marking: 'MARKING', zebra_crossing: 'MARKING', waterlogging: 'ROAD DEFECT', manhole: 'HAZARD', speed_breaker: 'HAZARD', road_edge: 'ROAD SURFACE', person: 'ROAD USER', bicycle: 'ROAD USER', motorcycle: 'ROAD USER', car: 'VEHICLE', auto_rickshaw: 'VEHICLE', bus: 'VEHICLE', truck: 'VEHICLE', traffic_sign: 'SIGNAL', traffic_light: 'SIGNAL', number_plate: 'EVIDENCE' };
const reportClasses = ['pothole', 'road_damage', 'divider', 'outer_lane_marking', 'middle_lane_marking', 'zebra_crossing', 'waterlogging', 'speed_breaker'];
const taxonomyClasses = ['road', ...reportClasses, 'person', 'bicycle', 'motorcycle', 'car', 'auto_rickshaw', 'bus', 'truck', 'tractor', 'traffic_sign'];
let currentLat = 28.6139;
let currentLng = 77.2090;
let map;
let mapTile;
let mapMarker;
let sessionStarted = Date.now();
const eventMarkers = new Map();
const layerVisibility = {};
const vehicleEvents = [];
const roadEvents = [];
const recentEvents = new Map();
let cameraDevice = 'Unknown camera';

function showPage(id) {
    pages.forEach(page => page.classList.toggle('active', page.id === `page-${id}`));
    navItems.forEach((item, index) => item.classList.toggle('active', index === id - 1));
    if (id === 3 && map) setTimeout(() => map.invalidateSize(), 120);
}

function syncMode() {
    const detection = document.getElementById('detToggle').checked;
    const segmentation = document.getElementById('segToggle').checked;
    const mode = detection && segmentation ? 'both' : detection ? 'det' : segmentation ? 'seg' : 'none';
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'change_mode', mode }));
    document.getElementById('modelState').textContent = detection || segmentation ? `ACTIVE · ${mode.toUpperCase()}` : 'PAUSED';
}

function clearDetections() {
    Object.keys(counts).forEach(key => delete counts[key]);
    vehicleEvents.length = 0;
    roadEvents.length = 0;
    recentEvents.clear();
    renderCounts();
    renderAnalysis();
    renderEventLogs();
}

function prettyName(value) { return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()); }

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function formatEventTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function renderEventLogs() {
    const vehicleRows = document.getElementById('vehicleEventRows');
    const roadRows = document.getElementById('roadEventRows');
    vehicleRows.innerHTML = vehicleEvents.length ? vehicleEvents.map(event => {
        const type = event.kind === 'person' ? '—' : prettyName(event.label);
        const personOrVehicle = event.kind === 'person' ? 'Person' : 'Vehicle';
        const plate = event.numberplate === null ? 'Unavailable · no plate class' : event.numberplate ? 'Plate region detected' : 'Not detected';
        return `<tr><td>${escapeHtml(formatEventTime(event.timestamp))}</td><td>${personOrVehicle}</td><td>${escapeHtml(type)}</td><td>${plate}</td><td>${escapeHtml(event.longitude)}</td><td>${escapeHtml(event.latitude)}</td><td>${escapeHtml(event.cameraDevice)}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-cell">Waiting for detections...</td></tr>';
    roadRows.innerHTML = roadEvents.length ? roadEvents.map(event => `<tr><td>${escapeHtml(formatEventTime(event.timestamp))}</td><td>${escapeHtml(prettyName(event.label))}</td><td>${escapeHtml(event.longitude)}</td><td>${escapeHtml(event.latitude)}</td><td>${escapeHtml(Math.round(event.area).toLocaleString())}</td><td>${escapeHtml(event.cameraDevice)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-cell">Waiting for road defects...</td></tr>';
}

function recordEvents(events, gps, device, plateAvailable) {
    document.getElementById('plateModelState').textContent = plateAvailable ? 'PLATE DETECTOR READY' : 'PLATE CLASS MISSING';
    if (device) cameraDevice = device;
    const now = Date.now();
    for (const [key, lastSeen] of recentEvents) if (now - lastSeen > 15000) recentEvents.delete(key);
    (events || []).forEach(event => {
        const box = event.box || [0, 0, 0, 0];
        const position = gps && Number.isFinite(Number(gps.latitude)) && Number.isFinite(Number(gps.longitude))
            ? `${Number(gps.latitude).toFixed(4)},${Number(gps.longitude).toFixed(4)}` : 'unknown-location';
        const key = `${event.kind}:${event.label}:${Math.round((box[0] + box[2]) / 160)}:${Math.round((box[1] + box[3]) / 90)}:${position}`;
        if (now - (recentEvents.get(key) || 0) < 15000) return;
        recentEvents.set(key, now);
        const entry = {
            ...event,
            latitude: position === 'unknown-location' ? '—' : Number(gps.latitude).toFixed(6),
            longitude: position === 'unknown-location' ? '—' : Number(gps.longitude).toFixed(6),
            cameraDevice: cameraDevice || 'Unknown camera',
        };
        const list = event.kind === 'road_defect' ? roadEvents : vehicleEvents;
        list.unshift(entry);
        if (list.length > 50) list.length = 50;
    });
    renderEventLogs();
}

function mergeCounts(nextCounts) {
    Object.entries(nextCounts || {}).forEach(([label, value]) => { counts[label] = (counts[label] || 0) + value; });
    renderCounts();
    renderAnalysis();
}

function renderCounts() {
    const list = document.getElementById('classList');
    const active = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    list.innerHTML = active.length ? active.map(([label, value]) => `<div class="class-row"><span><i class="class-dot"></i>${prettyName(label)}</span><strong>${value}</strong></div>`).join('') : '<p class="empty-state">Waiting for model output...</p>';
    document.getElementById('frameSummary').textContent = active.length ? `${active.length} classes observed · live session` : 'Waiting for frames';
    document.getElementById('mapHazardCount').textContent = reportClasses.reduce((total, label) => total + (counts[label] || 0), 0);
}

function renderAnalysis() {
    document.getElementById('statGrid').innerHTML = reportClasses.slice(0, 4).map((label, index) => `<div class="stat-card tone-${index}"><span>${prettyName(label)}</span><strong>${counts[label] || 0}</strong><small>${counts[label] ? 'Detected on route' : 'No event logged'}</small></div>`).join('');
    const max = Math.max(1, ...reportClasses.map(label => counts[label] || 0));
    document.getElementById('barChart').innerHTML = reportClasses.map(label => `<div class="bar-row"><span>${prettyName(label)}</span><div><i style="width:${Math.round(((counts[label] || 0) / max) * 100)}%"></i></div><strong>${counts[label] || 0}</strong></div>`).join('');
    document.getElementById('taxonomy').innerHTML = taxonomyClasses.map(label => `<span class="taxonomy-pill ${counts[label] ? 'seen' : ''}">${prettyName(label)}${counts[label] ? ` · ${counts[label]}` : ''}</span>`).join('');
    document.getElementById('analysisSession').textContent = `LIVE / ${formatDuration(Date.now() - sessionStarted)}`;
    document.getElementById('lastSync').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateMap(lat, lng) {
    currentLat = lat;
    currentLng = lng;
    if (map) { mapMarker.setLatLng([lat, lng]); map.panTo([lat, lng]); }
    document.getElementById('frontLocation').textContent = `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E`;
    document.getElementById('aiLocation').textContent = `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E`;
}

function changeMapType(type) {
    if (mapTile) map.removeLayer(mapTile);
    mapTile = type === 'normal' ? L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }) : L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Esri' });
    mapTile.addTo(map);
}

function buildMap() {
    map = L.map('mainMap', { zoomControl: false }).setView([currentLat, currentLng], 15);
    changeMapType('normal');
    mapMarker = L.circleMarker([currentLat, currentLng], { radius: 8, color: '#f8f4e8', weight: 3, fillColor: '#ef6c4d', fillOpacity: 1 }).addTo(map).bindTooltip('BUS 07 · LIVE');
    L.polyline([[28.6132, 77.2078], [28.6139, 77.2090], [28.6150, 77.2100]], { color: '#ef6c4d', weight: 5, opacity: 0.9 }).addTo(map);
    document.getElementById('layerList').innerHTML = reportClasses.map((label, index) => `<label class="layer-row"><input type="checkbox" checked onchange="toggleLayer('${label}', this.checked)"><i class="layer-swatch swatch-${index}"></i>${prettyName(label)}</label>`).join('');
}

function toggleLayer(label, visible) {
    layerVisibility[label] = visible;
    const marker = eventMarkers.get(label);
    if (marker) marker.setStyle({ opacity: visible ? 1 : 0, fillOpacity: visible ? 0.85 : 0 });
}

function plotEvents(detections, gps) {
    if (!gps || !map) return;
    Object.keys(detections || {}).filter(label => reportClasses.includes(label)).forEach(label => {
        let marker = eventMarkers.get(label);
        if (!marker) {
            marker = L.circleMarker([gps.latitude, gps.longitude], { radius: 7, color: '#fffdf7', weight: 2, fillColor: '#ef6c4d', fillOpacity: 0.85 }).addTo(map);
            eventMarkers.set(label, marker);
        }
        marker.setLatLng([gps.latitude, gps.longitude]).bindTooltip(`${prettyName(label)} · ${detections[label]} observed`);
        toggleLayer(label, layerVisibility[label] !== false);
    });
}

ws.onopen = () => { document.getElementById('connectionLabel').textContent = 'CONNECTED'; ws.send(JSON.stringify({ type: 'dashboard' })); ws.send(JSON.stringify({ type: 'camera_device', name: cameraDevice })); syncMode(); };
ws.onclose = () => { document.getElementById('connectionLabel').textContent = 'OFFLINE'; };
ws.onerror = () => { document.getElementById('connectionLabel').textContent = 'RECONNECTING'; };
function renderCameraFrame(source, revokeSource = false) {
    const image = new Image();
    image.onload = () => {
        rgbContext.drawImage(image, 0, 0, rgbCanvas.width, rgbCanvas.height);
        document.getElementById('cameraState').textContent = 'VIDEO FEED · LIVE';
        if (revokeSource) URL.revokeObjectURL(source);
    };
    image.onerror = () => {
        document.getElementById('cameraState').textContent = 'UNSUPPORTED FRAME FORMAT';
        if (revokeSource) URL.revokeObjectURL(source);
    };
    image.src = source.startsWith('data:') || source.startsWith('blob:') || source.startsWith('http')
        ? source
        : `data:image/jpeg;base64,${source}`;
}
ws.onmessage = event => {
    if (event.data instanceof Blob) {
        renderCameraFrame(URL.createObjectURL(event.data), true);
        return;
    }
    const data = JSON.parse(event.data);
    if (data.type === 'gps') updateMap(parseFloat(data.latitude), parseFloat(data.longitude));
    const frameType = String(data.type || '').toLowerCase().replace(/[-_]/g, '');
    const framePayload = data.frame ?? data.image ?? data.data ?? data.base64 ?? data.payload ?? data.imageData ?? data.frameData ?? data.jpeg ?? data.jpg;
    if (['frame', 'cameraframe', 'videoframe', 'image'].includes(frameType) && typeof framePayload === 'string') {
        renderCameraFrame(framePayload);
    }
    if (data.type === 'ai_frame') {
        const image = new Image();
        image.onload = () => { segContext.drawImage(image, 0, 0, segCanvas.width, segCanvas.height); };
        image.src = data.data;
        mergeCounts(data.detections);
        recordEvents(data.events, data.gps, data.cameraDevice, data.plateDetectorAvailable);
        plotEvents(data.detections, data.gps);
    }
};

buildMap();
renderAnalysis();
renderEventLogs();
setInterval(() => renderAnalysis(), 1000);
