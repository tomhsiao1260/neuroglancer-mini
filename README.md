# Neuroglancer Mini (forward branch)

An app built on Neuroglancer Mini: a board of cross-section cards over a local-first zarr store. The
viewer library lives in `viewer/`, the same folder as in the
[backward branch](https://github.com/tomhsiao1260/neuroglancer-mini/tree/backward), where it is
explained; this branch keeps a copy of it and adds `client/` and `server/` around it.

<img width="1424" height="805" alt="volumen" src="https://github.com/user-attachments/assets/7c377f97-7134-4b89-bd64-369cdd45a446" />

## What it does

- **A board of cards.** Double click the board to add a card; each card is a cross-section with its
  own plane, position and zoom. Drag a card to move it, its corner to resize it, the background to
  pan, and the wheel over the background to zoom — the cards get larger without showing more data.
  Alt and a drag pans a slice, the wheel steps through slices, Ctrl and the wheel zooms one.
- **A source per card.** A card asks for a zarr folder on the server, a remote store, or both. With
  both, the folder is read first and what it does not have is downloaded into it — so only the parts
  of a scroll that are looked at are fetched, and only once. With a remote store alone, the files go
  to a cache folder of the server's; with a folder alone, nothing is downloaded. Cards naming the
  same pair share one volume, one download and one set of textures.
- **Linked cards.** Click the ⛓ in a card's header and then another card, and the two share a
  position and zoom: moving through the slices in one moves both, each along its own plane. **+
  linked x/y/z** adds three linked cards showing the XY, XZ and YZ planes.
- **The board is kept.** Where the cards are, what they show, which are linked and where the board
  is panned to are stored on the server, in `server/db/json/board.json`, and are there again next
  time. Chunks neither store has (sparse scrolls have many) are drawn empty and listed in the corner.

## Running it

```bash
git checkout forward
cd scripts
npm install
node start.js
```

This installs and builds the client, starts the server and opens the page: the client on port 4173,
the server on 3005 of this machine only. Then double click the board, give the card a folder and, if
the data is not there yet, the remote store to download it from, for example:

```
https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/
```

**Default source** in the header sets what every new card's form starts with.

## Project structure

- `viewer/`: the viewer library, a copy of the backward branch's. Keep it identical; it is described
  in the [main README](https://github.com/tomhsiao1260/neuroglancer-mini#readme).
- `client/`: the page (Vite, Tailwind, plain DOM). `src/board/` is the board — the cards
  (`card.ts`), their layout and pan and zoom (`board.ts`, `transform.ts`), the mouse input
  (`gestures.ts`), the linked sets (`links.ts`), the sources (`sources.ts`, `source_panel.ts`) and
  the saved board (`storage.ts`). `src/app/` holds the coordinate readout, the missing-chunk list and
  the default-source form.
- `server/`: the zarr stores (Node, Express). `GET /api/data/<sourceId>/<key>` serves a file of a
  source, downloading it first if its folder does not have it; `/api/sources` and `/api/board` keep
  the sources and the board in `server/db/json/`.
- `scripts/start.js`: installs, builds, starts both and opens the page.
- `docs/whiteboard.md`: what the viewer needed for the board, and what the board does not do yet.

## License

`viewer/` is derived from [Neuroglancer](https://github.com/google/neuroglancer) and licensed under
the Apache License 2.0 (`viewer/LICENSE`). The code in `client/` and `server/` is this project's own.
