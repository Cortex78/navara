-- Database side of the Sillon artifact's live mode (Supabase project
-- "sillon-tiles"). The artifact calls `sillon.proxy(keys)` and
-- `sillon.field(coordinates)` through the viewer's Supabase connector
-- (execute_sql); misses go to the ign-proxy Edge Function (functions/ign-proxy).
--
-- After applying, set the Edge Function URL and the project's public anon key:
--   insert into sillon.config (name, value) values
--     ('edge_url', 'https://<project-ref>.supabase.co/functions/v1/ign-proxy'),
--     ('anon_key', '<legacy anon JWT>');

create extension if not exists http with schema extensions;
create extension if not exists postgis with schema extensions;

create schema if not exists sillon;
revoke all on schema sillon from public, anon, authenticated;

create table if not exists sillon.config (
  name text primary key,
  value text not null
);

create table if not exists sillon.tile_cache (
  key text primary key,
  ctype text not null,
  body bytea not null,
  fetched_at timestamptz not null default now()
);

-- Not exposed through the Data API; RLS with no policies keeps it that way.
alter table sillon.config enable row level security;
alter table sillon.tile_cache enable row level security;

-- POSTs a JSON body to the ign-proxy Edge Function and returns its JSON answer.
create or replace function sillon.edge(payload jsonb) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  url text := (select value from sillon.config where name = 'edge_url');
  api_key text := (select value from sillon.config where name = 'anon_key');
  resp extensions.http_response;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '90000');
  resp := extensions.http((
    'POST', url,
    array[extensions.http_header('Authorization', 'Bearer ' || api_key)],
    'application/json', payload::text
  )::extensions.http_request);
  if resp.status <> 200 then
    raise exception 'ign-proxy HTTP %: %', resp.status, left(resp.content, 300);
  end if;
  return resp.content::jsonb;
end $$;

-- Answers tile and lookup keys (see keys.ts) from the cache, fetching misses
-- through ign-proxy in one call. Returns {key: {status, ctype, b64}}.
create or replace function sillon.proxy(keys text[]) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  result jsonb;
  missing text[];
  answer jsonb;
  k text;
  item jsonb;
begin
  if coalesce(array_length(keys, 1), 0) = 0 then
    return '{}'::jsonb;
  end if;
  if array_length(keys, 1) > 24 then
    raise exception 'at most 24 keys per call';
  end if;
  if exists (
    select 1 from unnest(keys) u
    where u !~ '^kind=[a-z]+(&[a-z]+=[-A-Za-z0-9.,_%+]*)*$'
  ) then
    raise exception 'malformed key';
  end if;

  select coalesce(jsonb_object_agg(c.key, jsonb_build_object(
           'status', 200, 'ctype', c.ctype,
           'b64', translate(encode(c.body, 'base64'), E'\n', ''))), '{}'::jsonb)
    into result
    from sillon.tile_cache c
   where c.key = any(keys);

  select array_agg(distinct u) into missing
    from unnest(keys) u
   where not result ? u;
  if missing is null then
    return result;
  end if;

  answer := sillon.edge(jsonb_build_object('keys', to_jsonb(missing)));
  for k, item in select * from jsonb_each(answer) loop
    if (item->>'status')::int = 200 and (item->>'cache')::boolean then
      insert into sillon.tile_cache (key, ctype, body)
      values (k, item->>'ctype', decode(item->>'b64', 'base64'))
      on conflict (key) do nothing;
    end if;
    result := result || jsonb_build_object(k, item - 'cache');
  end loop;

  -- Keep the free-tier database small: the newest 5000 entries stay.
  if random() < 0.05 then
    delete from sillon.tile_cache
     where key in (select c.key from sillon.tile_cache c order by c.fetched_at desc offset 5000);
  end if;
  return result;
end $$;

-- Area and relief of a field (GeoJSON Polygon/MultiPolygon coordinates)
-- from the native LiDAR HD grid, measured by ign-proxy.
create or replace function sillon.field(coordinates jsonb) returns jsonb
language sql
set search_path = ''
as $$ select sillon.edge(jsonb_build_object('field', coordinates)) $$;

revoke all on all functions in schema sillon from public, anon, authenticated;
