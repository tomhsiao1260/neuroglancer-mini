/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export class HttpError extends Error {
  url: string;
  status: number;
  statusText: string;
  response?: Response;

  constructor(
    url: string,
    status: number,
    statusText: string,
    response?: Response,
  ) {
    let message = `Fetching ${JSON.stringify(
      url,
    )} resulted in HTTP error ${status}`;
    if (statusText) {
      message += `: ${statusText}`;
    }
    message += ".";
    super(message);
    this.name = "HttpError";
    this.message = message;
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    if (response) {
      this.response = response;
    }
  }

  static fromResponse(response: Response) {
    return new HttpError(
      response.url,
      response.status,
      response.statusText,
      response,
    );
  }

  static fromRequestError(input: RequestInfo, error: unknown) {
    if (error instanceof TypeError) {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else {
        url = input.url;
      }
      return new HttpError(url, 0, "Network or CORS error");
    }
    return error;
  }
}

const maxAttempts = 32;
const minDelayMilliseconds = 500;
const maxDelayMilliseconds = 10000;

export function pickDelay(attemptNumber: number): number {
  // If `attemptNumber == 0`, delay is a random number of milliseconds between
  // `[minDelayMilliseconds, minDelayMilliseconds*2]`.  The lower and upper bounds of the interval
  // double with each successive attempt, up to the limit of
  // `[maxDelayMilliseconds/2,maxDelayMilliseconds]`.
  return (
    Math.min(
      2 ** attemptNumber * minDelayMilliseconds,
      maxDelayMilliseconds / 2,
    ) *
    (1 + Math.random())
  );
}

/**
 * Issues a `fetch` request.
 *
 * If the request fails due to an HTTP status outside `[200, 300)`, throws an `HttpError`.  If the
 * request fails due to a network or CORS restriction, throws an `HttpError` with a `status` of `0`.
 *
 * If the request fails due to a transient error (429, 503, 504), retry.
 */
async function getFile(input: string, fileTree: any) {
  let res = fileTree;
  // console.log("File Tree: ", fileTree, input);

  const path = new URL(input).pathname;
  const parts = path
    .split("/")
    .filter((part) => part.length > 0)
    .slice(1);

  for (const part of parts) {
    if (res === undefined) return undefined;
    res = res[part];
  }

  return res;
}

async function fetchOk(input: RequestInfo): Promise<Response> {
  let response: Response | undefined;
  try {
    response = await getFile(input, self.fileTree);
  } catch (error) {
    throw HttpError.fromRequestError(input, error);
  }
  if (response === undefined) {
    const url = typeof input === "string" ? input : input.url;
    throw new HttpError(url, 404, "File not found");
  }
  return response;
}

export function responseArrayBuffer(response: Response): Promise<ArrayBuffer> {
  return response.arrayBuffer();
}

export async function responseJson(response: Response): Promise<any> {
  const res = await response.text();
  return JSON.parse(res);
}

export type ResponseTransform<T> = (response: Response) => Promise<T>;

/**
 * Issues a `fetch` request in the same way as `fetchOk`, and returns the result of the promise
 * returned by `transformResponse`.
 *
 * Additionally, the request may be cancelled through `cancellationToken`.
 *
 * The `transformResponse` function should not do anything with the `Response` object after its
 * result becomes ready; otherwise, cancellation may not work as expected.
 */
export async function cancellableFetchOk<T>(
  input: RequestInfo,
  transformResponse: ResponseTransform<T>,
): Promise<T> {
  const response = await fetchOk(input);
  return await transformResponse(response);
}

export function isNotFoundError(e: any) {
  if (!(e instanceof HttpError)) return false;
  // Treat CORS errors (0) or 403 as not found.  S3 returns 403 if the file does not exist because
  // permissions are per-file.
  return e.status === 0 || e.status === 403 || e.status === 404;
}
