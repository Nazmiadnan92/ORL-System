import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const fixtureRoot = resolve(root, 'tests/ic-write');
const output = resolve(root, 'supabase/046_ic_c1_guarded_cutover.sql');
const expected = new Map(Object.entries({
  'candidate.sql': '409F01A4BFABD31FF59EC159AF6D17B85A93008846CEE0CAEF21D28A229A2B0E',
  'compatibility.sql': '1E22C386BADC2FFEFC64A3ABDC426AAE5F0A49F563C61E83FAF4ABD0BC784FD1',
  'reads.sql': '89B81F1F2680C0443B204BEBB3F8C3F42BF06E4D6E730CF551FCAF2B80E372F0',
  'gateway.sql': 'A2617AF143247A655D4BD4693C01C001713AD64D9C84BF13298EA57273205849',
  'controls.sql': 'FD85ED4979087820A21882525D41211AD1F4167DB532D25887B1A1C7CC9D1E41',
  'repair-exposure.sql': 'D034E0943A16CC6176C8155B254F2304E24CE73F963FA9B0B69A8912C262F198',
  'ux.sql': '913A84E4446778648AA692478F1266746FE4C79D0FE8832EEC1BA99C64957417',
  'legacy-gates.sql': '9DDBDCFFD1F7B3255D01438EBC49AE31B1958E294E9484283112B40A09DA9AFF',
  'full-dump-recovery.sql': '477C5F574D67369D7E256ECD41585A2F61A970FDF3E01690F5A8F2F91DAB52B6',
}));

const sha = value => createHash('sha256').update(value).digest('hex').toUpperCase();
const normalize = value => value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
const load = name => {
  const value = normalize(readFileSync(resolve(fixtureRoot, name), 'utf8'));
  if (sha(value) !== expected.get(name)) throw new Error(`Reviewed fixture changed: ${name}`);
  return value;
};
const stripTransaction = value => value.replace(/^(?:--[^\n]*\n)+begin;\n/, '').replace(/\ncommit;\s*$/, '\n');
const stripFirstGuard = value => {
  const result = value.replace(/^do[^\n]*\n[\s\S]*?^end[^\n]*;\n+/m, '');
  if (result === value) throw new Error('Expected local guard was not found.');
  return result;
};
const stripRuntimeGuards = (value, count) => {
  const pattern = /\s*if session_user\s*<>\s*'orl_test_owner'\s+or inet_server_addr\(\) is distinct from '127\.0\.0\.1'::inet\s+then\s+raise exception 'C1 local testing only\.'(?: using errcode='42501')?;\s+end if;/gi;
  let seen = 0;
  const result = value.replace(pattern, () => { seen += 1; return ''; });
  if (seen !== count) throw new Error(`Expected ${count} runtime guards, found ${seen}.`);
  return result;
};

let candidate = stripTransaction(load('candidate.sql'));
candidate = candidate.replace(
  "declare source text; expected text;\nbegin\n  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet\n     or to_regclass('c1_test_baseline') is null then\n    raise exception 'LOCAL synthetic test runner required. Not a production migration.';\n  end if;\n  select body into expected from c1_test_baseline;",
  "declare source text; expected_hash constant text:='510bb2377c27c11629428fe90244aba7';\nbegin"
);
candidate = candidate.replace('if source is distinct from expected then', 'if md5(source) is distinct from expected_hash then');
candidate = candidate.replace('if source = expected or', 'if md5(source)=expected_hash or');
candidate = stripRuntimeGuards(candidate, 2);
if (candidate.includes('c1_test_baseline') || candidate.includes('orl_test_owner')) throw new Error('Candidate local gate remains.');

const parts = [candidate];
for (const [name, runtimeGuards] of [
  ['compatibility.sql', 10], ['reads.sql', 0], ['gateway.sql', 0], ['controls.sql', 0],
  ['repair-exposure.sql', 0], ['ux.sql', 0], ['legacy-gates.sql', 0], ['full-dump-recovery.sql', 1],
]) {
  let value = stripTransaction(load(name));
  value = stripFirstGuard(value);
  value = stripRuntimeGuards(value, runtimeGuards);
  if (value.includes('orl_test_owner') || value.includes("'127.0.0.1'::inet")) throw new Error(`Local gate remains in ${name}.`);
  parts.push(`\n-- Reviewed release body derived from ${name}.\n${value.trim()}\n`);
}

const header = `-- C1 guarded cutover: protected write gateway, masked reads, backup V2 and recovery fences.
-- Generated only by security/release/build-046.mjs from hash-pinned local fixtures.
-- This migration does not backfill identities, remove plaintext IC, deploy Edge code, set secrets or enable the website flag.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

do $release_guard$
declare create_source text;
begin
  if to_regclass('orl_private.request_identity') is null
     or to_regprocedure('public.orl_ic_foundation_probe(uuid)') is null then
    raise exception 'STOP: migration 045 foundation is required. No changes applied.';
  end if;
  if to_regclass('orl_private.c1_restore_generation') is not null
     or to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is not null then
    raise exception 'STOP: migration 046 already exists or conflicts. No changes applied.';
  end if;
  if not exists(select 1 from pg_roles where rolname='service_role')
     or to_regprocedure('public.orl_generate_public_holidays(uuid,integer)') is null then
    raise exception 'STOP: production prerequisites through migration 045 are incomplete. No changes applied.';
  end if;
  select replace(prosrc,chr(13),'') into create_source from pg_proc
    where oid=to_regprocedure('public.orl_create_request(uuid,jsonb)');
  if md5(create_source) is distinct from '510bb2377c27c11629428fe90244aba7' then
    raise exception 'STOP: reviewed migration 040 creation baseline differs. No changes applied.';
  end if;
end $release_guard$;

`;

const rateStore = `
-- Shared PostgreSQL rate store. This is intentionally not isolate-local.
create table orl_private.c1_rate_windows(
  session_hash bytea not null,
  window_started_at timestamptz not null,
  request_count smallint not null check(request_count between 1 and 30),
  primary key(session_hash,window_started_at)
);
alter table orl_private.c1_rate_windows enable row level security;
alter table orl_private.c1_rate_windows force row level security;
revoke all on orl_private.c1_rate_windows from public,anon,authenticated,service_role;

create function public.orl_ic_c1_rate_limit(p_session_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare token_hash bytea; bucket timestamptz; accepted boolean;
begin
  perform public.orl_require_session(p_session_token);
  token_hash:=extensions.digest(p_session_token::text,'sha256');
  bucket:=date_trunc('minute',clock_timestamp());
  delete from orl_private.c1_rate_windows where session_hash=token_hash and window_started_at<bucket;
  insert into orl_private.c1_rate_windows(session_hash,window_started_at,request_count)
  values(token_hash,bucket,1)
  on conflict(session_hash,window_started_at) do update
    set request_count=orl_private.c1_rate_windows.request_count+1
    where orl_private.c1_rate_windows.request_count<30
  returning true into accepted;
  return coalesce(accepted,false);
end $$;
revoke all on function public.orl_ic_c1_rate_limit(uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_rate_limit(uuid) to service_role;

comment on table orl_private.c1_rate_windows is 'Shared C1 Edge rate decisions; SHA-256 session references only, fixed 30 requests per minute.';
comment on table orl_private.c1_database_identity is 'Full-dump recovery fence. A restored target remains closed until the offline owner finalizer rotates generation and invalidates sessions.';
notify pgrst,'reload schema';
commit;
`;

const sql = normalize(header + parts.join('\n') + rateStore);
const localMarker = sql.match(/.{0,80}(?:local testing only|orl_test_owner|c1_test_baseline|127\.0\.0\.1).{0,80}/i);
if (localMarker) throw new Error(`Generated migration contains local-only text: ${localMarker[0]}`);
writeFileSync(output, sql, 'utf8');
console.log(`${output}\nSHA256 ${sha(sql)}\n${sql.split('\n').length} lines`);
