import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../error.js";
import { uploadFile } from "../upload.js";

type ProgressLike = { lengthComputable: boolean; loaded: number; total: number };
type Listener = (event: unknown) => void;

interface MockXhrUpload {
  addEventListener: ReturnType<typeof vi.fn>;
  _listeners: Record<string, Listener[]>;
}

interface MockXhr {
  open: ReturnType<typeof vi.fn>;
  setRequestHeader: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  status: number;
  responseText: string;
  upload: MockXhrUpload;
  addEventListener: ReturnType<typeof vi.fn>;
  _listeners: Record<string, Listener[]>;
  _fire: (event: string, detail?: unknown) => void;
}

function createMockXhr(): MockXhr {
  const uploadListeners: Record<string, Listener[]> = {};
  const xhrListeners: Record<string, Listener[]> = {};

  const upload: MockXhrUpload = {
    _listeners: uploadListeners,
    addEventListener: vi.fn((event: string, cb: Listener) => {
      if (!uploadListeners[event]) uploadListeners[event] = [];
      uploadListeners[event].push(cb);
    }),
  };

  const xhr: MockXhr = {
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    send: vi.fn(),
    abort: vi.fn(),
    status: 200,
    responseText: "",
    upload,
    _listeners: xhrListeners,
    addEventListener: vi.fn((event: string, cb: Listener) => {
      if (!xhrListeners[event]) xhrListeners[event] = [];
      xhrListeners[event].push(cb);
    }),
    _fire(event: string, detail?: unknown) {
      const cbs = xhrListeners[event] ?? [];
      for (const cb of cbs) {
        cb(detail ?? {});
      }
    },
  };

  return xhr;
}

describe("uploadFile", () => {
  let mockXhr: MockXhr;

  beforeEach(() => {
    mockXhr = createMockXhr();
    vi.stubGlobal(
      "XMLHttpRequest",
      vi.fn(() => mockXhr),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens POST to given URL and sends FormData", async () => {
    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ id: "upload-1" });

    const file = new File(["content"], "test.txt", { type: "text/plain" });
    const promise = uploadFile("https://api.example.com/upload", file);

    // Trigger load
    mockXhr._fire("load");

    const result = await promise;
    expect(result).toEqual({ id: "upload-1" });
    expect(mockXhr.open).toHaveBeenCalledWith("POST", "https://api.example.com/upload", true);
    expect(mockXhr.send).toHaveBeenCalledOnce();
  });

  it("calls onProgress with correct percent", async () => {
    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ id: "up-2" });

    const onProgress = vi.fn();
    const file = new File(["hello"], "hello.txt");
    const promise = uploadFile("https://api.example.com/upload", file, { onProgress });

    // Simulate a progress event
    const progressListeners = mockXhr.upload._listeners.progress ?? [];
    const evt: ProgressLike = { lengthComputable: true, loaded: 50, total: 100 };
    for (const listener of progressListeners) {
      listener(evt);
    }

    mockXhr._fire("load");

    await promise;
    expect(onProgress).toHaveBeenCalledWith(50);
  });

  it("calls onProgress with 100 when load is complete", async () => {
    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ id: "up-3" });

    const onProgress = vi.fn();
    const file = new File(["data"], "data.bin");
    const promise = uploadFile("https://api.example.com/upload", file, { onProgress });

    const progressListeners = mockXhr.upload._listeners.progress ?? [];
    const evt: ProgressLike = { lengthComputable: true, loaded: 1024, total: 1024 };
    for (const listener of progressListeners) {
      listener(evt);
    }

    mockXhr._fire("load");
    await promise;
    expect(onProgress).toHaveBeenCalledWith(100);
  });

  it("does not call onProgress when lengthComputable is false", async () => {
    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ id: "up-4" });

    const onProgress = vi.fn();
    const file = new File(["data"], "data.bin");
    const promise = uploadFile("https://api.example.com/upload", file, { onProgress });

    const progressListeners = mockXhr.upload._listeners.progress ?? [];
    const evt: ProgressLike = { lengthComputable: false, loaded: 50, total: 0 };
    for (const listener of progressListeners) {
      listener(evt);
    }

    mockXhr._fire("load");
    await promise;
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("does not call onProgress when lengthComputable is true but total is 0", async () => {
    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ id: "up-5" });

    const onProgress = vi.fn();
    const file = new File(["data"], "data.bin");
    const promise = uploadFile("https://api.example.com/upload", file, { onProgress });

    const progressListeners = mockXhr.upload._listeners.progress ?? [];
    const evt: ProgressLike = { lengthComputable: true, loaded: 0, total: 0 };
    for (const listener of progressListeners) {
      listener(evt);
    }

    mockXhr._fire("load");
    await promise;
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("throws ApiError on non-2xx status (JSON body)", async () => {
    mockXhr.status = 400;
    mockXhr.responseText = JSON.stringify({ message: "Bad request", code: "BAD_INPUT" });

    const file = new File(["x"], "x.txt");
    const promise = uploadFile("https://api.example.com/upload", file);
    mockXhr._fire("load");

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    try {
      await promise;
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe("Bad request");
      expect((err as ApiError).errorCode).toBe("BAD_INPUT");
    }
  });

  it("throws ApiError on non-2xx status (text body)", async () => {
    mockXhr.status = 503;
    mockXhr.responseText = "Service unavailable";

    const file = new File(["x"], "x.txt");
    const promise = uploadFile("https://api.example.com/upload", file);
    mockXhr._fire("load");

    await expect(promise).rejects.toBeInstanceOf(ApiError);
  });

  it("throws ApiError on non-2xx with errorCode from body.errorCode", async () => {
    mockXhr.status = 422;
    mockXhr.responseText = JSON.stringify({ error: "Invalid", errorCode: "INVALID_FILE" });

    const file = new File(["x"], "x.txt");
    const promise = uploadFile("https://api.example.com/upload", file);
    mockXhr._fire("load");

    try {
      await promise;
    } catch (err) {
      expect((err as ApiError).errorCode).toBe("INVALID_FILE");
    }
  });

  it("aborts XHR when AbortSignal fires", async () => {
    const controller = new AbortController();
    const file = new File(["large"], "large.bin");
    const promise = uploadFile("https://api.example.com/upload", file, {
      signal: controller.signal,
    });

    controller.abort();
    mockXhr._fire("abort");

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    expect(mockXhr.abort).toHaveBeenCalledOnce();
  });

  it("throws ApiError on XHR error event", async () => {
    const file = new File(["x"], "x.txt");
    const promise = uploadFile("https://api.example.com/upload", file);

    mockXhr._fire("error");

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    try {
      await promise;
    } catch (err) {
      expect((err as ApiError).status).toBe(0);
      expect((err as ApiError).message).toBe("Network error during upload");
    }
  });

  it("sets custom headers on XHR", async () => {
    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ id: "h-1" });

    const file = new File(["x"], "x.txt");
    const promise = uploadFile("https://api.example.com/upload", file, {
      headers: { Authorization: "Bearer tok", "x-tenant": "t1" },
    });

    mockXhr._fire("load");
    await promise;

    expect(mockXhr.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer tok");
    expect(mockXhr.setRequestHeader).toHaveBeenCalledWith("x-tenant", "t1");
  });

  it("throws ApiError when response JSON cannot be parsed on success", async () => {
    mockXhr.status = 200;
    mockXhr.responseText = "not json";

    const file = new File(["x"], "x.txt");
    const promise = uploadFile("https://api.example.com/upload", file);
    mockXhr._fire("load");

    await expect(promise).rejects.toBeInstanceOf(ApiError);
  });
});
