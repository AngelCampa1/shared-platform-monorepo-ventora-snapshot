type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

type FetchResponse = { ok: boolean; status: number };

type FetchFn = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export async function submitToIndexNow(
  urls: string[],
  opts: {
    key: string;
    host: string;
    fetch?: FetchFn;
  },
): Promise<{ ok: boolean; status: number }> {
  const fetchFn = opts.fetch ?? (globalThis as { fetch?: FetchFn }).fetch;

  if (fetchFn === undefined) {
    return { ok: false, status: 0 };
  }

  try {
    const body = {
      host: opts.host,
      key: opts.key,
      keyLocation: `https://${opts.host}/${opts.key}.txt`,
      urlList: urls,
    };

    const response = await fetchFn("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
