---
title: "HLT-MOT: Hybrid Long-Term Multi-Object Tracking"
date: 2025-10-20
excerpt: "A computer vision tracking system that maintains consistent object identities through occlusions and re-appearances by combining DeepSORT with DINOv2-based deep re-identification."
category: "computer-vision"
featured: false
github: "https://github.com/rvxfahim/Hybrid_reID"
demo_video: "https://github.com/user-attachments/assets/13a615f8-3575-42d9-8daf-2fd5e04c2262"
technologies: ["Python", "PyTorch", "OpenCV", "YOLOv8", "DeepSORT", "DINOv2", "TensorRT", "Numba"]
---

## The Problem

Standard multi-object trackers do a decent job of following objects across consecutive frames, but they break down as soon as something leaves the frame or gets occluded. DeepSORT, for instance, uses a Kalman filter for motion prediction and a nearest-neighbor appearance matcher -- it works well for short gaps, but its internal feature representation isn't robust enough to re-identify objects after longer disappearances. The result is ID switches: the same person comes back into view and gets assigned a brand-new label, shattering any notion of persistent identity.

I wanted to build a system that could track an object through a 10-second occlusion and still know, without doubt, that it was the same person.

## The Architecture

HLT-MOT is a hybrid system that layers a custom re-identification engine on top of DeepSORT's short-term tracking. Here is how the pipeline works for each frame:

1. **Detection** -- YOLOv8 (with optional TensorRT acceleration) produces bounding boxes and segmentation masks for each object.
2. **Short-term association** -- DeepSORT handles the easy case: linking detections across adjacent frames via Kalman prediction and its built-in appearance metric.
3. **Feature extraction** -- A DINOv2 ViT-B/14 model (via PyTorch) extracts a 768-dimensional, L2-normalized embedding for each detected crop. If DINOv2 fails to load, the system falls back to ResNet50 with 2048-dim features.
4. **Online re-identification** -- When DeepSORT spawns a new track ID, the system compares its feature embedding against a gallery of features from all recently *inactive* tracks using cosine distance. If the closest match falls below a threshold (typically 0.15), the original ID is reassigned.
5. **Offline re-ID refinement** -- Every N frames, the system computes a full distance matrix between all active and inactive tracks in a single GPU-batched operation. Strong appearance matches that also pass spatial consistency checks trigger a merge of fragmented track histories.

The DINOv2 features are the backbone of this approach. Unlike the shallow appearance features DeepSORT uses internally, DINOv2 is a Vision Transformer pre-trained on 142 million images using self-supervised learning. Its embeddings are remarkably robust to changes in lighting, pose, and partial occlusion -- exactly the properties you need for long-term re-identification.

## Key Design Decisions

### Primary Object Mode

The system supports a "primary object" mode where one specific object (ID 1) gets preferential treatment. Before tracking begins, the user selects a target by clicking on a detection box or pressing a number key. From that point forward:

- The primary object's feature gallery is cached as a GPU tensor for fast cosine-similarity lookups.
- Motion predictions are maintained separately for the primary object, using a simple velocity-based model: average the last 5 position deltas and project forward.
- Re-identification thresholds are stricter, and IoU checks between the predicted and observed bounding box prevent false positives.
- When the primary object is lost, the system focuses its offline re-ID effort entirely on finding it, filtering inactive candidates by spatial proximity to the last known position.

This design is useful for applications where maintaining one specific identity is more important than tracking everyone perfectly -- for example, following a particular person through a crowded scene.

### Online vs. Offline Re-ID

The two re-ID mechanisms serve different purposes. **Online re-ID** runs at every frame: when a new track appears, it checks against the inactive gallery in real time. This catches short occlusions immediately. **Offline re-ID** runs periodically (every `re_id_interval` frames) and compares every active track against every inactive track in a single batch GPU call. This resolves cases where the same object was assigned multiple IDs after repeated occlusions, merging fragmented track histories back together.

Both modes apply spatial-temporal consistency constraints -- a match is rejected if the objects are more than 200 pixels apart or if the IoU between their bounding boxes is too low. Appearance alone is not enough; geometry grounds the decision in the physical scene.

## Performance Engineering

Real-time tracking with a Vision Transformer feature extractor is computationally demanding. The system uses several strategies to keep things practical:

- **GPU-batched feature extraction** -- Multiple object crops are stacked into a single tensor and processed in one forward pass through DINOv2, minimizing GPU transfer overhead.
- **Numba JIT acceleration** -- IoU calculations, Euclidean distance, and CPU-based cosine distance all have Numba-accelerated variants. The system detects Numba availability at import time and falls back gracefully to pure NumPy when it is not installed.
- **TensorRT inference** -- YOLO models can be exported to TensorRT engines, cutting detection latency by 2-3x on compatible NVIDIA GPUs. The `YOLODetector` handles the conversion and fallback automatically.
- **4-level graceful degradation** -- If DINOv2 fails to load, the system falls back to ResNet50. If Ultralytics YOLO is unavailable, it falls back to OpenCV DNN YOLOv4. If neither is available, a mock detector generates synthetic detections for testing. Every component has a usable fallback.
- **cProfile integration** -- Built-in profiling decorates every key function with timing instrumentation. Pressing `p` during runtime toggles per-frame timing output. At shutdown, a sorted bottleneck report and `.prof` file are saved for later analysis with tools like snakeviz.

The profiling infrastructure was especially useful during development. Being able to see, frame by frame, that `extract_features_batch` was taking 45ms while `YOLODetector.detect` was taking 12ms told me exactly where to optimize first.

## Architecture Diagrams

The repo includes four architecture diagrams that document the system from the pipeline overview down to specific decision flows, fallback chains, and object state machines.

### 1. Pipeline Overview
![HLT-MOT Pipeline — 6-frame PlantUML diagram showing Input, Detection, Feature Extraction, Tracking System, and Output](/diagrams/hlt-mot/pipeline_diagram.svg)
*The full pipeline modeled in PlantUML: Input (video frame) → Detection (YOLO/Mock fallback) → Feature Extraction (DINOv2/ResNet50 fallback) → Tracking System (DeepSORT + Re-ID + Feature Gallery + Motion Prediction) → Output (visualization, video, stats). This is the architectural blueprint -- components, data stores, fallback paths, and cross-frame feedback loops all visible in one view.*

### 2. Re-ID Decision Flow
![Re-ID Decision Flow -- activity diagram showing how new tracks get persistent IDs](/diagrams/hlt-mot/reid_decision_flow.svg)
*The complete decision tree executed when a new DeepSORT track needs a persistent identity. First, a primary-object check (cosine distance < 0.2 against the primary gallery, plus IoU verification). If that fails, online Re-ID queries all inactive feature galleries (cosine distance < 0.15 with a 200px spatial distance cap). If no match is found, a brand-new ID is assigned. Periodically (every `re_id_interval` frames), offline Re-ID runs a batched GPU comparison of all active x inactive tracks, applies IoU consistency checks, and merges fragmented track histories.*

### 3. Graceful Degradation Chain
![Graceful Degradation -- multi-level fallback hierarchy across all subsystems](/diagrams/hlt-mot/graceful_degradation.svg)
*The 4-level fallback hierarchy that makes the system robust to missing dependencies. Detection: Ultralytics YOLOv8/v11 (GPU, ~12ms) → OpenCV DNN YOLOv4 (CPU) → Mock detector (testing). Feature extraction: DINOv2 ViT-B/14 (GPU, 768-dim, ~45ms) → ResNet50 (2048-dim). Performance ops: Numba JIT → pure NumPy/Python. Each tier is checked at import time; the system logs which tier is active and degrades silently. The end-to-end tracking pipeline continues to function (with reduced accuracy) even if only the mock detector and ResNet50 are available.*

### 4. Primary Object State Machine
![Primary Object Lifecycle -- state machine showing the states of the primary tracked object (ID 1)](/diagrams/hlt-mot/primary_object_states.svg)
*The lifecycle of the primary tracked object from selection through active tracking, loss, and re-acquisition. The system starts in SELECTING (user clicks on a detection), transitions to ACTIVE_TRACKING once the target is confirmed, and enters LOST when no detection arrives for > max_age DeepSORT frames. In the LOST state, a primary-only offline Re-ID mode kicks in with relaxed thresholds (0.25 cosine distance, 300px spatial filter via Kalman prediction). If a match passes IoU verification (> 0.1 within 5 frames), the ID is re-acquired; otherwise the search continues.*

## What I Learned

The biggest lesson was that **appearance matching alone is not enough**. Early versions of the system tried to re-identify objects purely by DINOv2 cosine distance, and it produced false positives whenever two people wore similar-colored clothing. Adding spatial-temporal constraints -- IoU checks, velocity-based motion prediction, and a 200-pixel spatial distance cap -- dramatically reduced ID switches. The geometry of the scene grounds the appearance signal in physical plausibility.

I also learned that gallery management matters a lot. Storing every feature vector for every object is both memory-prohibitive and counterproductive -- stale features from minutes ago can cause false matches. The system caps each gallery at 5,000 features and uses a simple FIFO eviction policy, which is a reasonable heuristic but could be improved with a recency-weighted scheme.

## Limitations and Future Work

The system is computationally heavy -- running YOLO, DeepSORT, and DINOv2 on every frame pushes the limits of real-time on consumer GPUs. Fine-tuning DINOv2 on domain-specific data (person re-ID datasets like Market-1501) would likely improve accuracy and allow a lighter model. I am also interested in exploring graph-based optimization for the offline association step and extending the system to multi-camera re-identification.
