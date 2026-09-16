# Neuroglancer Mini (forward branch)

This branch builds an app on top of Neuroglancer Mini, a trimmed-down version of the Neuroglancer source code. The viewer itself lives in `viewer/`, which is the same folder as in the [backward branch](https://github.com/tomhsiao1260/neuroglancer-mini/tree/backward). For how the viewer works, its API and its source files, see the [main README](https://github.com/tomhsiao1260/neuroglancer-mini#readme).

<img width="1193" alt="screen-shot" src="https://github.com/user-attachments/assets/6bcf96ff-48be-4b89-a791-43e8c669027e" />

## Features

- [A Board of Cards](#a-board-of-cards)
- [A Source per Card](#a-source-per-card)
- [Linked Cards](#linked-cards)
- [Coordinate Information](#coordinate-information)
- [Local First Design](#local-first-design)
- [Missing Chunks](#missing-chunks)

### A Board of Cards

The page is a board, and each card on it is a cross-section of the volume with its own plane,
position and zoom. Double click the board to add a card, drag a card to move it, drag its corner to
resize it, and drag the board itself to pan. The wheel over the board zooms the board: the cards get
larger without showing more data, and they are drawn at the resolution they are shown at.

| | |
| --- | --- |
| double click the background | add a card |
| drag a card | move it |
| drag a card's corner | resize it |
| alt + drag a card | pan its slice |
| wheel over a card | step one voxel through the slices |
| ctrl + wheel over a card | zoom the slice |
| drag the background, or middle drag | pan the board |
| wheel over the background | zoom the board |
| the ⛓ in a card's header | link this card to another, or unlink it |
| the ✕ in a card's header | remove the card |

Saving the board is the next step (see [docs/whiteboard.md](docs/whiteboard.md)).

### A Source per Card

A new card is empty and asks where its data comes from. Both fields are optional, and the pair
decides what happens:

| Zarr folder | Remote store | What the card shows |
| --- | --- | --- |
| — | — | nothing; the card keeps asking |
| ✓ | — | the folder on the server, and nothing is downloaded |
| — | ✓ | the remote store, downloaded into a cache folder of its own under `server/db/cache` |
| ✓ | ✓ | the folder first, and what it does not have is downloaded into it |

A source is identified by that pair, so cards naming the same one show the same volume: its chunks
are downloaded once and kept in one set of textures, however many cards look at them. The form also
lists the sources already in use, to show the same data in another plane without typing the paths
again. **Default source** in the header sets what a new card's form starts with.

### Linked Cards

Linked cards share one position and one zoom, so moving through the slices in one moves them all,
each along its own plane. Click the ⛓ in a card's header and then click another card to link them;
click the ⛓ again to unlink. Linked cards are marked in a colour of their own, and the badge counts
them.

**+ linked x/y/z** in the header adds three linked cards showing the XY, XZ and YZ planes — the three
views this page had before it became a board. Giving one card of a linked set a source gives it to
every card of the set that has none, so a new set only has to be told once where its data is.

Every axis points the same way wherever it is shown — x to the right, y downward, z to the right in
the YZ plane and downward in the XZ plane — so linked cards move with each other rather than against
each other.

Linking two sets merges them, and the larger set's position wins, so the smaller one jumps to it.
Unlinking a card leaves it exactly where it was. Cards showing different sources may be linked: they
then show the same voxel coordinates, which lines up only for volumes on the same grid (two scans of
one scroll, say).

### Coordinate Information

The panel in the bottom-right corner shows the voxel under the mouse cursor (in yellow) and the
center of the card it is over (in white).

### Local First Design

We believe that the coordination between local and remote data is important, which is why we developed this feature early in the project. In this feature, data is automatically downloaded from the remote server when browsing specific areas and automatically loaded from the local storage when reopening.

Only the specific regions that have been viewed will be downloaded, and network transmission is only required the first time you view an area. This reduces dependency on network transmission. You can even write your own scripts to perform subsequent analysis on these local data.

<img width="1193" alt="zarr-file" src="https://github.com/user-attachments/assets/61ce75de-bed4-49a3-bc44-c7b144888bcd" />

### Missing Chunks

Chunks that neither the local folder nor the remote store has (sparse scrolls have many) are shown as empty and listed in the top-right corner.

## Installation & Startup

1. Make sure you are on the forward branch

```bash
git checkout forward
```

2. Install packages in the scripts folder and run the app. This installs and builds the client, starts the server, and opens the page once both are running.

```bash
cd scripts
npm install
node start.js
```

3. Double click the board to add a card, and enter where its data comes from (**Default source** in
   the header sets what every new card starts with):

- Zarr folder on the server: the local path the data is stored in. For first-time use, create an
  empty folder with the `.zarr` extension and give that path, for example:

```
E:/PATH_TO_YOUR_ZARR_FOLDER/scroll.zarr/
```

- Remote store (optional): the remote scroll's zarr folder, for example the one below. The Vesuvius
  Challenge data is public, so no username or password is needed. Leave it empty to only read local
  files.

```
https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/
```

4. Click **Show**. The sources are saved in `server/db/json/sources.json`, so the next card can pick
   this one from a list.

The first time, data is loaded from the remote server, which may take some time. You can find those
files in the local zarr folder you gave. On later visits to the same coordinates the data is read
straight from your disk.

## Project Structure

- `viewer/`: the viewer library. Keep it identical to the backward branch; its files are described in the [main README](https://github.com/tomhsiao1260/neuroglancer-mini#project-structure).
- `client/`: the app page (Vite, Tailwind).
  - `index.html`: the header, the source form and the board.
  - `src/main.ts`: creates the viewer, loads the volume and puts the first three cards on the board.
  - `src/board/board.ts`: the cards, their layout in board coordinates, and the board's pan and zoom.
  - `src/board/card.ts`: one card: its frame, its header, and the view inside it.
  - `src/board/gestures.ts`: all mouse input on the board, listed in [A Board of Cards](#a-board-of-cards).
  - `src/board/transform.ts`: the board's pan and zoom as a CSS transform, which the viewer measures.
  - `src/board/links.ts`: the groups of linked cards, each holding the position and zoom its cards share.
  - `src/board/sources.ts`: the sources on the server, and one volume per source, shared by the cards that name it.
  - `src/board/source_panel.ts`: the form a card shows until it has a source.
  - `src/app/position_display.ts`: the coordinate panel in the bottom-right corner.
  - `src/app/missing_chunks.ts`: the `onMissingChunk` handler that lists missing chunks.
  - `src/app/source_form.ts`: the **Default source** form in the header, which writes the server's settings.
  - `src/config.ts`: the server address.
  - `vite.config.ts`, `tsconfig.json`, `package.json`: build configuration (output in `build/client/page`) and the `viewer` import, set up as in the backward branch's `example/`.
- `server/`: local-first zarr stores (Node, Express), on port 3005 of this machine only.
  - `src/routes/data.ts`: `GET /api/data/<sourceId>/<key>` serves a file of that source's store. A file the source's folder does not have is first downloaded from its remote store, if it has one; a file neither has answers 404. `GET /api/data/zarr/<key>` still serves the pair in the settings.
  - `src/routes/sources.ts`: `GET /api/sources` lists the sources and `POST /api/sources` adds one, or returns the existing source for the same pair of paths.
  - `src/routes/settings.ts`: `GET /api/settings` reads the values a new card's form starts with and `POST /api/settings` changes them.
  - `src/utils/sources.ts`: the sources in `db/json/sources.json`, their ids, where each one's files are kept, and the check that keeps a key inside its folder.
  - `src/utils/download.ts`: downloads one file, at most eight at a time, sharing one download between the cards that ask for the same file and writing it under a name of its own first so that a partly written file is never served.
  - `src/utils/settings.ts`: the defaults in `db/json/settings.json`: `zarr_data_path` and `scroll_url_path`.
- `docs/whiteboard.md`: the notes the board is being built from, and what is still missing from it:
  per-card data sources, linked cards, and the board saved on the server.
- `scripts/start.js`: installs and builds the client, starts the client preview (port 4173) and the server, and opens the page once both are running.
