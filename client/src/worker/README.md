# Worker Directory

This directory contains all worker-related code for the Neuroglancer application.

## Files

- `worker_rpc.ts`: Core RPC (Remote Procedure Call) implementation for communication between main thread and Web Workers
- `shared_watchable_value.ts`: Implementation for sharing watchable values between threads
- `chunk_worker.bundle.js`: Entry point for the Web Worker

## Architecture

The worker system is designed to handle computationally intensive tasks in a separate thread to prevent blocking the main UI thread. This includes:

- Chunk management
- Data processing
- Rendering calculations

## Communication

Communication between the main thread and workers is handled through the RPC system implemented in `worker_rpc.ts`. This allows for:

- Method calls between threads
- Shared object management
- Event handling
- Value synchronization 