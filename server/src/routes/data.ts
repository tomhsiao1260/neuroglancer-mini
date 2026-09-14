import { Router, Request, Response } from "express";
import fs from "fs";
import { downloadFile } from "../utils/download";
import { getLocalPath, getSettings, SETTING_PATH } from "../utils/settings";

const router = Router();

function isFile(file: string) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Serves a file of the local zarr store, e.g.
// http://localhost:3005/api/data/zarr/0/52/24/18
//
// A file missing from the local store is first downloaded from the remote store, if one is set.
// A file neither store has answers 404; the viewer shows such a chunk as empty.
router.get("/zarr/*key", async (req: Request, res: Response) => {
  const settings = await getSettings();
  if (!settings.zarr_data_path) {
    res.status(500).json({ error: `zarr_data_path is not set in ${SETTING_PATH}` });
    return;
  }
  const key = ([] as string[]).concat(req.params.key).join("/");
  const localPath = getLocalPath(settings, key);
  if (localPath === undefined) {
    res.status(400).json({ error: "Invalid key" });
    return;
  }

  if (!isFile(localPath) && settings.scroll_url_path) {
    try {
      await downloadFile(settings.scroll_url_path, key, localPath);
    } catch (error) {
      console.error(`Failed to download ${key}:`, error);
      res.status(502).json({ error: (error as Error).message });
      return;
    }
  }

  if (!isFile(localPath)) {
    res.status(404).end();
    return;
  }
  res.sendFile(localPath, { dotfiles: "allow" });
});

export default router;
