// Exercise the existing NovaJudge browser login/submission actions over HTTP.
// No CLI setting, contest, account password, or proctoring binding is changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({ options: {
  'nova-root': { type: 'string' },
  fixture: { type: 'string' },
  mode: { type: 'string', default: 'check' },
  runtime: { type: 'string', default: 'dev' },
  'report-dir': { type: 'string' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node scripts/reaction-novajudge-manual-submit.mjs --nova-root <checkout> --fixture <private.json> --mode check|AC|WA [--runtime dev|production] [--report-dir <directory>]');
  process.exit(0);
}

let client;
let feedController;
let feedTask;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (!values['nova-root'] || !values.fixture) throw new Error('--nova-root and --fixture are required.');
  const mode = values.mode.toUpperCase();
  if (!['CHECK', 'AC', 'WA'].includes(mode)) throw new Error('Expected mode check, AC, or WA.');
  if (!['dev', 'production'].includes(values.runtime)) throw new Error('Expected runtime dev or production.');
  const novaRoot = path.resolve(values['nova-root']);
  const fixturePath = path.resolve(values.fixture);
  const fixtureRoot = path.dirname(fixturePath);
  const reportRoot = path.resolve(values['report-dir'] || fixtureRoot);
  const handoff = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const contestId = Number(handoff.contestId);
  const problemId = Number(handoff.problemId);
  if (!Number.isSafeInteger(contestId) || contestId < 1 || !Number.isSafeInteger(problemId) || problemId < 1 ||
      !handoff.teamUsername || !handoff.teamPassword || !handoff.userId || !handoff.problemLetter) {
    throw new Error('Private fixture requires contestId, problemId, problemLetter, userId, teamUsername, and teamPassword.');
  }
  const baseUrl = new URL(handoff.novaBase);
  const local = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local(baseUrl) || !['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('This local acceptance helper requires a local NovaJudge HTTP origin.');
  }
  const base = baseUrl.origin;
  // Read the explicitly selected checkout's original configuration. Never inherit
  // a DATABASE_URL from a previous isolated test process.
  const env = parseEnv(await fs.readFile(path.join(novaRoot, '.env'), 'utf8'));
  const databaseUrl = new URL(env.DATABASE_URL);
  if (!local(databaseUrl) || !['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('The selected NovaJudge checkout must use a local PostgreSQL database.');
  }
  if (handoff.expectedDatabase && decodeURIComponent(databaseUrl.pathname.slice(1)) !== handoff.expectedDatabase) {
    throw new Error('Database does not match the private fixture.');
  }
  const novaRequire = createRequire(path.join(novaRoot, 'package.json'));
  const pg = novaRequire('pg');
  const { encodeReply } = novaRequire('next/dist/compiled/react-server-dom-turbopack/client.node');
  // Prisma timestamp-without-time-zone values are UTC; pg otherwise assumes the
  // Windows local timezone and would shift the contest window by eight hours.
  pg.types.setTypeParser(1114, value => new Date(value.replace(' ', 'T') + 'Z'));
  client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await fs.mkdir(reportRoot, { recursive: true });
  const query = async (sql, args = []) => (await client.query(sql, args)).rows;
  const contestPath = `/contest/${contestId}`;
  let cookie = '';

  async function actionId(exportedName) {
    const manifestPath = path.join(novaRoot, '.next', ...(values.runtime === 'dev' ? ['dev'] : []), 'server', 'server-reference-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const entry = Object.entries(manifest.node).find(([, value]) => value.exportedName === exportedName);
    if (!entry) throw new Error(`Compiled server action unavailable: ${exportedName}.`);
    return entry[0];
  }

  async function getPage(route) {
    const response = await fetch(base + route, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(60000) });
    await response.text();
    if (!response.ok) throw new Error(`Page HTTP ${response.status}.`);
  }

  async function action(route, name, args) {
    const body = await encodeReply(args);
    const headers = { Origin: base, 'Next-Action': await actionId(name), Accept: 'text/x-component', Cookie: cookie };
    if (typeof body === 'string') headers['Content-Type'] = 'text/plain;charset=UTF-8';
    const response = await fetch(base + route, {
      method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(60000),
    });
    for (const item of response.headers.getSetCookie()) {
      const pair = item.split(';')[0];
      if (pair.startsWith('user_token=')) cookie = pair;
    }
    await response.text();
    if (!response.ok && response.status !== 303) throw new Error(`${name} HTTP ${response.status}.`);
    return { status: response.status };
  }

  async function login() {
    await getPage(contestPath + '?autoLogin=miss');
    const form = new FormData();
    form.set('username', handoff.teamUsername);
    form.set('password', handoff.teamPassword);
    const result = await action(contestPath + '?autoLogin=miss', 'loginContestUser', [contestId, form]);
    if (!cookie.startsWith('user_token=')) throw new Error('Contest login did not issue user_token; no submission attempted.');
    await getPage(contestPath + '/submit');
    await actionId('submitCode');
    return { status: result.status, authenticated: true };
  }

  async function startFeed(events) {
    if (!handoff.ccsBasic?.username || !handoff.ccsBasic?.password) throw new Error('Private fixture requires valid ccsBasic credentials.');
    feedController = new AbortController();
    const response = await fetch(base + `/api/ccs/contests/${contestId}/event-feed`, {
      headers: { Authorization: 'Basic ' + Buffer.from(handoff.ccsBasic.username + ':' + handoff.ccsBasic.password).toString('base64') },
      signal: AbortSignal.any([feedController.signal, AbortSignal.timeout(180000)]),
    });
    if (!response.ok) throw new Error(`CCS feed HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { status: response.status, error: null };
    feedTask = (async () => {
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (!['submissions', 'judgements'].includes(event.type)) continue;
            const fields = event.type === 'submissions'
              ? ['id', 'team_id', 'problem_id', 'language_id', 'time', 'contest_time']
              : ['id', 'submission_id', 'judgement_type_id', 'start_time', 'end_time', 'start_contest_time', 'end_contest_time'];
            const data = Object.fromEntries(fields.filter(key => event.data?.[key] !== undefined).map(key => [key, event.data[key]]));
            events.push({ observedAt: new Date().toISOString(), id: event.id, type: event.type, op: event.op, data });
          }
        }
      } catch {
        if (!feedController.signal.aborted) state.error = 'CCS feed disconnected before verification completed.';
      }
    })();
    return state;
  }

  const [contest] = await query('select id,title,"startTime","endTime",type,status from contests where id=$1', [contestId]);
  const [team] = await query('select id,username,role,"proctoringKeyHash" IS NOT NULL as bound from users where "contestId"=$1 and username=$2', [contestId, handoff.teamUsername]);
  const [cli] = await query('select "activeContestId" from cli_settings where id=1');
  const [problem] = await query('select "problemId","displayId" from contest_problems where "contestId"=$1 and "problemId"=$2', [contestId, problemId]);
  if (!contest || !team || !problem || team.id !== handoff.userId || team.role !== 'TEAM' || team.bound || problem.displayId !== handoff.problemLetter) {
    throw new Error('Fixture scope or proctoring safety check failed.');
  }
  const loginResult = await login();
  const [teamAfterLogin] = await query('select "proctoringKeyHash" IS NOT NULL as bound from users where id=$1', [team.id]);
  if (teamAfterLogin.bound) throw new Error('Unexpected proctoring binding after browser login.');
  const preflight = {
    checkedAt: new Date().toISOString(), contestId, team: team.username,
    problem: problem.displayId, problemId, startTime: contest.startTime, endTime: contest.endTime,
    activeCliContestId: cli?.activeContestId ?? null,
    transport: 'authenticated browser Server Actions over HTTP', login: loginResult, proctoringBound: false,
  };
  await fs.writeFile(path.join(reportRoot, 'submit-preflight.json'), JSON.stringify(preflight, null, 2));
  if (mode === 'CHECK') {
    console.log(JSON.stringify({ ...preflight, submitted: false }, null, 2));
    return;
  }
  if (Date.now() < new Date(contest.startTime).getTime() || Date.now() > new Date(contest.endTime).getTime()) {
    throw new Error('Test contest is not within its configured time window.');
  }
  const sourcePath = path.resolve(fixtureRoot, handoff[mode.toLowerCase() + 'Source'] || mode.toLowerCase() + '.cpp');
  const runId = randomUUID();
  const code = (await fs.readFile(sourcePath, 'utf8')) + '\n// Reaction manual integration ' + runId + '\n';
  const events = [];
  const feed = await startFeed(events);
  await delay(1500);
  const requestedAt = new Date().toISOString();
  const actionResult = await action(contestPath + '/submit', 'submitCode', [contestId, problem.displayId, handoff.language || 'cpp', code]);
  let sub;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    [sub] = await query('select id,"displayId",verdict,"submittedAt","passedTests","totalTests","timeUsed","memoryUsed" from submissions where "contestId"=$1 and "userId"=$2 and "problemId"=$3 and code=$4 order by "submittedAt" desc limit 1', [contestId, team.id, problemId, code]);
    if (sub && !['PENDING', 'JUDGING'].includes(sub.verdict)) break;
    await delay(500);
  }
  if (!sub) throw new Error('Browser action produced no matching submission; no retry was attempted.');
  const judgedObservedAt = new Date().toISOString();
  const feedDeadline = Date.now() + 10000;
  while (Date.now() < feedDeadline && !events.some(event => event.type === 'judgements' && event.data?.submission_id === sub.id && event.data?.judgement_type_id)) {
    await delay(250);
  }
  feedController.abort();
  await feedTask;
  const relevant = events.filter(event => event.type === 'submissions' ? event.data?.id === sub.id : event.data?.submission_id === sub.id);
  const [finalTeam] = await query('select "proctoringKeyHash" IS NOT NULL as bound from users where id=$1', [team.id]);
  const [finalCli] = await query('select "activeContestId" from cli_settings where id=1');
  const expected = mode === 'AC' ? 'ACCEPTED' : 'WRONG_ANSWER';
  const ccsSubmissionObserved = relevant.some(event => event.type === 'submissions' && event.data?.team_id === team.username && event.data?.problem_id === String(problemId));
  const ccsJudgementObserved = relevant.some(event => event.type === 'judgements' && event.data?.judgement_type_id === mode);
  const cliSettingUnchanged = (finalCli?.activeContestId ?? null) === (cli?.activeContestId ?? null);
  const report = {
    ...preflight, runId, requestedAt, judgedObservedAt, expectedVerdict: expected, submission: sub,
    submitHttpStatus: actionResult.status, ccsHttpStatus: feed.status, ccsEvents: relevant,
    ccsSubmissionObserved, ccsJudgementObserved, ccsError: feed.error,
    proctoringBound: finalTeam.bound, cliSettingUnchanged,
    result: sub.verdict === expected && !finalTeam.bound && cliSettingUnchanged && ccsSubmissionObserved && ccsJudgementObserved && !feed.error ? 'PASS' : 'FAIL',
  };
  const reportPath = path.join(reportRoot, 'submission-' + sub.id + '.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await fs.appendFile(path.join(reportRoot, 'submissions.ndjson'), JSON.stringify(report) + '\n');
  console.log(JSON.stringify({
    result: report.result, contestId, team: team.username, problem: problem.displayId,
    submissionId: sub.id, displayId: sub.displayId, verdict: sub.verdict,
    passedTests: sub.passedTests, totalTests: sub.totalTests, ccsEventCount: relevant.length,
    proctoringBound: report.proctoringBound, cliSettingUnchanged, reportPath,
  }, null, 2));
  if (report.result !== 'PASS') process.exitCode = 1;
}

main().catch(error => {
  // Avoid printing configuration parser errors that could embed a secret URL.
  const safe = /^(--|Expected |Private fixture |This local |The selected |Database does |Compiled |Page HTTP |loginContestUser HTTP |submitCode HTTP |Contest login |CCS feed HTTP |Fixture scope |Unexpected proctoring |Test contest |Browser action )/.test(error.message);
  console.error('Reaction submission check failed: ' + (safe ? error.message : 'Check the selected checkout, private fixture, dependencies, and running services.'));
  process.exitCode = 1;
}).finally(async () => {
  feedController?.abort();
  await feedTask;
  await client?.end();
});
