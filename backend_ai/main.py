from pathlib import Path
from datetime import datetime, timezone
import json
from typing import cast

from fastapi import FastAPI, UploadFile, File, Query
from fastapi.responses import JSONResponse, Response, StreamingResponse
from ultralytics import YOLO
from ultralytics.engine.results import Results
import cv2
import numpy as np
import io

app = FastAPI()

@app.get("/")
async def api_status():
    return {"status": "ok", "docs": "/docs"}

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)

project_root = Path(__file__).resolve().parent.parent
models_root = project_root / "models"
vehicle_model_path = models_root / "Vehicle_Person_YOLOv26" / "yolov26_vehicle_person" / "train_exp" / "weights" / "best.pt"
seg_model_path = models_root / "Road segment" / "models" / "best_yolo26_seg.pt"
number_plate_model_path = models_root / "Vehicle_Number_Plate" / "yolo26n.pt"
road_sign_dir = next(
    (path for path in models_root.glob("Road_Sign_YOLOv26*") if path.is_dir()),
    models_root / "Road_Sign_YOLOv26",
)
road_sign_model_path = road_sign_dir / "best_detector.pt"

vehicle_model: YOLO | None = None
road_sign_model: YOLO | None = None
seg_model: YOLO | None = None
number_plate_model: YOLO | None = None
number_plate_class_ids: list[int] = []
number_plate_available = False

SEGMENT_ALLOWED_CLASSES = {
    "road",
    "pothole",
    "road_damage",
    "divider",
    "outer_lane_marking",
    "middle_lane_marking",
    "zebra_crossing",
    "waterlogging",
    "speed_breaker",
}

SUPPORTED_MODES = {"both", "det", "seg", "none"}


def load_models(include_detection=True, include_segmentation=True, include_plate=True):
    global vehicle_model, road_sign_model, seg_model, number_plate_model, number_plate_class_ids, number_plate_available

    required_paths = []
    if include_detection:
        required_paths.extend([
            ("Vehicle/person detection", vehicle_model_path),
            ("Road-sign detection", road_sign_model_path),
        ])
    if include_plate:
        required_paths.append(("Number-plate detection", number_plate_model_path))
    if include_segmentation:
        required_paths.append(("Road segmentation", seg_model_path))

    for label, path in required_paths:
        if not path.is_file():
            raise FileNotFoundError(f"{label} model not found: {path}")

    if include_detection and vehicle_model is None:
        vehicle_model = YOLO(str(vehicle_model_path))
    if include_detection and road_sign_model is None:
        road_sign_model = YOLO(str(road_sign_model_path))
    if include_segmentation and seg_model is None:
        seg_model = YOLO(str(seg_model_path))
    if include_plate and number_plate_model is None:
        number_plate_model = YOLO(str(number_plate_model_path))
        class_names = getattr(number_plate_model, "names", {}) or {}
        number_plate_class_ids = [
            class_id for class_id, class_name in class_names.items()
            if "plate" in str(class_name).lower() or "license" in str(class_name).lower()
        ]
        number_plate_available = bool(number_plate_class_ids)


def get_allowed_segmentation_classes():
    class_names = getattr(seg_model, "names", {}) or {}
    allowed_ids = [class_id for class_id, class_name in class_names.items() if class_name in SEGMENT_ALLOWED_CLASSES]
    return allowed_ids


def run_model(model, image, classes=None, conf=0.25):
    assert model is not None
    predictions = model.predict(
        source=image,
        verbose=False,
        conf=conf,
        classes=classes,
    )
    return cast(list[Results], predictions)


def count_results(results):
    counts = {}
    for result in results:
        names = result.names
        for class_id in result.boxes.cls.tolist() if result.boxes is not None else []:
            label = names[int(class_id)]
            counts[label] = counts.get(label, 0) + 1
    return counts


def get_box_detections(results):
    detections = []
    for result in results:
        if result.boxes is None:
            continue
        for box, class_id, confidence in zip(
            result.boxes.xyxy.tolist(),
            result.boxes.cls.tolist(),
            result.boxes.conf.tolist(),
        ):
            detections.append({
                "label": result.names[int(class_id)],
                "confidence": float(confidence),
                "box": [float(value) for value in box],
            })
    return detections


def get_road_defect_events(results):
    events = []
    for result in results:
        if result.boxes is None:
            continue
        polygons = result.masks.xy if result.masks is not None else []
        for index, (box, class_id, confidence) in enumerate(zip(
            result.boxes.xyxy.tolist(),
            result.boxes.cls.tolist(),
            result.boxes.conf.tolist(),
        )):
            label = result.names[int(class_id)]
            if label not in {"pothole", "road_damage"}:
                continue
            area = 0.0
            if index < len(polygons) and len(polygons[index]) >= 3:
                contour = np.asarray(polygons[index], dtype=np.float32)
                area = float(cv2.contourArea(contour))
            if area <= 0:
                area = max(0.0, float(box[2] - box[0])) * max(0.0, float(box[3] - box[1]))
            events.append({
                "kind": "road_defect",
                "label": label,
                "confidence": float(confidence),
                "box": [float(value) for value in box],
                "area": area,
            })
    return events

@app.post("/process_frame")
async def process_frame(file: UploadFile = File(...), mode: str = Query("both")):
    if mode not in SUPPORTED_MODES:
        return JSONResponse(
            status_code=400,
            content={"detail": f"mode must be one of: {', '.join(sorted(SUPPORTED_MODES))}"},
        )

    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        return JSONResponse(status_code=400, content={"detail": "Invalid image frame"})

    original = img.copy()
    img = original.copy()
    detection_counts = {}
    events = []
    frame_timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if mode in ["det", "both"]:
        load_models(include_segmentation=False)
        vehicle_results = run_model(vehicle_model, original)
        sign_results = run_model(road_sign_model, original)
        vehicle_detections = get_box_detections(vehicle_results)
        plate_detections = []
        if number_plate_available:
            plate_results = run_model(number_plate_model, original, classes=number_plate_class_ids, conf=0.2)
            plate_detections = get_box_detections(plate_results)
            detection_counts.update(count_results(plate_results))
        for detection in vehicle_detections:
            label = detection["label"]
            detection_counts[label] = detection_counts.get(label, 0) + 1
            if label == "person" or label in {"bicycle", "motorcycle", "car", "auto_rickshaw", "bus", "truck", "tractor"}:
                vehicle_box = detection["box"]
                has_plate = any(
                    vehicle_box[0] <= (plate["box"][0] + plate["box"][2]) / 2 <= vehicle_box[2]
                    and vehicle_box[1] <= (plate["box"][1] + plate["box"][3]) / 2 <= vehicle_box[3]
                    for plate in plate_detections
                )
                events.append({
                    "kind": "person" if label == "person" else "vehicle",
                    "label": label,
                    "confidence": detection["confidence"],
                    "box": vehicle_box,
                    "numberplate": has_plate if number_plate_available else None,
                    "timestamp": frame_timestamp,
                })
        detection_counts.update(count_results(sign_results))
        img = vehicle_results[0].plot(img=img)
        img = sign_results[0].plot(img=img)
        if number_plate_available and plate_detections:
            img = plate_results[0].plot(img=img)

    if mode in ["seg", "both"]:
        load_models(include_detection=False, include_plate=False)
        assert seg_model is not None
        allowed_seg_classes = get_allowed_segmentation_classes()
        seg_results = run_model(seg_model, original, allowed_seg_classes)
        for label, count in count_results(seg_results).items():
            if label in SEGMENT_ALLOWED_CLASSES:
                detection_counts[label] = detection_counts.get(label, 0) + count
        events.extend(get_road_defect_events(seg_results))
        img = seg_results[0].plot(img=img)

    for event in events:
        event["timestamp"] = frame_timestamp

    _, encoded_img = cv2.imencode('.jpg', img, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    response = StreamingResponse(io.BytesIO(encoded_img.tobytes()), media_type="image/jpeg")
    response.headers["X-GeoPath-Detections"] = json.dumps(detection_counts)
    response.headers["X-GeoPath-Events"] = json.dumps(events[:100])
    response.headers["X-GeoPath-Plate-Available"] = str(number_plate_available).lower()
    return response