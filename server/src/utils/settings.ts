import path from "path";
import fsp from "fs/promises";

export interface Settings {
  // The local zarr store: the `.zarr` folder the viewer reads from and downloads into.
  zarr_data_path: string;
  // URL of the remote zarr store that missing files are downloaded from; empty to download nothing,
  // e.g. https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr
  scroll_url_path: string;
}

export const SETTING_PATH = path.join(
  process.cwd(),
  "db",
  "json",
  "settings.json",
);

const DEFAULT_SETTINGS: Settings = {
  zarr_data_path: "",
  scroll_url_path: "",
};

export async function getSettings(): Promise<Settings> {
  try {
    const data = await fsp.readFile(SETTING_PATH, "utf-8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Writes the default settings if there is no settings file yet, so that there is a file to edit.
export async function createSettingsFileIfMissing() {
  try {
    await fsp.access(SETTING_PATH);
  } catch {
    await fsp.mkdir(path.dirname(SETTING_PATH), { recursive: true });
    await fsp.writeFile(
      SETTING_PATH,
      JSON.stringify(DEFAULT_SETTINGS, null, 2),
      "utf-8",
    );
  }
  return getSettings();
}

/**
 * Returns the path of `key` (e.g. `0/52/24/18`) in the local store, or `undefined` if the key
 * points outside of it.
 */
export function getLocalPath(settings: Settings, key: string) {
  const root = path.resolve(settings.zarr_data_path);
  const file = path.resolve(root, key);
  const relative = path.relative(root, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return file;
}
