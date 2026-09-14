import path from "path";
import fsp from "fs/promises";

/**
 * Downloads `key` (e.g. `0/52/24/18`) from the remote store at `remoteUrl` to `localPath`.  Does
 * nothing if the remote store does not have the file.
 */
export async function downloadFile(
  remoteUrl: string,
  key: string,
  localPath: string,
) {
  const url = `${remoteUrl.replace(/\/+$/, "")}/${key}`;
  const response = await fetch(url);
  // S3 answers 403 rather than 404 for a missing file.
  if (response.status === 404 || response.status === 403) return;
  if (!response.ok) {
    throw new Error(
      `Fetching ${url} failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = Buffer.from(await response.arrayBuffer());
  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  // Written under a temporary name first, so that a partly written file is never served.
  const temporaryPath = `${localPath}.download`;
  await fsp.writeFile(temporaryPath, data);
  await fsp.rename(temporaryPath, localPath);
  console.log(`Downloaded ${key}`);
}
