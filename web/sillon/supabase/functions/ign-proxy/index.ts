import {
  handleField,
  handleFieldGrid,
  handleProfile,
  handleProxy,
} from "../../proxy";

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

/**
 * POST {keys: string[]} → {key: ProxyItem}; POST {field: coordinates} →
 * field stats; POST {grid: coordinates} → the field's encoded height grid
 * for the page's cut/fill design; POST {profile: coordinates} → heights
 * along a line.
 */
Deno.serve(async (req) => {
  const headers = { "Content-Type": "application/json" };
  try {
    const body = (await req.json()) as {
      keys?: unknown;
      field?: unknown;
      grid?: unknown;
      profile?: unknown;
    };
    const result =
      body.field !== undefined
        ? await handleField(body.field)
        : body.grid !== undefined
          ? await handleFieldGrid(body.grid)
          : body.profile !== undefined
            ? await handleProfile(body.profile)
            : await handleProxy(body.keys);
    return new Response(JSON.stringify(result), { headers });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 400, headers },
    );
  }
});
