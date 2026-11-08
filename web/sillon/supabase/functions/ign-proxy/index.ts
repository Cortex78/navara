import { handleField, handleProxy } from "../../proxy";

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

/** POST {keys: string[]} → {key: ProxyItem}; POST {field: coordinates} → field stats. */
Deno.serve(async (req) => {
  const headers = { "Content-Type": "application/json" };
  try {
    const body = (await req.json()) as { keys?: unknown; field?: unknown };
    const result =
      body.field !== undefined
        ? await handleField(body.field)
        : await handleProxy(body.keys);
    return new Response(JSON.stringify(result), { headers });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 400, headers },
    );
  }
});
