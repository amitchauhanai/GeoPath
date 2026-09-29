# GeoPath

GeoPath is a local road-scene monitoring dashboard. It combines YOLO road segmentation with vehicle/person and road-sign detection, displays annotated camera frames, and tracks class counts in a browser interface.

## Models

The backend loads these checkpoints from the project root:

- Road segmentation: `models/Road segment/models/best_yolo26_seg.pt`
- Vehicle/person detection: `models/Vehicle_Person_YOLOv26/yolov26_vehicle_person/train_exp/weights/best.pt`
- Road-sign detection: `models/Road_Sign_YOLOv26*/best_detector.pt`

The road-sign directory is discovered using the `Road_Sign_YOLOv26*` prefix because the current directory name contains a trailing space. The detector searches that directory for `best_detector.pt`.

Segmentation classes: `road`, `pothole`, `road_damage`, `divider`, `outer_lane_marking`, `middle_lane_marking`, `zebra_crossing`, `waterlogging`, and `speed_breaker`.

The vehicle/person detector recognizes `person`, `bicycle`, `motorcycle`, `car`, `auto_rickshaw`, `bus`, `truck`, and `tractor`. The road-sign detector recognizes `traffic_sign`.

## Requirements

- macOS or Linux
- Python 3.14 (or a Python version supported by the installed PyTorch and Ultralytics wheels)
- Node.js and npm
- A browser with camera access; allow permission when prompted
- All three model checkpoint files listed above

## Setup

Run commands from the project root.

Create and install the backend environment:

```sh
python3 -m venv backend_ai/.venv
backend_ai/.venv/bin/python -m pip install -r backend_ai/requirements.txt
```

Install the dashboard dependencies:

```sh
npm ci --prefix server_hub
```

## Run

Start each service in a separate terminal from the project root.

Terminal 1, AI backend:

```sh
backend_ai/.venv/bin/python -m uvicorn backend_ai.main:app --host 10.34.66.150 --port 8000
```

Terminal 2, web dashboard and WebSocket hub:

```sh
node server_hub/server.js
```

On this network, open the dashboard at <http://10.34.66.150:3000> and the API documentation at <http://10.34.66.150:8000/docs>. Stop either service with `Ctrl+C` in its terminal.

## Camera

The dashboard is a receiver and does not request camera permission. Connect the separate mobile camera app to `ws://10.34.66.150:3000` on the same network. Send frames as binary JPEG messages for both the RGB display and AI processing.

JSON frame messages and raw data-URL/base64 text are also supported for the RGB display. JSON payload fields include `frame`, `image`, `data`, `base64`, `payload`, `imageData`, `frameData`, `jpeg`, and `jpg`; payloads may be base64 strings, byte arrays, or Node Buffer JSON objects. A `frame`, `camera_frame`, `video_frame`, or `image` type is also recognized. Access the dashboard at its local HTTP address. The rear-camera panel is a placeholder and does not currently capture a second stream.

## Processing modes

The AI camera page has two independent controls:

- **Vehicles, people & road signs** runs both detection checkpoints.
- **Road segmentation** runs the nine-class segmentation checkpoint.

Both are enabled by default. The backend endpoint also accepts `mode=both`, `mode=det`, `mode=seg`, or `mode=none`:

```text
POST http://127.0.0.1:8000/process_frame?mode=both
```

Send the frame as multipart form data under the field name `file`. The response body is an annotated JPEG; detected class counts are returned in the `X-GeoPath-Detections` response header as JSON.
