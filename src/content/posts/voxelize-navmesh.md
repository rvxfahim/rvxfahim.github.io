---
title: "Voxelize Navmesh: Dynamic Obstacle Avoidance with ROS 2"
date: 2024-06-10
excerpt: "A complete ROS 2 system that converts live LiDAR point clouds into dynamic navigation mesh obstacles, enabling real-time crowd-aware robot navigation with Recast/Detour."
summary: "A complete ROS 2 system that converts live LiDAR point clouds into dynamic navigation mesh obstacles. Uses a C++/Python hybrid architecture: a C++ voxelizer ingests LiDAR at sensor rate, subtracts the static map with Chebyshev neighbourhood probes, and publishes only dynamic foreground points. A Python co-simulation node clusters those points into cylinders and injects them into a Detour tile cache — rebuilding only the overlapping tiles in under a millisecond each."
category: "robotics"
featured: true
github: "https://github.com/rvxfahim/voxelize_navmesh"
demo_video: "https://github.com/user-attachments/assets/838e1d9c-772a-4f4b-bf73-43adc92c6b16"
technologies: ["C", "C++", "Python", "ROS 2", "PCL", "Recast/Detour", "Open3D", "PyQt5", "CMake"]
---

## The Problem

Mobile robots navigating dynamic environments face a fundamental tension. Navigation meshes -- the go-to spatial representation for pathfinding since they encode walkable surfaces as a connected graph of convex polygons -- are usually built once from a static map. They work beautifully in structured factories or warehouse aisles. But the moment a person steps into the robot's path, a box is dropped on the floor, or a cart is repositioned, the static navmesh is wrong.

You could rebuild the entire navmesh every frame. It is technically possible: Recast can regenerate a mesh from scratch in tens to hundreds of milliseconds for moderately sized environments. But that is an order of magnitude slower than the 30 Hz update rate of a typical LiDAR. You would be dropping scans, accumulating latency, and wasting compute on geometry that has not changed.

I needed a system that could ingest live point cloud data at sensor rate, extract only what had changed, and update the navigation graph in place -- without touching the static structure of the environment.

## The Full Pipeline

The system is split across three ROS 2 packages that chain together into a real-time obstacle avoidance loop:

**1. Voxelizer Node (C++, PCL)**

The entry point is a C++ ROS 2 node (`voxelizer_node.cpp`) that subscribes to raw LiDAR data. On each incoming `sensor_msgs::PointCloud2`, it runs a six-stage pipeline: range filter the points in sensor frame, transform them to the map frame using either a combined pose-plus-TF chain or a fallback full-TF lookup, downsample with `pcl::VoxelGrid`, snap every surviving point to its voxel centre, subtract voxels that overlap the static map within a configurable Chebyshev radius, and publish both the full voxelised cloud and the remaining "foreground" cloud separately.

The map subtraction is the most interesting part. The node maintains an `std::unordered_set<VoxelKey>` indexed from a static map point cloud (loaded at startup or received on `/initial_map`). For each incoming LiDAR voxel, it checks a neighbourhood of `(2R+1)^3` Chebyshev offsets against the set. A single hit means the voxel is static and should be suppressed from the foreground output. At radius 2, that is 125 hash lookups per voxel -- but early exit means most static points resolve in one or two probes, and the expensive worst case (all 125 misses) only happens for genuine dynamic content that we want downstream.

**2. Obstacle Clustering (Python, 3D BFS, Cylinder Fitting)**

The foreground cloud is consumed by a Python co-simulation node. A `TileCacheObstacleManager` voxelises the live points into a sparse 3D occupancy grid and runs a flood-fill connected-component labelling over it using 6-adjacency BFS. Each connected component that exceeds a minimum voxel count gets fitted with a bounding cylinder: the XY centroid gives the centre, the maximum radial distance plus padding gives the radius, and the Z extent of the cluster plus padding gives the height.

**3. TileCache Injection (C++ Bridge via ctypes)**

Each cylinder is injected into a Detour tile cache through a C++ bridge library -- 1520 lines of C shim compiled to a shared object and called from Python via ctypes. The tile cache is the secret sauce: it stores the uncompressed heightfield layers per tile. When a cylinder obstacle is added, only the tiles whose bounds overlap that obstacle are rebaked. A single tile (say, 3.2 m x 3.2 m at 0.1 m cell size) rebuilds in under a millisecond. Compare that to rebuilding the entire mesh -- the speedup is transformative.

**4. Crowd Navigation (Power Cosine Gating)**

With the navmesh updated, a `dtCrowd` of agents navigates around the obstacles. The robot agent uses a custom obstacle avoidance profile (extended horizon time, higher weight on time-to-impending-collision) and a Power Cosine Gating steering law: linear velocity is scaled by `|cos(angular_error)|^4`, sharpening the turn-in-place behaviour. At power factor 4, the robot starts moving forward only when it is already aligned with the desired direction, producing crisp, oscillation-free trajectories.

## Two Complementary Approaches

The repo implements two strategies for dynamic obstacles, each suited to different tradeoffs:

**Crowd-agent pool** (`simulate_crowd_cosim.py`): Each foreground point is added as a zero-velocity crowd agent. This is fast, simple, and leverages Detour's built-in avoidance model. The downside is scaling: above a few hundred agents, the pairwise avoidance computation becomes expensive, and each agent occupies a slot in the `dtCrowd` pool. Parameters like `dyn_obstacle_max` keep the pool bounded with FIFO eviction.

**TileCache cylinder injection** (`simulate_obstacle_cosim.py`): Foreground points are clustered into geometric cylinders and injected as actual navmesh obstacles. This approach is more computationally expensive per frame (clustering + tile rebuilds) but scales to thousands of points because it collapses them into a small number of obstacle primitives. It also produces a visually cleaner result since the navmesh is genuinely updated rather than relying on agent-agent avoidance heuristics.

Both approaches subscribe to `/foreground_cloud` and share the same upstream pipeline. A launch parameter (`dyn_obstacle_source`) toggles between them -- or disables dynamic obstacles entirely for baseline testing.

## Engineering Depth

**C++/Python hybrid architecture.** The heavy lifting is in C++: the voxelizer node, the entire Recast/Detour pipeline, navmesh baking, path queries, crowd simulation, and tile cache management. Python wraps every C function through ctypes bindings -- the build settings, crowd agent params, obstacle avoidance params, and every API entry point are explicitly typed with `argtypes` and `restype` for ABI safety. The bridge loader searches seven candidate paths for the compiled `.so`, including the colcon install prefix, build directories, and fallback locations.

**Custom rcContext.** Recast's build pipeline requires a `rcContext` for logging and progress. The standard implementation uses virtual inheritance, which caused RTTI issues when linking Recast as a static library. I wrote a `MinimalRecastContext` -- a thin wrapper that avoids v-table dispatch by constructing the `rcContext` with `false` (disabling logging and timers entirely). This is not a compromise for production, but for the build tool and co-simulation use cases, the diagnostic output was unnecessary overhead.

**Full Recast build pipeline.** The solo mesh baker (`nm_build_solo_from_obj`) runs every stage of the canonical Recast pipeline in sequence:
- Heightfield allocation and rasterization of input triangles
- Walkable triangle marking by slope angle
- Three configurable filters (low-hanging obstacles, ledge spans, low-height spans)
- Compact heightfield construction
- Walkable area erosion by agent radius
- Region partitioning (watershed, monotone, or layers)
- Contour generation with edge length limits
- PolyMesh generation with configurable vertices-per-polygon
- Detail mesh with sample distance and error thresholds
- Detour navmesh data creation and initialization

The tiled builder (`nm_build_tiled_with_cache`) extends this by rasterizing per-tile compressed heightfield layers, using `dtBuildTileCacheLayer` to pack them into a dense byte format with FastLZ compression, then building the final navmesh tiles with `tc->buildNavMeshTilesAt`. The `.tcbin` persistence format packages all compressed tile blobs alongside the `dtTileCacheParams` and `dtNavMeshParams` headers.

**Navigation features.** Beyond basic pathfinding, the bridge supports `findNearestPoly` for snapping arbitrary positions to the navmesh, `findPath` for polygonal corridors, `findStraightPath` for string-pulled waypoints, and a full `dtCrowd` implementation with agent lifecycle management, velocity-based and target-based movement, teleportation, corridor-aware position syncing (critical for real-robot setups where odometry drives the position but the navigation state must stay coherent), and obstacle avoidance parameter tuning.

## Tooling

**PyQt5 navmesh baker GUI.** The `navmesh_baker` application presents a complete GUI for baking navmeshes from OBJ files. It exposes every Recast build parameter -- cell size, agent dimensions, region sizes, edge parameters, partition type (watershed/monotone/layers), and filter toggles -- through form controls, with an Open3D preview window showing the result. It also includes a CLI tile-cache baker (`bake_tcbin.py`) for headless batch processing.

**Multiple launch configurations.** The repo provides six launch files: the obstacle co-simulation, the crowd co-simulation, a stand-alone crowd sim, a navmesh baker launcher, a test co-sim, and the voxelizer node launch. Each exposes 10-15 tunable parameters through ROS 2's launch system.

**Coordinate system handling.** Blender exports Z-up. Recast/Detour uses Y-up. The OBJ loading code swaps `y` and `z` on load, reverses face winding for correct triangle orientation, and the Python wrappers transparently convert between `_coords.to_yup()` and `_coords.to_zup()` on every API boundary. A `reorient_obj.py` script pre-converts OBJ files for offline use.

## Documentation

The repo includes `map_subtraction_analysis.md` -- a self-contained design document that works through the tradeoff between the current `O((2R+1)^3)` neighbourhood-search approach and a hypothetical pre-inflated map approach. It analyses the memory cost (blowing up a million-point map to a thick hash set), the CPU tradeoff (worst-case 125 misses for genuine foreground points), and the live-tuning constraint (re-inflating at runtime would stall the executor for seconds). It is the kind of document that matters on a team: it captures a design decision, the alternatives considered, and the conditions under which you would revisit it.

## Architecture Diagrams

These three diagrams document the system architecture, data flow, and ROS 2 node topology.

### 1. System Architecture
![System Architecture — ROS 2 packages, C++/Python hybrid, ctypes bridge](/diagrams/voxelize-navmesh/system_architecture.svg)
*The three ROS 2 packages and their relationships: `pointcloud_voxelizer` (C++ LiDAR processing node), `voxnav` (C++/Python hybrid with navmesh bridge shared library and ctypes bindings), and `recastnavigation` (upstream git submodule). Also shows the two co-simulation approaches and the coordinate conversion layer.*

### 2. Data Flow Sequence
![Data Flow Sequence — LiDAR to navigation command](/diagrams/voxelize-navmesh/data_flow_sequence.svg)
*The full pipeline from LiDAR scan to robot command: range filtering, transform, voxel downsampling, Chebyshev map subtraction, foreground cloud clustering via 3D BFS, cylinder fitting, and the two alternative dynamic obstacle strategies (crowd-agent pool vs. tile cache cylinder injection). Ends with Power Cosine Gating steering.*

### 3. ROS 2 Node and Topic Graph
![ROS 2 Node and Topic Graph — nodes, topics, launch parameters](/diagrams/voxelize-navmesh/ros_node_topic_graph.svg)
*The ROS 2 computational graph: `voxelizer_node` subscribes to LiDAR and publishes `/foreground_cloud`. Two co-simulation nodes (`simulate_obstacle_cosim` and `simulate_crowd_cosim`) both consume the same foreground cloud but use different dynamic obstacle strategies, toggled via the `dyn_obstacle_source` launch parameter.*

## What I Learned

Building this system taught me the Recast/Detour pipeline end-to-end. I had used navmesh libraries before as a black box -- pass in a mesh, get back a path. Writing the bridge forced me to understand every stage: why the walkable slope filter runs before rasterization, what the compact heightfield buys you over the regular one, how watershed region partitioning differs from monotone, and why the detail mesh exists at all (it is not for visual fidelity -- it improves path string-pulling by providing the actual surface geometry inside each convex polygon).

I got deep into ctypes interop patterns: managing opaque pointer lifetimes across the language boundary, constructing C structs from Python dataclasses with exact field alignment, and the dance of nullable pointers (like the optional `snap_vextent` override that passes `NULL` through the FFI boundary to signal "use the crowd default").

Most of all, I internalised the real-time constraints of robotics software. The voxelizer needs to finish before the next LiDAR scan arrives. The obstacle manager needs to drain its tile rebuild queue within a single control cycle. The crowd update must run at 30 Hz without jitter. Every design decision -- why the voxelizer is C++ and not Python, why the map neighbourhood search is parameterised at runtime, why the tile cache approach exists alongside the crowd-agent pool -- traces back to those timing requirements.

The demo video shows the system in action: a simulated robot navigating a Blender scene while a person-shaped point cloud cluster moves across its path. The navmesh tiles around the cluster are being rebaked in real time, and the robot steers around the obstacle with clean, oscillation-free trajectories. That moment, when the first dynamic cylinder appeared in the navmesh and the path rerouted around it, made every hour debugging ctypes segfaults worth it.
