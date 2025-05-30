# Neuroglancer Mini

This is a trimmed-down version of the original Neuroglancer source code, designed to make its core logic more accessible and easier to understand. This is not a new implementation, but rather a carefully curated subset of the original codebase (~115,510 lines) that has been reduced to about 22,677 lines by retaining only the minimal core functionality needed for the program to run, reducing npm dependencies, and simplifying the build process. This lightweight version serves as a learning demo, allowing developers to grasp the core concepts and architecture of Neuroglancer without being overwhelmed by the complexity of the original implementation.

<img width="1193" alt="img2" src="https://github.com/user-attachments/assets/c69a9014-3250-4d05-8350-abb96975b64c" />

Note: This is not an officially maintained version of Neuroglancer. Neuroglancer and Neuroglancer Mini are two independently developed projects, but this project is based on a reduced version of the original Neuroglancer source code.

# Project Structure

This project has two main branches: the [forward branch](https://github.com/tomhsiao1260/neuroglancer-mini/tree/forward) and the [backward branch](https://github.com/tomhsiao1260/neuroglancer-mini/tree/backward). The backward branch is a simplified version of Neuroglancer, while the forward branch builds additional features on top of this simplified version.

If you want to understand the core workings of the Neuroglancer code, you can jump to [here](#neuroglancer-mini-backward-branch). Although there isn't much information added yet, we will continue to update the content as we remove more code and gain a better understanding of the project. If you want to use the new features we've built on top of Neuroglancer Mini, you can jump to [here](#neuroglancer-mini-forward-branch).

# Neuroglancer Mini (forward branch)

You can use our additional features in the forward branch. Below we will introduce the related features and how to start the application.

<img width="1193" alt="screen-shot" src="https://github.com/user-attachments/assets/6bcf96ff-48be-4b89-a791-43e8c669027e" />

## Features

- [Coordinate Information](#coordinate-information)
- [Local First Design](#local-first-design)

### Coordinate Information

You can obtain current position information from the following sources:

- Bottom-right panel: Displays the center coordinates of the current view (in white) and the 3D coordinates of the mouse cursor (in yellow)
- URL query parameters: Includes x, y, z coordinates and zoom value

### Local First Design

We believe that the coordination between local and remote data is important, which is why we developed this feature early in the project. In this feature, data is automatically downloaded from the remote server when browsing specific areas and automatically loaded from the local storage when reopening.

Only the specific regions that have been viewed will be downloaded, and network transmission is only required the first time you view an area. This reduces dependency on network transmission. You can even write your own scripts to perform subsequent analysis on these local data.

<img width="1193" alt="zarr-file" src="https://github.com/user-attachments/assets/61ce75de-bed4-49a3-bc44-c7b144888bcd" />

## Installation & Startup

1. Make sure you are on the forward branch
```bash
git checkout forward
```

2. Install packages in the scripts folder and run the app.
```bash
cd scripts
npm install
node start.js
```

3. After completion, the application window will open. You can re-select the x, y, z coordinates you want to browse, for example:
```
http://localhost:4173/?z=6690&y=3073&x=2572&zoom=5.0
```

4. Enter the information:

- Username & Password: Please first fill out the [Vesuvius Challenge](https://scrollprize.org/data) registration form to obtain the scroll data credentials.

- Scroll URL: The remote scroll's zarr folder path, for example:
```
https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/
```

- Zarr Data Path: The local path to store zarr data. For first-time use, you can create an empty folder with the `.zarr` extension and select that path, for example:
```
E:/PATH_TO_YOUR_ZARR_FOLDER/scroll.zarr/
```

5. Click the Confirm button

The first time, data will be loaded from the remote server, which may take some time. You can find these data files in the local zarr folder you selected earlier. On subsequent visits to the same coordinates, the data will be loaded directly from your local storage.

# Neuroglancer Mini (backward branch)

The reduced architecture in the backward branch. We will continue to update the documentation as we gain more understanding of the project.

## Motivation

When I first tried to understand Neuroglancer's source code, I found it challenging due to its complexity and numerous abstract layers. I was particularly interested in understanding:
- How data is loaded in batches
- The rendering mechanisms
- Core visualization principles

To address these challenges, I created Neuroglancer Mini by:
- Keeping only essential code for basic functionality
- Removing complex interface and data transfer logic
- Simplifying the build process
- Focusing on core visualization features

This project serves as a learning resource for developers who want to understand Neuroglancer's fundamental codebase.

## Installation & Startup

This lightweight demo uses the File System Access API to load data directly from your local filesystem. This API is currently not supported in some browsers. Please use Chrome or Edge to run this project.

<img width="1193" alt="img1" src="https://github.com/user-attachments/assets/42784acc-39cc-4585-948b-0b2d4a971ee1" />

### Option 1: Local Development
1. Make sure you are on the backward branch
```bash
git checkout backward
```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000` in Chrome or Edge

### Option 2: Online Demo
Visit the deployed version at [neuroglancer-mini.vercel.app](https://neuroglancer-mini.vercel.app)

### Supported File Formats
The application supports Zarr format (both v2 and v3) and OME-NGFF (OME Zarr) multiscale datasets. Supported data types include uint8, int8, uint16, int16, uint32, int32, uint64, and float32. For Zarr v2, supported compressors are blosc, gzip, null (raw), zlib, and zstd.

## Project Structure

The project is organized into several key directories, each handling specific aspects of the system:

### Application Core
- `src/main.ts`: The entry point of the application, handling initialization and user interface setup
- `src/state/`: Manages application state:
  - Coordinate transformation
  - Navigation state
  - Trackable values
  - State synchronization

### Data Management
- `src/datasource/`: Manages data source providers and protocols, including:
  - Zarr format support
  - URL handling and normalization
  - Data source registration and management
  - Layer naming and grouping
- `src/chunk_manager/`: Implements efficient data chunking and loading:
  - Frontend-backend communication for chunk management
  - Generic file source handling
  - Chunk request prioritization
  - Memory management for loaded chunks

### Visualization System
- `src/layer/`: Defines the layer system architecture:
  - Layer data source management
  - Display context handling
  - Layer state management
  - Layer composition and blending
- `src/sliceview/`: Manages the three orthogonal slice views:
  - Volume rendering
  - Chunk format handling
  - Panel management
  - Bounding box visualization
  - Frontend-backend synchronization
- `src/visibility_priority/`: Implements a priority system for managing visibility states:
  - Tracks visibility status of different components
  - Handles priority-based prefetching
  - Manages shared visibility states between frontend and backend
  - Supports infinite visibility states and priority levels

### Rendering Engine
- `src/webgl/`: Provides WebGL rendering infrastructure:
  - Shader management and compilation
  - Texture handling and access
  - Buffer management
  - Dynamic shader generation
  - Colormap support
  - Offscreen rendering
  - Bounding box visualization
- `src/render/`: Implements the core rendering pipeline:
  - Render layer management
  - Coordinate transformation
  - Projection parameter handling
  - Panel rendering
  - Real-time mouse position tracking
  - Smooth navigation controls

### Background Processing
- `src/worker/`: Handles background processing:
  - Web Worker implementation
  - RPC communication
  - Shared state management
  - Chunk processing

### Utilities
- `src/util/`: Provides utility functions and classes:
  - Data type handling
  - Matrix operations
  - Color manipulation
  - Event handling
  - Mouse and keyboard bindings
  - JSON processing
  - Memory management
  - Error handling
  - File system access

### Build Configuration
- `vite.config.ts`: Vite build configuration
- `tsconfig.json`: TypeScript configuration
- `package.json`: Project dependencies and scripts
