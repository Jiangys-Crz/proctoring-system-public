// Read-only evidence export from the explicitly selected local NovaJudge DB.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';

let client;
try {
  const [rootArg, contestArg, outputArg] = process.argv.slice(2);
  const contestId = Number(contestArg);
  if (!rootArg || !outputArg || !Number.isSafeInteger(contestId) || contestId < 1) throw new Error('ARGUMENTS');
  const root = path.resolve(rootArg);
  const config = parseEnv(await fs.readFile(path.join(root, '.env'), 'utf8'));
  const database = new URL(config.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || !['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('LOCAL_ONLY');
  const requireNova = createRequire(path.join(root, 'package.json'));
  const pg = requireNova('pg');
  pg.types.setTypeParser(1114, value => new Date(value.replace(' ', 'T') + 'Z'));
  client = new pg.Client({ connectionString: config.DATABASE_URL }); await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const query = async sql => (await client.query(sql, [contestId])).rows;
  const [contest] = await query('select id,title,"startTime","endTime",type,"createdAt" from contests where id=$1');
  if (!contest) throw new Error('CONTEST_MISSING');
  const teams = await query('select id,username,"displayName",category,"createdAt","updatedAt" from users where "contestId"=$1 and role=\'TEAM\' order by "createdAt",id');
  const submissions = await query('select id,"displayId","userId","problemId","submittedAt",verdict from submissions where "contestId"=$1 order by "submittedAt",id');
  const problems = await query('select "problemId","displayId" from contest_problems where "contestId"=$1 order by "displayId"');
  await client.query('COMMIT');
  const rankingSource = await fs.readFile(path.join(root, 'app/(main)/contest/[contestId]/(board)/rank/page.tsx'));
  const proof = { observedAt: new Date().toISOString(), source: 'LOCAL_NOVAJUDGE_READ_ONLY_DATABASE', transaction: 'REPEATABLE_READ_READ_ONLY',
    rankingImplementationSha256: createHash('sha256').update(rankingSource).digest('hex'), contest, teams, submissions, problems };
  const output = path.resolve(outputArg); await fs.mkdir(path.dirname(output), { recursive: true });
  // Preserve prior evidence files by default; explicitly choose a new path.
  await fs.writeFile(output, JSON.stringify(proof, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ contestId, teamCount: teams.length, submissionCount: submissions.length, output }, null, 2));
} catch {
  console.error('Rank proof export failed. Usage: node scripts/reaction-novajudge-rank-proof.mjs <NovaJudgeRoot> <contestId> <new-output.json>. Require existing local .env, installed pg, and a new output path. No NovaJudge data was changed.');
  process.exitCode = 1;
} finally { await client?.end(); }
