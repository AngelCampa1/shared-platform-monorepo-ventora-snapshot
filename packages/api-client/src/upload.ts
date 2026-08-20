import { ApiError } from "./error.js";

export type UploadFileOpts = {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export type UploadResult = { id: string };

export function uploadFile(url: string, file: File, opts?: UploadFileOpts): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open("POST", url, true);

    if (opts?.headers) {
      for (const [key, value] of Object.entries(opts.headers)) {
        xhr.setRequestHeader(key, value);
      }
    }

    if (opts?.onProgress) {
      const onProgress = opts.onProgress;
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress(percent);
        }
      });
    }

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText) as UploadResult;
          resolve(result);
        } catch {
          reject(
            new ApiError({
              status: xhr.status,
              message: "Failed to parse upload response",
              body: xhr.responseText,
            }),
          );
        }
      } else {
        let body: unknown;
        let message: string | undefined;
        let errorCode: string | undefined;

        try {
          body = JSON.parse(xhr.responseText) as unknown;
          if (body !== null && typeof body === "object") {
            const b = body as Record<string, unknown>;
            if (typeof b.message === "string") {
              message = b.message;
            } else if (typeof b.error === "string") {
              message = b.error;
            }
            if (typeof b.code === "string") {
              errorCode = b.code;
            } else if (typeof b.errorCode === "string") {
              errorCode = b.errorCode;
            }
          }
        } catch {
          body = xhr.responseText;
          if (xhr.responseText.length > 0) {
            message = xhr.responseText;
          }
        }

        reject(
          new ApiError({
            status: xhr.status,
            message: message ?? `HTTP ${xhr.status}`,
            body,
            ...(errorCode !== undefined ? { errorCode } : {}),
          }),
        );
      }
    });

    xhr.addEventListener("error", () => {
      reject(
        new ApiError({
          status: 0,
          message: "Network error during upload",
        }),
      );
    });

    xhr.addEventListener("abort", () => {
      reject(
        new ApiError({
          status: 0,
          message: "Upload aborted",
        }),
      );
    });

    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => {
        xhr.abort();
      });
    }

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}
