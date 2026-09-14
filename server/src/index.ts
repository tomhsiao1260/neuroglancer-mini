/**
 * Serves a local zarr store to the viewer.  Files missing from it are first downloaded from a remote
 * store, so only the parts of a scroll that are looked at are downloaded, and only once.
 *
 * Settings are read from `db/json/settings.json` (see `utils/settings.ts`).
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import dataRouter from "./routes/data";
import { createSettingsFileIfMissing, SETTING_PATH } from "./utils/settings";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());

app.use("/api/data", dataRouter);

app.listen(PORT, async () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  const settings = await createSettingsFileIfMissing();
  if (!settings.zarr_data_path) {
    console.log(
      `Set zarr_data_path (and optionally scroll_url_path) in ${SETTING_PATH}`,
    );
  }
});
