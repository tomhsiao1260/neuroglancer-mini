/**
 * Serves a local zarr store to the viewer.  Files missing from it are first downloaded from a remote
 * store, so only the parts of a scroll that are looked at are downloaded, and only once.
 *
 * Settings are kept in `db/json/settings.json` (see `utils/settings.ts`) and can be changed from
 * the page through `/api/settings`.
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import settingsRouter from "./routes/settings";
import dataRouter from "./routes/data";
import { createSettingsFileIfMissing } from "./utils/settings";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json());

app.use("/api/settings", settingsRouter);
app.use("/api/data", dataRouter);

app.listen(PORT, async () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  await createSettingsFileIfMissing();
});
